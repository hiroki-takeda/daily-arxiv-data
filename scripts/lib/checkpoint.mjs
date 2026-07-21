import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fingerprintSnapshot } from "./arxiv-source.mjs";

export const CHECKPOINT_SCHEMA_VERSION = "1.0";
export const CHECKPOINT_CATEGORIES = Object.freeze(["quant-ph", "gr-qc", "hep-th"]);

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const EVENT_ID_PATTERN = /^[a-f0-9]{32}$/u;
const BLOB_PATTERN = /^([a-f0-9]{64})-([a-f0-9]{32})\.blob$/u;
const EVENT_FILE_PATTERN = /^\d{8}T\d{6}\.\d{3}Z-([a-f0-9]{32})\.json$/u;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_REPORT_BYTES = 10 * 1024 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;
const DIRECTORY_MODE = 0o700;
const IMMUTABLE_FILE_MODE = 0o400;
const MATERIALIZED_FILE_MODE = 0o600;

function fail(message) {
  throw new Error(message);
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function validateDate(value) {
  const match = typeof value === "string" ? DATE_PATTERN.exec(value) : null;
  if (!match) fail("Checkpoint reportDate must use YYYY-MM-DD.");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    Number.isNaN(parsed.getTime())
    || parsed.getUTCFullYear() !== Number(match[1])
    || parsed.getUTCMonth() + 1 !== Number(match[2])
    || parsed.getUTCDate() !== Number(match[3])
  ) fail("Checkpoint reportDate must be a real calendar date.");
  return value;
}

function validateSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) fail(`${label} must be a lowercase SHA-256 digest.`);
  return value;
}

function validateSafeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID_PATTERN.test(value)) fail(`${label} is invalid.`);
  return value;
}

function validateEventId(value) {
  if (typeof value !== "string" || !EVENT_ID_PATTERN.test(value)) fail("Checkpoint eventId must be 32 lowercase hexadecimal characters.");
  return value;
}

function validateCategory(value) {
  if (!CHECKPOINT_CATEGORIES.includes(value)) fail(`Unsupported checkpoint category: ${value}`);
  return value;
}

function isoTimestamp(value, label = "Checkpoint timestamp") {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) fail(`${label} is invalid.`);
  return date.toISOString();
}

function exactKeys(object, expected, label) {
  if (!object || typeof object !== "object" || Array.isArray(object)) fail(`${label} must be a JSON object.`);
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (actual.join("\0") !== wanted.join("\0")) fail(`${label} must contain exactly: ${wanted.join(", ")}.`);
}

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("Checkpoint JSON cannot contain a non-finite number.");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => {
      if (value[key] === undefined) fail("Checkpoint JSON cannot contain undefined values.");
      return [key, canonicalize(value[key])];
    }));
  }
  fail("Checkpoint JSON must contain only plain JSON values.");
}

function serializeJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function assertOwned(metadata, label) {
  const uid = currentUid();
  if (uid !== null && metadata.uid !== uid) fail(`${label} is owned by another user.`);
}

function assertSecureDirectory(path, label) {
  if (!existsSync(path)) fail(`${label} does not exist: ${path}`);
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail(`${label} must be a real directory, not a symlink: ${path}`);
  assertOwned(metadata, label);
  if ((metadata.mode & 0o777) !== DIRECTORY_MODE) fail(`${label} must have mode 0700: ${path}`);
  if (realpathSync(path) !== resolve(path)) fail(`${label} must not traverse a symlink: ${path}`);
  return metadata;
}

function ensureSecureDirectory(path, label, { recursive = false } = {}) {
  if (!existsSync(path)) mkdirSync(path, { mode: DIRECTORY_MODE, recursive });
  return assertSecureDirectory(path, label);
}

function assertSecureFile(path, label, { maxBytes, immutable = true } = {}) {
  if (!existsSync(path)) fail(`${label} does not exist: ${path}`);
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) fail(`${label} must be a real regular file, not a symlink: ${path}`);
  assertOwned(metadata, label);
  const expectedMode = immutable ? IMMUTABLE_FILE_MODE : MATERIALIZED_FILE_MODE;
  if ((metadata.mode & 0o777) !== expectedMode) fail(`${label} must have mode 0${expectedMode.toString(8)}: ${path}`);
  if (Number.isFinite(maxBytes) && metadata.size > maxBytes) fail(`${label} is unexpectedly large: ${path}`);
  if (realpathSync(path) !== resolve(path)) fail(`${label} must not traverse a symlink: ${path}`);
  return metadata;
}

function readStableSecureFile(path, label, { maxBytes, immutable = true } = {}) {
  assertSecureFile(path, label, { maxBytes, immutable });
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(descriptor);
    if (!before.isFile()) fail(`${label} changed before it could be read.`);
    assertOwned(before, label);
    const expectedMode = immutable ? IMMUTABLE_FILE_MODE : MATERIALIZED_FILE_MODE;
    if ((before.mode & 0o777) !== expectedMode) fail(`${label} permissions changed before it could be read.`);
    if (Number.isFinite(maxBytes) && before.size > maxBytes) fail(`${label} is unexpectedly large.`);
    const content = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || content.length !== after.size
    ) fail(`${label} changed while it was being read.`);
    return content;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseJsonBuffer(content, label) {
  try {
    return JSON.parse(content.toString("utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function assertExactDirectoryEntries(path, expected, label) {
  const actual = readdirSync(path).sort();
  const wanted = [...expected].sort();
  if (actual.join("\0") !== wanted.join("\0")) fail(`${label} contains unexpected or missing entries.`);
}

function ensureControlRoot(controlRoot) {
  if (typeof controlRoot !== "string" || !isAbsolute(controlRoot) || resolve(controlRoot) !== controlRoot) {
    fail("Checkpoint controlRoot must be an absolute normalized path.");
  }
  ensureSecureDirectory(controlRoot, "Checkpoint control root", { recursive: true });
  const jobs = join(controlRoot, "jobs");
  ensureSecureDirectory(jobs, "Checkpoint jobs directory");
  return jobs;
}

export function checkpointJobFamilyPath({ controlRoot, reportDate, snapshotFingerprint }) {
  if (typeof controlRoot !== "string" || !isAbsolute(controlRoot) || resolve(controlRoot) !== controlRoot) {
    fail("Checkpoint controlRoot must be an absolute normalized path.");
  }
  validateDate(reportDate);
  validateSha256(snapshotFingerprint, "Snapshot fingerprint");
  return join(controlRoot, "jobs", `${reportDate}-${snapshotFingerprint}`);
}

export function checkpointJobPath({ controlRoot, reportDate, snapshotFingerprint, runtimeFingerprint }) {
  validateSha256(runtimeFingerprint, "Runtime fingerprint");
  return join(
    checkpointJobFamilyPath({ controlRoot, reportDate, snapshotFingerprint }),
    runtimeFingerprint,
  );
}

function jobPaths(jobPath) {
  return Object.freeze({
    root: jobPath,
    writes: join(jobPath, ".writes"),
    snapshot: join(jobPath, "snapshot.json"),
    manifest: join(jobPath, "job.json"),
    reports: join(jobPath, "reports"),
    attempts: join(jobPath, "attempts"),
    publication: join(jobPath, "publication"),
  });
}

function prepareNewJobDirectories(path) {
  if (!existsSync(path)) mkdirSync(path, { mode: DIRECTORY_MODE });
  assertSecureDirectory(path, "Checkpoint job directory");
  const paths = jobPaths(path);
  for (const [key, child] of Object.entries(paths)) {
    if (key === "root" || key === "snapshot" || key === "manifest") continue;
    ensureSecureDirectory(child, `Checkpoint ${key} directory`);
  }
  return paths;
}

function writeAtomicExclusive(paths, destination, content) {
  if (!Buffer.isBuffer(content)) content = Buffer.from(content, "utf8");
  if (dirname(destination) !== paths.root && !Object.values(paths).includes(dirname(destination))) {
    fail("Checkpoint destination is outside the fixed job layout.");
  }
  if (existsSync(destination)) fail(`Refusing to overwrite existing checkpoint artifact: ${destination}`);
  const digest = sha256(content);
  const nonce = randomBytes(16).toString("hex");
  const blob = join(paths.writes, `${digest}-${nonce}.blob`);
  let descriptor;
  try {
    descriptor = openSync(blob, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, IMMUTABLE_FILE_MODE);
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  assertSecureFile(blob, "Checkpoint write blob", { maxBytes: Math.max(content.length, MAX_RECORD_BYTES) });
  try {
    linkSync(blob, destination);
  } catch (error) {
    error.message = `Could not exclusively publish checkpoint artifact ${destination}: ${error.message}`;
    throw error;
  }
  assertSecureFile(destination, "Checkpoint artifact", { maxBytes: Math.max(content.length, MAX_RECORD_BYTES) });
  return Object.freeze({ path: destination, sha256: digest, bytes: content.length });
}

function inspectWriteBlobs(paths) {
  assertSecureDirectory(paths.writes, "Checkpoint writes directory");
  const blobsByInode = new Map();
  for (const name of readdirSync(paths.writes)) {
    const match = BLOB_PATTERN.exec(name);
    if (!match) fail(`Unexpected checkpoint write blob: ${name}`);
    const path = join(paths.writes, name);
    const content = readStableSecureFile(path, `Checkpoint write blob ${name}`, {
      maxBytes: MAX_REPORT_BYTES,
    });
    if (sha256(content) !== match[1]) fail(`Checkpoint write blob digest does not match its filename: ${name}`);
    const metadata = lstatSync(path);
    blobsByInode.set(`${metadata.dev}:${metadata.ino}`, match[1]);
  }
  return blobsByInode;
}

function readCheckpointArtifact(path, label, { maxBytes, blobsByInode }) {
  const content = readStableSecureFile(path, label, { maxBytes });
  const metadata = lstatSync(path);
  const blobDigest = blobsByInode.get(`${metadata.dev}:${metadata.ino}`);
  if (blobDigest !== sha256(content)) fail(`${label} is not backed by its immutable content-addressed write blob.`);
  return content;
}

function validateManifest(manifest, expected) {
  exactKeys(manifest, [
    "schemaVersion",
    "reportDate",
    "snapshotFingerprint",
    "snapshotSha256",
    "runtimeFingerprint",
    "evaluationRunId",
    "createdAt",
  ], "Checkpoint job manifest");
  if (manifest.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) fail(`Checkpoint schemaVersion must be ${CHECKPOINT_SCHEMA_VERSION}.`);
  validateDate(manifest.reportDate);
  validateSha256(manifest.snapshotFingerprint, "Checkpoint manifest snapshotFingerprint");
  validateSha256(manifest.snapshotSha256, "Checkpoint manifest snapshotSha256");
  validateSha256(manifest.runtimeFingerprint, "Checkpoint manifest runtimeFingerprint");
  validateSafeId(manifest.evaluationRunId, "Checkpoint manifest evaluationRunId");
  isoTimestamp(manifest.createdAt, "Checkpoint manifest createdAt");
  if (manifest.reportDate !== expected.reportDate) fail("Checkpoint manifest reportDate does not match its job path.");
  if (manifest.snapshotFingerprint !== expected.snapshotFingerprint) fail("Checkpoint manifest snapshotFingerprint does not match its job path.");
  if (manifest.runtimeFingerprint !== expected.runtimeFingerprint) fail("Checkpoint runtime fingerprint changed; this job cannot resume under different runtime code.");
  if (expected.evaluationRunId && manifest.evaluationRunId !== expected.evaluationRunId) {
    fail("Checkpoint evaluationRunId changed; the persisted evaluation run must be reused.");
  }
  return manifest;
}

function validateReportAssociation(report, manifest, category, label) {
  if (!report || typeof report !== "object" || Array.isArray(report)) fail(`${label} must be a JSON object.`);
  if (report.reportDate !== manifest.reportDate) fail(`${label}.reportDate does not match the checkpoint job.`);
  if (report.slug !== category) fail(`${label}.slug must be ${category}.`);
  if (report.evaluationRun?.runId !== manifest.evaluationRunId) fail(`${label}.evaluationRun.runId does not match the checkpoint job.`);
}

function validateReportReceipt(receipt, manifest, category, label) {
  exactKeys(receipt, [
    "schemaVersion",
    "reportDate",
    "snapshotFingerprint",
    "runtimeFingerprint",
    "evaluationRunId",
    "category",
    "fileName",
    "sha256",
    "bytes",
    "importedAt",
    "attemptId",
  ], label);
  if (receipt.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) fail(`${label}.schemaVersion is invalid.`);
  if (receipt.reportDate !== manifest.reportDate) fail(`${label}.reportDate does not match the job.`);
  if (receipt.snapshotFingerprint !== manifest.snapshotFingerprint) fail(`${label}.snapshotFingerprint does not match the job.`);
  if (receipt.runtimeFingerprint !== manifest.runtimeFingerprint) fail(`${label}.runtimeFingerprint does not match the job.`);
  if (receipt.evaluationRunId !== manifest.evaluationRunId) fail(`${label}.evaluationRunId does not match the job.`);
  if (receipt.category !== category) fail(`${label}.category must be ${category}.`);
  if (receipt.fileName !== `${manifest.reportDate}-${category}.json`) fail(`${label}.fileName is invalid.`);
  validateSha256(receipt.sha256, `${label}.sha256`);
  if (!Number.isSafeInteger(receipt.bytes) || receipt.bytes < 2 || receipt.bytes > MAX_REPORT_BYTES) fail(`${label}.bytes is invalid.`);
  isoTimestamp(receipt.importedAt, `${label}.importedAt`);
  validateSafeId(receipt.attemptId, `${label}.attemptId`);
  return receipt;
}

function loadReports(paths, manifest, blobsByInode) {
  assertSecureDirectory(paths.reports, "Checkpoint reports directory");
  const allowed = new Set(CHECKPOINT_CATEGORIES.flatMap((category) => [`${category}.json`, `${category}.receipt.json`]));
  for (const entry of readdirSync(paths.reports)) {
    if (!allowed.has(entry)) fail(`Unexpected checkpoint report artifact: ${entry}`);
  }
  const reports = {};
  const incompleteReports = [];
  for (const category of CHECKPOINT_CATEGORIES) {
    const reportPath = join(paths.reports, `${category}.json`);
    const receiptPath = join(paths.reports, `${category}.receipt.json`);
    if (!existsSync(reportPath) && !existsSync(receiptPath)) continue;
    if (!existsSync(reportPath)) fail(`Checkpoint receipt exists without its report: ${category}`);
    const reportContent = readCheckpointArtifact(reportPath, `Checkpoint report ${category}`, {
      maxBytes: MAX_REPORT_BYTES,
      blobsByInode,
    });
    const report = parseJsonBuffer(reportContent, `Checkpoint report ${category}`);
    validateReportAssociation(report, manifest, category, `Checkpoint report ${category}`);
    if (!existsSync(receiptPath)) {
      incompleteReports.push(category);
      continue;
    }
    const receiptContent = readCheckpointArtifact(receiptPath, `Checkpoint report receipt ${category}`, {
      maxBytes: MAX_RECORD_BYTES,
      blobsByInode,
    });
    const receipt = validateReportReceipt(
      parseJsonBuffer(receiptContent, `Checkpoint report receipt ${category}`),
      manifest,
      category,
      `Checkpoint report receipt ${category}`,
    );
    const digest = sha256(reportContent);
    if (digest !== receipt.sha256 || reportContent.length !== receipt.bytes) fail(`Checkpoint report digest or byte count changed: ${category}`);
    reports[category] = Object.freeze({
      category,
      path: reportPath,
      receiptPath,
      sha256: digest,
      bytes: reportContent.length,
      report,
      receipt,
    });
  }
  return Object.freeze({ reports: Object.freeze(reports), incompleteReports: Object.freeze(incompleteReports) });
}

function validateEventAssociation(event, manifest, kind, label) {
  const shared = [
    "schemaVersion", "kind", "eventId", "attemptId", "reportDate", "snapshotFingerprint",
    "runtimeFingerprint", "evaluationRunId", "at", "status", "message",
  ];
  exactKeys(event, kind === "attempt" ? [...shared, "stage", "category"] : [...shared, "commit"], label);
  if (event.schemaVersion !== CHECKPOINT_SCHEMA_VERSION || event.kind !== kind) fail(`${label} has an invalid schema or kind.`);
  validateEventId(event.eventId);
  validateSafeId(event.attemptId, `${label}.attemptId`);
  if (event.reportDate !== manifest.reportDate) fail(`${label}.reportDate does not match the job.`);
  if (event.snapshotFingerprint !== manifest.snapshotFingerprint) fail(`${label}.snapshotFingerprint does not match the job.`);
  if (event.runtimeFingerprint !== manifest.runtimeFingerprint) fail(`${label}.runtimeFingerprint does not match the job.`);
  if (event.evaluationRunId !== manifest.evaluationRunId) fail(`${label}.evaluationRunId does not match the job.`);
  isoTimestamp(event.at, `${label}.at`);
  if (typeof event.message !== "string" || event.message.length > 2_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(event.message)) {
    fail(`${label}.message is invalid.`);
  }
  if (kind === "attempt") {
    validateSafeId(event.stage, `${label}.stage`);
    if (event.category !== null) validateCategory(event.category);
    if (!["started", "resumed", "completed", "failed", "deferred"].includes(event.status)) fail(`${label}.status is invalid.`);
  } else {
    if (!["pending", "publishing", "published", "failed", "deferred"].includes(event.status)) fail(`${label}.status is invalid.`);
    if (event.status === "published") {
      if (typeof event.commit !== "string" || !/^[a-f0-9]{40,64}$/u.test(event.commit)) fail(`${label}.commit is required for published status.`);
    } else if (event.commit !== null) fail(`${label}.commit must be null unless status is published.`);
  }
  return event;
}

function loadEvents(directory, manifest, kind, blobsByInode) {
  assertSecureDirectory(directory, `Checkpoint ${kind} events directory`);
  const events = [];
  for (const name of readdirSync(directory).sort()) {
    const match = EVENT_FILE_PATTERN.exec(name);
    if (!match) fail(`Unexpected checkpoint ${kind} event file: ${name}`);
    const content = readCheckpointArtifact(join(directory, name), `Checkpoint ${kind} event ${name}`, {
      maxBytes: MAX_RECORD_BYTES,
      blobsByInode,
    });
    const event = validateEventAssociation(parseJsonBuffer(content, `Checkpoint ${kind} event ${name}`), manifest, kind, `Checkpoint ${kind} event ${name}`);
    if (event.eventId !== match[1]) fail(`Checkpoint ${kind} eventId does not match its filename: ${name}`);
    const expectedPrefix = event.at.replace(/[-:]/gu, "");
    if (!name.startsWith(`${expectedPrefix}-`)) fail(`Checkpoint ${kind} timestamp does not match its filename: ${name}`);
    events.push(Object.freeze(event));
  }
  events.sort((left, right) => left.at.localeCompare(right.at) || left.eventId.localeCompare(right.eventId));
  return Object.freeze(events);
}

export function loadCheckpointJob({
  controlRoot,
  reportDate,
  snapshotFingerprint,
  runtimeFingerprint,
  evaluationRunId,
}) {
  const jobs = ensureControlRoot(controlRoot);
  validateDate(reportDate);
  validateSha256(snapshotFingerprint, "Snapshot fingerprint");
  validateSha256(runtimeFingerprint, "Runtime fingerprint");
  if (evaluationRunId !== undefined) validateSafeId(evaluationRunId, "Expected evaluationRunId");
  const family = checkpointJobFamilyPath({ controlRoot, reportDate, snapshotFingerprint });
  assertSecureDirectory(family, "Checkpoint date-snapshot directory");
  const root = checkpointJobPath({ controlRoot, reportDate, snapshotFingerprint, runtimeFingerprint });
  assertSecureDirectory(jobs, "Checkpoint jobs directory");
  const paths = jobPaths(root);
  assertSecureDirectory(paths.root, "Checkpoint job directory");
  assertExactDirectoryEntries(paths.root, [".writes", "attempts", "job.json", "publication", "reports", "snapshot.json"], "Checkpoint job directory");
  for (const [key, path] of Object.entries(paths)) {
    if (["root", "manifest", "snapshot"].includes(key)) continue;
    assertSecureDirectory(path, `Checkpoint ${key} directory`);
  }
  const blobsByInode = inspectWriteBlobs(paths);
  const manifestContent = readCheckpointArtifact(paths.manifest, "Checkpoint job manifest", {
    maxBytes: MAX_RECORD_BYTES,
    blobsByInode,
  });
  const manifest = validateManifest(parseJsonBuffer(manifestContent, "Checkpoint job manifest"), {
    reportDate,
    snapshotFingerprint,
    runtimeFingerprint,
    evaluationRunId,
  });
  const snapshotContent = readCheckpointArtifact(paths.snapshot, "Checkpoint snapshot", {
    maxBytes: MAX_SNAPSHOT_BYTES,
    blobsByInode,
  });
  if (sha256(snapshotContent) !== manifest.snapshotSha256) fail("Checkpoint snapshot digest changed.");
  const snapshot = parseJsonBuffer(snapshotContent, "Checkpoint snapshot");
  if (snapshot.announcementDate !== reportDate || fingerprintSnapshot(snapshot) !== snapshotFingerprint) {
    fail("Checkpoint snapshot no longer matches its report date or semantic fingerprint.");
  }
  const loadedReports = loadReports(paths, manifest, blobsByInode);
  const attempts = loadEvents(paths.attempts, manifest, "attempt", blobsByInode);
  const publicationEvents = loadEvents(paths.publication, manifest, "publication", blobsByInode);
  const publishedEvents = publicationEvents.filter((event) => event.status === "published");
  if (publishedEvents.length > 1 && new Set(publishedEvents.map((event) => event.commit)).size !== 1) {
    fail("Checkpoint contains conflicting published commits.");
  }
  return Object.freeze({
    controlRoot,
    familyPath: family,
    path: root,
    paths,
    manifest: Object.freeze(manifest),
    snapshot: Object.freeze(snapshot),
    evaluationRunId: manifest.evaluationRunId,
    reports: loadedReports.reports,
    incompleteReports: loadedReports.incompleteReports,
    completeCategories: Object.freeze(CHECKPOINT_CATEGORIES.filter((category) => category in loadedReports.reports)),
    isComplete: CHECKPOINT_CATEGORIES.every((category) => category in loadedReports.reports),
    attempts,
    publicationEvents,
    publicationStatus: publicationEvents.at(-1)?.status ?? null,
    publishedCommit: publishedEvents.at(-1)?.commit ?? null,
  });
}

export function openCheckpointJob({
  controlRoot,
  snapshot,
  snapshotFingerprint,
  runtimeFingerprint,
  evaluationRunId,
  now = new Date(),
}) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) fail("Checkpoint snapshot is required.");
  const reportDate = validateDate(snapshot.announcementDate);
  validateSha256(snapshotFingerprint, "Snapshot fingerprint");
  validateSha256(runtimeFingerprint, "Runtime fingerprint");
  const actualFingerprint = fingerprintSnapshot(snapshot);
  if (actualFingerprint !== snapshotFingerprint) fail("Supplied snapshot fingerprint does not match the official snapshot.");
  const jobs = ensureControlRoot(controlRoot);
  const family = checkpointJobFamilyPath({ controlRoot, reportDate, snapshotFingerprint });
  ensureSecureDirectory(family, "Checkpoint date-snapshot directory");
  const root = checkpointJobPath({ controlRoot, reportDate, snapshotFingerprint, runtimeFingerprint });
  const existed = existsSync(root);
  if (!existed && evaluationRunId === undefined) fail("A new checkpoint job requires evaluationRunId.");
  if (evaluationRunId !== undefined) validateSafeId(evaluationRunId, "Checkpoint evaluationRunId");
  const paths = prepareNewJobDirectories(root);
  const snapshotContent = Buffer.from(serializeJson(snapshot), "utf8");
  if (snapshotContent.length > MAX_SNAPSHOT_BYTES) fail("Checkpoint snapshot is unexpectedly large.");
  const snapshotDigest = sha256(snapshotContent);
  if (!existsSync(paths.snapshot)) writeAtomicExclusive(paths, paths.snapshot, snapshotContent);
  else {
    const stored = readStableSecureFile(paths.snapshot, "Checkpoint snapshot", { maxBytes: MAX_SNAPSHOT_BYTES });
    if (sha256(stored) !== snapshotDigest) fail("Refusing to replace a different immutable checkpoint snapshot.");
  }
  if (!existsSync(paths.manifest)) {
    if (evaluationRunId === undefined) fail("Incomplete new checkpoint job requires its original evaluationRunId.");
    const manifest = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      reportDate,
      snapshotFingerprint,
      snapshotSha256: snapshotDigest,
      runtimeFingerprint,
      evaluationRunId,
      createdAt: isoTimestamp(now),
    };
    writeAtomicExclusive(paths, paths.manifest, serializeJson(manifest));
  }
  assertSecureDirectory(jobs, "Checkpoint jobs directory");
  // evaluationRunId is a creation/recovery candidate. Once job.json exists,
  // its durable ID is authoritative and is reused even when a later scheduler
  // attempt supplies its own fresh run ID.
  return loadCheckpointJob({ controlRoot, reportDate, snapshotFingerprint, runtimeFingerprint });
}

function reloadJob(job) {
  if (!job || typeof job !== "object") fail("A loaded checkpoint job is required.");
  return loadCheckpointJob({
    controlRoot: job.controlRoot,
    reportDate: job.manifest?.reportDate,
    snapshotFingerprint: job.manifest?.snapshotFingerprint,
    runtimeFingerprint: job.manifest?.runtimeFingerprint,
    evaluationRunId: job.evaluationRunId,
  });
}

function validateCheckpointReportCandidate({ current, category, content, validateReport, label }) {
  if (typeof validateReport !== "function") fail("Checkpoint report import requires a validation callback.");
  const report = parseJsonBuffer(content, label);
  validateReportAssociation(report, current.manifest, category, label);
  const validationResult = validateReport(report, {
    category,
    reportDate: current.manifest.reportDate,
    evaluationRunId: current.evaluationRunId,
    snapshot: current.snapshot,
  });
  if (validationResult === false) fail(`${label} failed validation.`);
  return report;
}

function writeMissingReportReceipt({ current, category, content, attemptId, now }) {
  validateSafeId(attemptId, "Checkpoint report attemptId");
  const digest = sha256(content);
  const receiptPath = join(current.paths.reports, `${category}.receipt.json`);
  const receipt = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    reportDate: current.manifest.reportDate,
    snapshotFingerprint: current.manifest.snapshotFingerprint,
    runtimeFingerprint: current.manifest.runtimeFingerprint,
    evaluationRunId: current.evaluationRunId,
    category,
    fileName: `${current.manifest.reportDate}-${category}.json`,
    sha256: digest,
    bytes: content.length,
    importedAt: isoTimestamp(now),
    attemptId,
  };
  if (existsSync(receiptPath)) {
    const existing = parseJsonBuffer(
      readStableSecureFile(receiptPath, `Existing checkpoint report receipt ${category}`, { maxBytes: MAX_RECORD_BYTES }),
      `Existing checkpoint report receipt ${category}`,
    );
    validateReportReceipt(existing, current.manifest, category, `Existing checkpoint report receipt ${category}`);
    if (existing.sha256 !== digest || existing.bytes !== content.length) fail(`Checkpoint report receipt conflicts for ${category}.`);
    return existing;
  }
  writeAtomicExclusive(current.paths, receiptPath, serializeJson(receipt));
  return receipt;
}

export function importCheckpointCategoryReport({
  job,
  category,
  sourcePath,
  validateReport,
  attemptId,
  now = new Date(),
}) {
  const current = reloadJob(job);
  validateCategory(category);
  validateSafeId(attemptId, "Checkpoint report attemptId");
  if (typeof sourcePath !== "string" || !isAbsolute(sourcePath) || resolve(sourcePath) !== sourcePath) {
    fail("Checkpoint report sourcePath must be an absolute normalized path.");
  }
  const content = readStableSecureFile(sourcePath, `Checkpoint source report ${category}`, {
    maxBytes: MAX_REPORT_BYTES,
    immutable: false,
  });
  validateCheckpointReportCandidate({
    current,
    category,
    content,
    validateReport,
    label: `Checkpoint source report ${category}`,
  });
  const digest = sha256(content);
  const reportPath = join(current.paths.reports, `${category}.json`);
  if (existsSync(reportPath)) {
    const existing = readStableSecureFile(reportPath, `Existing checkpoint report ${category}`, { maxBytes: MAX_REPORT_BYTES });
    if (sha256(existing) !== digest || !existing.equals(content)) fail(`Refusing to replace a different checkpoint report for ${category}.`);
  } else {
    writeAtomicExclusive(current.paths, reportPath, content);
  }
  writeMissingReportReceipt({ current, category, content, attemptId, now });
  return reloadJob(current).reports[category];
}

export function recoverIncompleteCheckpointReports({
  job,
  validateReport,
  attemptId,
  now = new Date(),
}) {
  let current = reloadJob(job);
  validateSafeId(attemptId, "Checkpoint recovery attemptId");
  if (typeof validateReport !== "function") fail("Checkpoint report recovery requires a validation callback.");
  for (const category of current.incompleteReports) {
    const reportPath = join(current.paths.reports, `${category}.json`);
    const content = readStableSecureFile(reportPath, `Incomplete checkpoint report ${category}`, {
      maxBytes: MAX_REPORT_BYTES,
    });
    validateCheckpointReportCandidate({
      current,
      category,
      content,
      validateReport,
      label: `Incomplete checkpoint report ${category}`,
    });
    writeMissingReportReceipt({ current, category, content, attemptId, now });
    current = reloadJob(current);
  }
  return current;
}

function eventFileName(at, eventId) {
  return `${at.replace(/[-:]/gu, "")}-${eventId}.json`;
}

function commonEvent(job, { kind, eventId, attemptId, status, message, at }) {
  const current = reloadJob(job);
  validateEventId(eventId);
  validateSafeId(attemptId, "Checkpoint event attemptId");
  return {
    current,
    event: {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      kind,
      eventId,
      attemptId,
      reportDate: current.manifest.reportDate,
      snapshotFingerprint: current.manifest.snapshotFingerprint,
      runtimeFingerprint: current.manifest.runtimeFingerprint,
      evaluationRunId: current.evaluationRunId,
      at: isoTimestamp(at),
      status,
      message,
    },
  };
}

export function appendCheckpointAttempt({
  job,
  attemptId,
  stage,
  status,
  category = null,
  message = "",
  at = new Date(),
  eventId = randomBytes(16).toString("hex"),
}) {
  validateSafeId(stage, "Checkpoint attempt stage");
  if (category !== null) validateCategory(category);
  const { current, event } = commonEvent(job, { kind: "attempt", eventId, attemptId, status, message, at });
  event.stage = stage;
  event.category = category;
  validateEventAssociation(event, current.manifest, "attempt", "Checkpoint attempt event");
  const destination = join(current.paths.attempts, eventFileName(event.at, eventId));
  writeAtomicExclusive(current.paths, destination, serializeJson(event));
  return Object.freeze(event);
}

export function appendPublicationStatus({
  job,
  attemptId,
  status,
  commit = null,
  message = "",
  at = new Date(),
  eventId = randomBytes(16).toString("hex"),
}) {
  const { current, event } = commonEvent(job, { kind: "publication", eventId, attemptId, status, message, at });
  if (current.publishedCommit !== null) fail(`Checkpoint was already published at ${current.publishedCommit}.`);
  event.commit = commit;
  validateEventAssociation(event, current.manifest, "publication", "Checkpoint publication event");
  const destination = join(current.paths.publication, eventFileName(event.at, eventId));
  writeAtomicExclusive(current.paths, destination, serializeJson(event));
  return Object.freeze(event);
}

export function materializeCheckpointReports({
  job,
  destination,
  categories = CHECKPOINT_CATEGORIES,
}) {
  const current = reloadJob(job);
  if (!Array.isArray(categories) || categories.length !== CHECKPOINT_CATEGORIES.length
    || [...categories].sort().join("\0") !== [...CHECKPOINT_CATEGORIES].sort().join("\0")) {
    fail(`Checkpoint materialization requires exactly: ${CHECKPOINT_CATEGORIES.join(", ")}.`);
  }
  if (!current.isComplete) fail(`Checkpoint reports are incomplete; complete categories: ${current.completeCategories.join(", ") || "none"}.`);
  if (typeof destination !== "string" || !isAbsolute(destination) || resolve(destination) !== destination) {
    fail("Checkpoint materialization destination must be an absolute normalized path.");
  }
  assertSecureDirectory(destination, "Checkpoint materialization destination");
  if (readdirSync(destination).length !== 0) fail("Checkpoint materialization destination must start empty.");
  const prepared = [];
  for (const category of categories) {
    const entry = current.reports[category];
    const content = readStableSecureFile(entry.path, `Checkpoint report ${category}`, { maxBytes: MAX_REPORT_BYTES });
    if (sha256(content) !== entry.sha256 || content.length !== entry.bytes) fail(`Checkpoint report changed before materialization: ${category}`);
    prepared.push({ category, entry, content });
  }
  const result = {};
  for (const { category, entry, content } of prepared) {
    const path = join(destination, `${current.manifest.reportDate}-${category}.json`);
    let descriptor;
    try {
      descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, MATERIALIZED_FILE_MODE);
      writeFileSync(descriptor, content);
      fsyncSync(descriptor);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    assertSecureFile(path, `Materialized checkpoint report ${category}`, { maxBytes: MAX_REPORT_BYTES, immutable: false });
    result[category] = Object.freeze({ path, sha256: entry.sha256, bytes: entry.bytes, report: entry.report });
  }
  return Object.freeze(result);
}
