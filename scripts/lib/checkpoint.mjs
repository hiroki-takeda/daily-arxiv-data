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
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import {
  ARXIV_PASTWEEK_LISTING_URLS,
  fingerprintSnapshot,
} from "./arxiv-source.mjs";
import { validateCheckpointSourceBlockerReceipt } from "./source-blocker.mjs";

export const CHECKPOINT_SCHEMA_VERSION = "1.0";
export const CHECKPOINT_CATEGORIES = Object.freeze(["quant-ph", "gr-qc", "hep-th"]);
export const CATEGORY_DRAFT_SCHEMA_VERSION = "1.0";
export const CATEGORY_SOURCE_DRAFT_SCHEMA_VERSION = "1.0";

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const EVENT_ID_PATTERN = /^[a-f0-9]{32}$/u;
const BLOB_PATTERN = /^([a-f0-9]{64})-([a-f0-9]{32})\.blob$/u;
const EVENT_FILE_PATTERN = /^\d{8}T\d{6}\.\d{3}Z-([a-f0-9]{32})\.json$/u;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_REPORT_BYTES = 10 * 1024 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_SOURCE_DRAFT_ENVELOPE_BYTES = 2 * MAX_REPORT_BYTES;
const DIRECTORY_MODE = 0o700;
const IMMUTABLE_FILE_MODE = 0o400;
const MATERIALIZED_FILE_MODE = 0o600;
const AGED_PROVENANCE_SCHEMA_VERSION = "1.0";
const AGED_PROVENANCE_KIND = "aged_checkpoint_provenance";
const AGED_PROVENANCE_ENTRY_KEYS = Object.freeze([
  "path", "type", "mode", "uid", "dev", "ino", "nlink", "size",
  "birthtimeNs", "mtimeNs", "ctimeNs", "sha256",
]);
const AGED_PROVENANCE_KEYS = Object.freeze([
  "schemaVersion", "kind", "targetDate", "oldestLiveDate", "expectedUid",
  "snapshotFingerprint", "snapshotRawSha256", "manifestRawSha256",
  "runtimeFingerprint", "evaluationRunId", "manifestCreatedAt", "attemptCount",
  "family", "entries", "evidenceSha256",
]);
const MAX_PROVENANCE_RUN_MS = 6 * 60 * 60 * 1000;
const MAX_EVENT_FILE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const DRAFT_ATTEMPT_STAGES = Object.freeze([
  "category_generation",
  "category_source_resume",
  "category_repair",
]);

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
    drafts: join(jobPath, "drafts"),
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
      maxBytes: MAX_SOURCE_DRAFT_ENVELOPE_BYTES,
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

function categoryDraftPaths(paths, attemptId, category) {
  validateSafeId(attemptId, "Category draft attemptId");
  validateCategory(category);
  const stem = `${attemptId}.${category}`;
  return Object.freeze({
    report: join(paths.drafts, `${stem}.json`),
    receipt: join(paths.drafts, `${stem}.receipt.json`),
    sourceEnvelope: join(paths.drafts, `${stem}.source-draft.json`),
  });
}

function sourceDraftAttemptStage(attempts, attemptId, category, label) {
  const stages = new Set(attempts.filter((event) => (
    event.attemptId === attemptId
    && event.category === category
    && DRAFT_ATTEMPT_STAGES.includes(event.stage)
    && event.status === "started"
  )).map(({ stage }) => stage));
  if (stages.size !== 1) {
    fail(`${label} must have exactly one protected started-attempt stage.`);
  }
  return [...stages][0];
}

function validateCategorySourceDraftEnvelope(
  envelope,
  manifest,
  snapshot,
  attempts,
  { attemptId, category },
  label,
) {
  exactKeys(envelope, [
    "schemaVersion",
    "kind",
    "reportDate",
    "snapshotFingerprint",
    "runtimeFingerprint",
    "evaluationRunId",
    "category",
    "fileName",
    "reportSha256",
    "reportBytes",
    "report",
    "sourceReceipt",
    "preservedAt",
    "attemptId",
    "attemptStage",
  ], label);
  if (
    envelope.schemaVersion !== CATEGORY_SOURCE_DRAFT_SCHEMA_VERSION
    || envelope.kind !== "source_incomplete_category_draft"
  ) {
    fail(`${label} has an invalid schema or kind.`);
  }
  if (envelope.reportDate !== manifest.reportDate) fail(`${label}.reportDate does not match the job.`);
  if (envelope.snapshotFingerprint !== manifest.snapshotFingerprint) {
    fail(`${label}.snapshotFingerprint does not match the job.`);
  }
  if (envelope.runtimeFingerprint !== manifest.runtimeFingerprint) {
    fail(`${label}.runtimeFingerprint does not match the job.`);
  }
  if (envelope.evaluationRunId !== manifest.evaluationRunId) {
    fail(`${label}.evaluationRunId does not match the job.`);
  }
  if (envelope.category !== category) fail(`${label}.category must be ${category}.`);
  if (envelope.fileName !== `${manifest.reportDate}-${category}.json`) fail(`${label}.fileName is invalid.`);
  validateSha256(envelope.reportSha256, `${label}.reportSha256`);
  if (
    !Number.isSafeInteger(envelope.reportBytes)
    || envelope.reportBytes < 2
    || envelope.reportBytes > MAX_REPORT_BYTES
  ) {
    fail(`${label}.reportBytes is invalid.`);
  }
  isoTimestamp(envelope.preservedAt, `${label}.preservedAt`);
  validateSafeId(envelope.attemptId, `${label}.attemptId`);
  if (envelope.attemptId !== attemptId) fail(`${label}.attemptId does not match its filename.`);
  if (!DRAFT_ATTEMPT_STAGES.includes(envelope.attemptStage)) fail(`${label}.attemptStage is invalid.`);
  const expectedStage = sourceDraftAttemptStage(attempts, attemptId, category, label);
  if (envelope.attemptStage !== expectedStage) fail(`${label}.attemptStage does not match its started event.`);
  validateReportAssociation(envelope.report, manifest, category, `${label}.report`);
  const reportContent = Buffer.from(serializeJson(envelope.report), "utf8");
  if (
    reportContent.length !== envelope.reportBytes
    || sha256(reportContent) !== envelope.reportSha256
  ) {
    fail(`${label}.report digest or byte count changed.`);
  }
  const sourceReceipt = validateCheckpointSourceBlockerReceipt(envelope.sourceReceipt, {
    snapshot,
    category,
  });
  return Object.freeze({
    envelope,
    report: envelope.report,
    reportContent,
    sourceReceipt,
  });
}

function validateCategoryDraftReceipt(receipt, manifest, { attemptId, category }, label) {
  exactKeys(receipt, [
    "schemaVersion",
    "kind",
    "reportDate",
    "snapshotFingerprint",
    "runtimeFingerprint",
    "evaluationRunId",
    "category",
    "fileName",
    "sha256",
    "bytes",
    "preservedAt",
    "attemptId",
  ], label);
  if (receipt.schemaVersion !== CATEGORY_DRAFT_SCHEMA_VERSION || receipt.kind !== "failed_category_draft") {
    fail(`${label} has an invalid schema or kind.`);
  }
  if (receipt.reportDate !== manifest.reportDate) fail(`${label}.reportDate does not match the job.`);
  if (receipt.snapshotFingerprint !== manifest.snapshotFingerprint) fail(`${label}.snapshotFingerprint does not match the job.`);
  if (receipt.runtimeFingerprint !== manifest.runtimeFingerprint) fail(`${label}.runtimeFingerprint does not match the job.`);
  if (receipt.evaluationRunId !== manifest.evaluationRunId) fail(`${label}.evaluationRunId does not match the job.`);
  if (receipt.category !== category) fail(`${label}.category must be ${category}.`);
  if (receipt.fileName !== `${manifest.reportDate}-${category}.json`) fail(`${label}.fileName is invalid.`);
  validateSha256(receipt.sha256, `${label}.sha256`);
  if (!Number.isSafeInteger(receipt.bytes) || receipt.bytes < 2 || receipt.bytes > MAX_REPORT_BYTES) {
    fail(`${label}.bytes is invalid.`);
  }
  isoTimestamp(receipt.preservedAt, `${label}.preservedAt`);
  validateSafeId(receipt.attemptId, `${label}.attemptId`);
  if (receipt.attemptId !== attemptId) fail(`${label}.attemptId does not match its filename.`);
  return receipt;
}

function eligibleCategoryDraftAttempts(attempts) {
  const eligible = new Map();
  for (const event of attempts) {
    if (event.category === null || !DRAFT_ATTEMPT_STAGES.includes(event.stage)) continue;
    const key = `${event.attemptId}\0${event.category}`;
    if (!eligible.has(key)) {
      eligible.set(key, Object.freeze({ attemptId: event.attemptId, category: event.category }));
    }
  }
  return [...eligible.values()];
}

function loadCategoryDrafts(paths, manifest, snapshot, blobsByInode, attempts) {
  assertSecureDirectory(paths.drafts, "Checkpoint category drafts directory");
  const eligible = eligibleCategoryDraftAttempts(attempts);
  const allowedEntries = new Set();
  for (const { attemptId, category } of eligible) {
    const candidate = categoryDraftPaths(paths, attemptId, category);
    allowedEntries.add(candidate.report.slice(paths.drafts.length + 1));
    allowedEntries.add(candidate.receipt.slice(paths.drafts.length + 1));
    allowedEntries.add(candidate.sourceEnvelope.slice(paths.drafts.length + 1));
  }
  for (const entry of readdirSync(paths.drafts)) {
    if (!allowedEntries.has(entry)) fail(`Unexpected checkpoint category draft artifact: ${entry}`);
  }

  const drafts = Object.fromEntries(CHECKPOINT_CATEGORIES.map((category) => [category, []]));
  const incompleteDrafts = [];
  for (const { attemptId, category } of eligible) {
    const candidate = categoryDraftPaths(paths, attemptId, category);
    const reportExists = existsSync(candidate.report);
    const receiptExists = existsSync(candidate.receipt);
    const sourceEnvelopeExists = existsSync(candidate.sourceEnvelope);
    if (sourceEnvelopeExists && (reportExists || receiptExists)) {
      fail(`Checkpoint category draft has mixed generic and source artifacts: ${attemptId} ${category}`);
    }
    if (sourceEnvelopeExists) {
      const envelopeContent = readCheckpointArtifact(
        candidate.sourceEnvelope,
        `Checkpoint source category draft ${attemptId} ${category}`,
        { maxBytes: MAX_SOURCE_DRAFT_ENVELOPE_BYTES, blobsByInode },
      );
      const loaded = validateCategorySourceDraftEnvelope(
        parseJsonBuffer(envelopeContent, `Checkpoint source category draft ${attemptId} ${category}`),
        manifest,
        snapshot,
        attempts,
        { attemptId, category },
        `Checkpoint source category draft ${attemptId} ${category}`,
      );
      drafts[category].push(Object.freeze({
        attemptId,
        category,
        path: candidate.sourceEnvelope,
        receiptPath: candidate.sourceEnvelope,
        sha256: loaded.envelope.reportSha256,
        bytes: loaded.envelope.reportBytes,
        report: loaded.report,
        receipt: Object.freeze(loaded.envelope),
        sourceReceipt: loaded.sourceReceipt,
        attemptStage: loaded.envelope.attemptStage,
        preservedAt: loaded.envelope.preservedAt,
        storageKind: "source_envelope",
      }));
      continue;
    }
    if (!reportExists && !receiptExists) continue;
    if (!reportExists) fail(`Checkpoint category draft receipt exists without its report: ${attemptId} ${category}`);
    const content = readCheckpointArtifact(
      candidate.report,
      `Checkpoint category draft ${attemptId} ${category}`,
      { maxBytes: MAX_REPORT_BYTES, blobsByInode },
    );
    const report = parseJsonBuffer(content, `Checkpoint category draft ${attemptId} ${category}`);
    validateReportAssociation(report, manifest, category, `Checkpoint category draft ${attemptId} ${category}`);
    if (!receiptExists) {
      incompleteDrafts.push(Object.freeze({ attemptId, category, path: candidate.report }));
      continue;
    }
    const receipt = validateCategoryDraftReceipt(
      parseJsonBuffer(
        readCheckpointArtifact(
          candidate.receipt,
          `Checkpoint category draft receipt ${attemptId} ${category}`,
          { maxBytes: MAX_RECORD_BYTES, blobsByInode },
        ),
        `Checkpoint category draft receipt ${attemptId} ${category}`,
      ),
      manifest,
      { attemptId, category },
      `Checkpoint category draft receipt ${attemptId} ${category}`,
    );
    const digest = sha256(content);
    if (digest !== receipt.sha256 || content.length !== receipt.bytes) {
      fail(`Checkpoint category draft digest or byte count changed: ${attemptId} ${category}`);
    }
    drafts[category].push(Object.freeze({
      attemptId,
      category,
      path: candidate.report,
      receiptPath: candidate.receipt,
      sha256: digest,
      bytes: content.length,
      report,
      receipt: Object.freeze(receipt),
      sourceReceipt: null,
      attemptStage: sourceDraftAttemptStage(attempts, attemptId, category, `Checkpoint category draft ${attemptId} ${category}`),
      preservedAt: receipt.preservedAt,
      storageKind: "generic_pair",
    }));
  }
  return Object.freeze({
    drafts: Object.freeze(Object.fromEntries(
      CHECKPOINT_CATEGORIES.map((category) => [category, Object.freeze(drafts[category])]),
    )),
    incompleteDrafts: Object.freeze(incompleteDrafts),
  });
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
  assertExactDirectoryEntries(paths.root, [".writes", "attempts", "drafts", "job.json", "publication", "reports", "snapshot.json"], "Checkpoint job directory");
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
  const attempts = loadEvents(paths.attempts, manifest, "attempt", blobsByInode);
  const loadedReports = loadReports(paths, manifest, blobsByInode);
  const loadedDrafts = loadCategoryDrafts(paths, manifest, snapshot, blobsByInode, attempts);
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
    drafts: loadedDrafts.drafts,
    incompleteDrafts: loadedDrafts.incompleteDrafts,
    completeCategories: Object.freeze(CHECKPOINT_CATEGORIES.filter((category) => category in loadedReports.reports)),
    isComplete: CHECKPOINT_CATEGORIES.every((category) => category in loadedReports.reports),
    attempts,
    publicationEvents,
    publicationStatus: publicationEvents.at(-1)?.status ?? null,
    publishedCommit: publishedEvents.at(-1)?.commit ?? null,
  });
}

function parseSchedulerRunIdTimestamp(value, label) {
  const match = /^run-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[a-f0-9]{12}$/u.exec(value);
  if (!match) fail(`${label} must use the scheduler run ID format.`);
  const timestamp = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.000Z`;
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) fail(`${label} contains an invalid timestamp.`);
  return milliseconds;
}

function jstDayBounds(date) {
  validateDate(date);
  const startMs = Date.parse(`${date}T00:00:00+09:00`);
  const cursor = new Date(`${date}T00:00:00Z`);
  cursor.setUTCDate(cursor.getUTCDate() + 1);
  const nextDate = cursor.toISOString().slice(0, 10);
  return Object.freeze({
    startMs,
    endMs: Date.parse(`${nextDate}T00:00:00+09:00`),
  });
}

function statNanoseconds(metadata, key) {
  const nanoseconds = metadata[`${key}Ns`];
  if (typeof nanoseconds === "bigint") return nanoseconds;
  const milliseconds = metadata[`${key}Ms`];
  if (typeof milliseconds !== "bigint" && !Number.isFinite(milliseconds)) {
    fail(`Checkpoint ${key} timestamp is unavailable.`);
  }
  const numericMilliseconds = typeof milliseconds === "bigint" ? milliseconds : BigInt(Math.trunc(milliseconds));
  return numericMilliseconds * 1_000_000n;
}

function assertProvenanceTimestamp(metadata, label, targetBounds, oldestLiveStartMs) {
  const lower = BigInt(targetBounds.startMs) * 1_000_000n;
  const upper = BigInt(Math.min(targetBounds.endMs, oldestLiveStartMs)) * 1_000_000n;
  for (const key of ["birthtime", "mtime", "ctime"]) {
    const value = statNanoseconds(metadata, key);
    if (value < lower || value >= upper) {
      fail(`${label} ${key} must remain within the target JST day and before oldestLiveDate.`);
    }
  }
}

function sameProvenanceIdentity(left, right) {
  return ["dev", "ino", "uid", "mode", "nlink", "size", "birthtimeNs", "mtimeNs", "ctimeNs"]
    .every((key) => {
      const normalizedLeft = key.endsWith("Ns")
        ? statNanoseconds(left, key.slice(0, -2))
        : left[key];
      const normalizedRight = key.endsWith("Ns")
        ? statNanoseconds(right, key.slice(0, -2))
        : right[key];
      return normalizedLeft === normalizedRight;
    });
}

function provenanceEntry({
  path,
  base,
  label,
  type,
  expectedUid,
  targetBounds,
  oldestLiveStartMs,
  requireTargetTimestamp = true,
}) {
  const metadata = lstatSync(path, { bigint: true });
  const expectedMode = type === "directory" ? BigInt(DIRECTORY_MODE) : BigInt(IMMUTABLE_FILE_MODE);
  if (
    metadata.isSymbolicLink()
    || (type === "directory" ? !metadata.isDirectory() : !metadata.isFile())
    || metadata.uid !== BigInt(expectedUid)
    || (metadata.mode & 0o777n) !== expectedMode
    || realpathSync(path) !== resolve(path)
  ) {
    fail(`${label} must be an owned canonical ${type} with mode 0${expectedMode.toString(8)}.`);
  }
  if (type === "file" && metadata.nlink !== 2n) {
    fail(`${label} must have exactly one artifact link and one content-addressed blob link.`);
  }
  if (requireTargetTimestamp) {
    assertProvenanceTimestamp(metadata, label, targetBounds, oldestLiveStartMs);
  }

  let content = null;
  let stableMetadata = metadata;
  if (type === "file") {
    let descriptor;
    try {
      descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const before = fstatSync(descriptor, { bigint: true });
      content = readFileSync(descriptor);
      const after = fstatSync(descriptor, { bigint: true });
      const finalPathMetadata = lstatSync(path, { bigint: true });
      if (
        !sameProvenanceIdentity(metadata, before)
        || !sameProvenanceIdentity(before, after)
        || !sameProvenanceIdentity(after, finalPathMetadata)
        || BigInt(content.length) !== after.size
      ) {
        fail(`${label} changed while its aged-checkpoint provenance was captured.`);
      }
      stableMetadata = after;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  const relativePath = relative(base, path) || ".";
  const entry = {
    path: relativePath,
    type,
    mode: `0${Number(stableMetadata.mode & 0o777n).toString(8)}`,
    uid: Number(stableMetadata.uid),
    dev: stableMetadata.dev.toString(),
    ino: stableMetadata.ino.toString(),
    nlink: stableMetadata.nlink.toString(),
    size: stableMetadata.size.toString(),
    birthtimeNs: statNanoseconds(stableMetadata, "birthtime").toString(),
    mtimeNs: statNanoseconds(stableMetadata, "mtime").toString(),
    ctimeNs: statNanoseconds(stableMetadata, "ctime").toString(),
    sha256: content === null ? null : sha256(content),
  };
  return Object.freeze({ entry: Object.freeze(entry), content });
}

function assertTimeWithinAgedTarget(milliseconds, label, targetBounds, oldestLiveStartMs) {
  const upper = Math.min(targetBounds.endMs, oldestLiveStartMs);
  if (!Number.isFinite(milliseconds) || milliseconds < targetBounds.startMs || milliseconds >= upper) {
    fail(`${label} must be within the target JST day and before oldestLiveDate.`);
  }
}

function validateAgedProvenanceEntry(entry, label) {
  exactKeys(entry, AGED_PROVENANCE_ENTRY_KEYS, label);
  if (typeof entry.path !== "string" || entry.path.length === 0 || isAbsolute(entry.path)) {
    fail(`${label}.path must be a non-empty relative path.`);
  }
  if (!["directory", "file"].includes(entry.type)) fail(`${label}.type is invalid.`);
  if (entry.mode !== (entry.type === "directory" ? "0700" : "0400")) {
    fail(`${label}.mode is invalid.`);
  }
  if (!Number.isSafeInteger(entry.uid) || entry.uid < 0) fail(`${label}.uid is invalid.`);
  for (const key of ["dev", "ino", "nlink", "size", "birthtimeNs", "mtimeNs", "ctimeNs"]) {
    if (typeof entry[key] !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(entry[key])) {
      fail(`${label}.${key} must be a canonical non-negative integer string.`);
    }
  }
  if (entry.type === "directory") {
    if (entry.sha256 !== null) fail(`${label}.sha256 must be null for a directory.`);
  } else if (typeof entry.sha256 !== "string" || !SHA256_PATTERN.test(entry.sha256)) {
    fail(`${label}.sha256 must be a lowercase SHA-256 digest.`);
  }
  return entry;
}

function validateExpectedAgedProvenance(evidence) {
  exactKeys(evidence, AGED_PROVENANCE_KEYS, "Expected aged-checkpoint provenance");
  if (
    evidence.schemaVersion !== AGED_PROVENANCE_SCHEMA_VERSION
    || evidence.kind !== AGED_PROVENANCE_KIND
  ) {
    fail("Expected aged-checkpoint provenance has an unsupported identity.");
  }
  validateDate(evidence.targetDate);
  validateDate(evidence.oldestLiveDate);
  if (!Number.isSafeInteger(evidence.expectedUid) || evidence.expectedUid < 0) {
    fail("Expected aged-checkpoint provenance expectedUid is invalid.");
  }
  for (const key of [
    "snapshotFingerprint", "snapshotRawSha256", "manifestRawSha256",
    "runtimeFingerprint", "evidenceSha256",
  ]) validateSha256(evidence[key], `Expected aged-checkpoint provenance ${key}`);
  validateSafeId(evidence.evaluationRunId, "Expected aged-checkpoint provenance evaluationRunId");
  isoTimestamp(evidence.manifestCreatedAt, "Expected aged-checkpoint provenance manifestCreatedAt");
  if (!Number.isSafeInteger(evidence.attemptCount) || evidence.attemptCount < 0) {
    fail("Expected aged-checkpoint provenance attemptCount is invalid.");
  }
  validateAgedProvenanceEntry(evidence.family, "Expected aged-checkpoint provenance family");
  if (evidence.family.path !== "." || evidence.family.type !== "directory") {
    fail("Expected aged-checkpoint provenance family must describe the family root.");
  }
  if (!Array.isArray(evidence.entries) || evidence.entries.length < 6) {
    fail("Expected aged-checkpoint provenance entries are incomplete.");
  }
  const paths = [];
  evidence.entries.forEach((entry, index) => {
    validateAgedProvenanceEntry(entry, `Expected aged-checkpoint provenance entries[${index}]`);
    if (entry.path === ".") fail("Expected aged-checkpoint provenance source entries may not replace the family root.");
    paths.push(entry.path);
  });
  if (new Set(paths).size !== paths.length || [...paths].sort().join("\0") !== paths.join("\0")) {
    fail("Expected aged-checkpoint provenance entries must be unique and sorted by path.");
  }
  const { evidenceSha256, ...digestInput } = evidence;
  const actualDigest = sha256(Buffer.from(serializeJson(digestInput), "utf8"));
  if (actualDigest !== evidenceSha256) {
    fail("Expected aged-checkpoint provenance evidence digest is invalid.");
  }
  return evidence;
}

function assertStableFamilyIdentity(current, expected) {
  for (const key of ["path", "type", "mode", "uid", "dev", "ino", "birthtimeNs", "sha256"]) {
    if (current[key] !== expected[key]) {
      fail("Aged-checkpoint family identity changed after its initial provenance seal.");
    }
  }
}

function assertSameProvenanceEntry(current, expected, label) {
  for (const key of AGED_PROVENANCE_ENTRY_KEYS) {
    if (current[key] !== expected[key]) {
      fail(`${label} changed during final provenance verification.`);
    }
  }
}

/**
 * Captures a fail-closed, host-only provenance seal for the exceptional case
 * where an immutable snapshot-only checkpoint has aged exactly beyond the
 * live pastweek window. This is local filesystem provenance, not an external
 * cryptographic timestamp.
 */
export function captureAgedCheckpointProvenance({
  job,
  oldestLiveDate,
  expectedUid = currentUid(),
  expectedEvidence = null,
  allowedAdditionalRuntimeFingerprints = [],
  beforeFinalVerificationForTest = null,
} = {}) {
  if (!job || typeof job !== "object" || !job.manifest) {
    fail("A loaded checkpoint job is required for aged-checkpoint provenance.");
  }
  if (!Number.isSafeInteger(expectedUid) || expectedUid < 0 || currentUid() !== expectedUid) {
    fail("Aged-checkpoint provenance expectedUid must equal the current user.");
  }
  validateDate(oldestLiveDate);
  const targetDate = validateDate(job.manifest.reportDate);
  if (oldestLiveDate <= targetDate) {
    fail("Aged-checkpoint provenance oldestLiveDate must be newer than the target date.");
  }
  const targetBounds = jstDayBounds(targetDate);
  const oldestLiveStartMs = Date.parse(`${oldestLiveDate}T00:00:00+09:00`);
  if (!Array.isArray(allowedAdditionalRuntimeFingerprints)) {
    fail("Aged-checkpoint additional runtime fingerprints must be an array.");
  }
  for (const value of allowedAdditionalRuntimeFingerprints) {
    validateSha256(value, "Aged-checkpoint additional runtime fingerprint");
  }
  if (new Set(allowedAdditionalRuntimeFingerprints).size !== allowedAdditionalRuntimeFingerprints.length) {
    fail("Aged-checkpoint additional runtime fingerprints must be unique.");
  }
  if (
    beforeFinalVerificationForTest !== null
    && typeof beforeFinalVerificationForTest !== "function"
  ) {
    fail("Aged-checkpoint final-verification test hook must be a function or null.");
  }
  const reviewedEvidence = expectedEvidence === null
    ? null
    : validateExpectedAgedProvenance(expectedEvidence);
  if (reviewedEvidence === null && allowedAdditionalRuntimeFingerprints.length !== 0) {
    fail("Initial aged-checkpoint provenance requires a unique source-only family.");
  }

  const reloaded = loadCheckpointJob({
    controlRoot: job.controlRoot,
    reportDate: targetDate,
    snapshotFingerprint: job.manifest.snapshotFingerprint,
    runtimeFingerprint: job.manifest.runtimeFingerprint,
    evaluationRunId: job.evaluationRunId,
  });
  if (job.path !== reloaded.path || job.familyPath !== reloaded.familyPath) {
    fail("Aged-checkpoint provenance job paths changed after the source job was loaded.");
  }
  if (allowedAdditionalRuntimeFingerprints.includes(reloaded.manifest.runtimeFingerprint)) {
    fail("The source runtime may not be repeated as an additional runtime.");
  }
  if (reviewedEvidence !== null && (
    reviewedEvidence.targetDate !== targetDate
    || reviewedEvidence.oldestLiveDate !== oldestLiveDate
    || reviewedEvidence.expectedUid !== expectedUid
    || reviewedEvidence.snapshotFingerprint !== reloaded.manifest.snapshotFingerprint
    || reviewedEvidence.runtimeFingerprint !== reloaded.manifest.runtimeFingerprint
    || reviewedEvidence.evaluationRunId !== reloaded.evaluationRunId
  )) {
    fail("Expected aged-checkpoint provenance does not match the loaded source identity.");
  }
  for (const category of CHECKPOINT_CATEGORIES) {
    if (reloaded.snapshot.categories[category].sourceUrl !== ARXIV_PASTWEEK_LISTING_URLS[category]) {
      fail("Aged-checkpoint provenance requires an official pastweek snapshot.");
    }
  }
  if (
    reloaded.completeCategories.length !== 0
    || reloaded.incompleteReports.length !== 0
    || reloaded.incompleteDrafts.length !== 0
    || CHECKPOINT_CATEGORIES.some((category) => reloaded.drafts[category].length !== 0)
    || reloaded.publicationEvents.length !== 0
    || reloaded.publicationStatus !== null
    || reloaded.publishedCommit !== null
    || readdirSync(reloaded.paths.reports).length !== 0
    || readdirSync(reloaded.paths.drafts).length !== 0
    || readdirSync(reloaded.paths.publication).length !== 0
  ) {
    fail("Aged-checkpoint provenance may seal only an unpublished snapshot-only source job.");
  }

  const jobsDirectory = dirname(reloaded.familyPath);
  const matchingFamilies = readdirSync(jobsDirectory)
    .filter((name) => name.startsWith(`${targetDate}-`))
    .sort();
  if (
    matchingFamilies.length !== 1
    || matchingFamilies[0] !== basename(reloaded.familyPath)
  ) {
    fail("Aged-checkpoint provenance requires exactly one checkpoint family for the target date.");
  }
  const familyEntries = readdirSync(reloaded.familyPath).sort();
  const expectedFamilyEntries = [
    reloaded.manifest.runtimeFingerprint,
    ...allowedAdditionalRuntimeFingerprints,
  ].sort();
  if (familyEntries.join("\0") !== expectedFamilyEntries.join("\0")) {
    fail(
      reviewedEvidence === null
        ? "Aged-checkpoint provenance requires exactly one runtime in the target checkpoint family."
        : "Aged-checkpoint family contains a runtime that was not explicitly allowed for revalidation.",
    );
  }
  for (const runtimeFingerprint of allowedAdditionalRuntimeFingerprints) {
    assertSecureDirectory(
      join(reloaded.familyPath, runtimeFingerprint),
      `Allowed aged-checkpoint destination runtime ${runtimeFingerprint}`,
    );
  }

  const currentFamilyCapture = provenanceEntry({
    path: reloaded.familyPath,
    base: reloaded.familyPath,
    label: `Aged-checkpoint family ${reloaded.familyPath}`,
    type: "directory",
    expectedUid,
    targetBounds,
    oldestLiveStartMs,
    requireTargetTimestamp: reviewedEvidence === null,
  });
  if (reviewedEvidence !== null) {
    assertStableFamilyIdentity(currentFamilyCapture.entry, reviewedEvidence.family);
  }

  const directoryPaths = [
    reloaded.paths.root,
    reloaded.paths.writes,
    reloaded.paths.attempts,
    reloaded.paths.drafts,
    reloaded.paths.publication,
    reloaded.paths.reports,
  ];
  const attemptNames = readdirSync(reloaded.paths.attempts).sort();
  const artifactPaths = [
    reloaded.paths.manifest,
    reloaded.paths.snapshot,
    ...attemptNames.map((name) => join(reloaded.paths.attempts, name)),
  ];
  const blobNames = readdirSync(reloaded.paths.writes).sort();
  if (blobNames.length !== artifactPaths.length) {
    fail("Aged-checkpoint provenance requires one content-addressed blob per immutable artifact.");
  }
  const blobPaths = blobNames.map((name) => join(reloaded.paths.writes, name));

  const captures = [
    ...directoryPaths.map((path) => provenanceEntry({
      path,
      base: reloaded.familyPath,
      label: `Aged-checkpoint directory ${path}`,
      type: "directory",
      expectedUid,
      targetBounds,
      oldestLiveStartMs,
    })),
    ...[...artifactPaths, ...blobPaths].map((path) => provenanceEntry({
      path,
      base: reloaded.familyPath,
      label: `Aged-checkpoint file ${path}`,
      type: "file",
      expectedUid,
      targetBounds,
      oldestLiveStartMs,
    })),
  ];
  const capturesByPath = new Map(captures.map((capture) => [capture.entry.path, capture]));
  const blobsByInode = new Map();
  for (const name of blobNames) {
    const match = BLOB_PATTERN.exec(name);
    if (!match) fail(`Unexpected aged-checkpoint write blob: ${name}`);
    const capture = capturesByPath.get(relative(reloaded.familyPath, join(reloaded.paths.writes, name)));
    if (capture.entry.sha256 !== match[1]) {
      fail(`Aged-checkpoint write blob digest does not match its filename: ${name}`);
    }
    const inodeKey = `${capture.entry.dev}:${capture.entry.ino}`;
    if (blobsByInode.has(inodeKey)) fail("Aged-checkpoint write blobs repeat an inode.");
    blobsByInode.set(inodeKey, capture);
  }
  const pairedBlobPaths = new Set();
  for (const path of artifactPaths) {
    const capture = capturesByPath.get(relative(reloaded.familyPath, path));
    const blob = blobsByInode.get(`${capture.entry.dev}:${capture.entry.ino}`);
    if (blob === undefined || blob.entry.sha256 !== capture.entry.sha256) {
      fail(`Aged-checkpoint artifact is not paired with exactly one matching write blob: ${path}`);
    }
    pairedBlobPaths.add(blob.entry.path);
  }
  if (pairedBlobPaths.size !== blobPaths.length) {
    fail("Aged-checkpoint provenance contains an unpaired content-addressed blob.");
  }

  const manifestTime = Date.parse(reloaded.manifest.createdAt);
  assertTimeWithinAgedTarget(
    manifestTime,
    "Aged-checkpoint manifest createdAt",
    targetBounds,
    oldestLiveStartMs,
  );
  const evaluationRunTime = parseSchedulerRunIdTimestamp(
    reloaded.evaluationRunId,
    "Aged-checkpoint evaluationRunId",
  );
  if (manifestTime < evaluationRunTime || manifestTime - evaluationRunTime > 5_000) {
    fail("Aged-checkpoint manifest createdAt does not match evaluationRunId.");
  }
  const manifestCapture = capturesByPath.get(
    relative(reloaded.familyPath, reloaded.paths.manifest),
  );
  const manifestBirthMs = Number(BigInt(manifestCapture.entry.birthtimeNs) / 1_000_000n);
  if (manifestBirthMs < manifestTime || manifestBirthMs - manifestTime > MAX_PROVENANCE_RUN_MS) {
    fail("Aged-checkpoint manifest filesystem birthtime is inconsistent with its run.");
  }

  let previousAttemptTime = manifestTime;
  for (const [index, event] of reloaded.attempts.entries()) {
    const eventTime = Date.parse(event.at);
    assertTimeWithinAgedTarget(
      eventTime,
      `Aged-checkpoint attempt ${index} timestamp`,
      targetBounds,
      oldestLiveStartMs,
    );
    const attemptRunTime = parseSchedulerRunIdTimestamp(
      event.attemptId,
      `Aged-checkpoint attempt ${index} attemptId`,
    );
    if (
      eventTime < previousAttemptTime
      || eventTime < attemptRunTime
      || eventTime - attemptRunTime > MAX_PROVENANCE_RUN_MS
    ) {
      fail(`Aged-checkpoint attempt ${index} timestamp is inconsistent with its run history.`);
    }
    const eventName = `${event.at.replace(/[-:]/gu, "")}-${event.eventId}.json`;
    const eventCapture = capturesByPath.get(
      relative(reloaded.familyPath, join(reloaded.paths.attempts, eventName)),
    );
    if (eventCapture === undefined) {
      fail(`Aged-checkpoint attempt ${index} is missing its immutable event artifact.`);
    }
    const eventBirthMs = Number(BigInt(eventCapture.entry.birthtimeNs) / 1_000_000n);
    if (Math.abs(eventBirthMs - eventTime) > MAX_EVENT_FILE_CLOCK_SKEW_MS) {
      fail(`Aged-checkpoint attempt ${index} filesystem birthtime is inconsistent with event.at.`);
    }
    previousAttemptTime = eventTime;
  }

  // Synchronous test-only fault injection makes the otherwise very narrow
  // capture/reload race deterministic. Production callers leave this null.
  beforeFinalVerificationForTest?.();

  // Re-load after provenance capture so a concurrent directory or artifact
  // mutation cannot be sealed merely because it happened between two reads.
  const finalJob = loadCheckpointJob({
    controlRoot: reloaded.controlRoot,
    reportDate: targetDate,
    snapshotFingerprint: reloaded.manifest.snapshotFingerprint,
    runtimeFingerprint: reloaded.manifest.runtimeFingerprint,
    evaluationRunId: reloaded.evaluationRunId,
  });
  if (
    finalJob.attempts.length !== reloaded.attempts.length
    || readdirSync(finalJob.familyPath).sort().join("\0") !== familyEntries.join("\0")
    || readdirSync(finalJob.paths.writes).sort().join("\0") !== blobNames.join("\0")
  ) {
    fail("Aged-checkpoint source changed before its provenance could be sealed.");
  }

  const finalFamilyCapture = provenanceEntry({
    path: finalJob.familyPath,
    base: finalJob.familyPath,
    label: `Aged-checkpoint family ${finalJob.familyPath}`,
    type: "directory",
    expectedUid,
    targetBounds,
    oldestLiveStartMs,
    requireTargetTimestamp: reviewedEvidence === null,
  });
  assertSameProvenanceEntry(
    finalFamilyCapture.entry,
    currentFamilyCapture.entry,
    "Aged-checkpoint family",
  );
  const finalCaptures = [
    ...directoryPaths.map((path) => provenanceEntry({
      path,
      base: finalJob.familyPath,
      label: `Aged-checkpoint directory ${path}`,
      type: "directory",
      expectedUid,
      targetBounds,
      oldestLiveStartMs,
    })),
    ...[...artifactPaths, ...blobPaths].map((path) => provenanceEntry({
      path,
      base: finalJob.familyPath,
      label: `Aged-checkpoint file ${path}`,
      type: "file",
      expectedUid,
      targetBounds,
      oldestLiveStartMs,
    })),
  ];
  const capturesByEntryPath = new Map(captures.map((capture) => [capture.entry.path, capture]));
  for (const capture of finalCaptures) {
    const original = capturesByEntryPath.get(capture.entry.path);
    if (original === undefined) {
      fail("Aged-checkpoint source layout changed during final provenance verification.");
    }
    assertSameProvenanceEntry(
      capture.entry,
      original.entry,
      `Aged-checkpoint source entry ${capture.entry.path}`,
    );
  }
  if (finalCaptures.length !== captures.length) {
    fail("Aged-checkpoint source layout changed during final provenance verification.");
  }

  const entries = captures.map(({ entry }) => entry)
    .sort((left, right) => left.path.localeCompare(right.path));
  const manifestRawSha256 = capturesByPath.get(
    relative(reloaded.familyPath, reloaded.paths.manifest),
  ).entry.sha256;
  const snapshotRawSha256 = capturesByPath.get(
    relative(reloaded.familyPath, reloaded.paths.snapshot),
  ).entry.sha256;
  if (snapshotRawSha256 !== reloaded.manifest.snapshotSha256) {
    fail("Aged-checkpoint raw snapshot digest changed after job validation.");
  }
  const evidence = {
    schemaVersion: AGED_PROVENANCE_SCHEMA_VERSION,
    kind: AGED_PROVENANCE_KIND,
    targetDate,
    oldestLiveDate,
    expectedUid,
    snapshotFingerprint: reloaded.manifest.snapshotFingerprint,
    snapshotRawSha256,
    manifestRawSha256,
    runtimeFingerprint: reloaded.manifest.runtimeFingerprint,
    evaluationRunId: reloaded.evaluationRunId,
    manifestCreatedAt: reloaded.manifest.createdAt,
    attemptCount: reloaded.attempts.length,
    family: reviewedEvidence?.family ?? currentFamilyCapture.entry,
    entries,
  };
  const evidenceSha256 = sha256(Buffer.from(serializeJson(evidence), "utf8"));
  if (reviewedEvidence !== null && evidenceSha256 !== reviewedEvidence.evidenceSha256) {
    fail("Aged-checkpoint source subtree changed after its initial provenance seal.");
  }
  return Object.freeze({
    ...evidence,
    family: Object.freeze(evidence.family),
    entries: Object.freeze(entries),
    evidenceSha256,
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

function validateCheckpointReportCandidate({
  current,
  category,
  content,
  normalizeReport,
  validateReport,
  label,
  validationContext = {},
}) {
  if (typeof validateReport !== "function") fail("Checkpoint report import requires a validation callback.");
  if (normalizeReport !== undefined && typeof normalizeReport !== "function") {
    fail("Checkpoint report normalizer must be a function when supplied.");
  }
  const context = {
    category,
    reportDate: current.manifest.reportDate,
    evaluationRunId: current.evaluationRunId,
    snapshot: current.snapshot,
    ...validationContext,
  };
  const sourceReport = parseJsonBuffer(content, label);
  validateReportAssociation(sourceReport, current.manifest, category, label);
  // A trusted host normalizer may derive the protected copy from the stable
  // source bytes, but it never writes back to the untrusted model file.
  const report = normalizeReport === undefined ? sourceReport : normalizeReport(sourceReport, context);
  validateReportAssociation(report, current.manifest, category, `${label} after normalization`);
  const normalizedContent = normalizeReport === undefined
    ? content
    : Buffer.from(serializeJson(report), "utf8");
  if (normalizedContent.length > MAX_REPORT_BYTES) fail(`${label} exceeds the normalized report size limit.`);
  const validationResult = validateReport(report, context);
  if (validationResult === false) fail(`${label} failed validation.`);
  return Object.freeze({ report, content: normalizedContent });
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
  normalizeReport,
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
  const candidate = validateCheckpointReportCandidate({
    current,
    category,
    content,
    normalizeReport,
    validateReport,
    label: `Checkpoint source report ${category}`,
  });
  const digest = sha256(candidate.content);
  const reportPath = join(current.paths.reports, `${category}.json`);
  if (existsSync(reportPath)) {
    const existing = readStableSecureFile(reportPath, `Existing checkpoint report ${category}`, { maxBytes: MAX_REPORT_BYTES });
    if (sha256(existing) !== digest || !existing.equals(candidate.content)) fail(`Refusing to replace a different checkpoint report for ${category}.`);
  } else {
    writeAtomicExclusive(current.paths, reportPath, candidate.content);
  }
  writeMissingReportReceipt({ current, category, content: candidate.content, attemptId, now });
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

function assertDraftAttemptStarted(current, attemptId, category) {
  const started = current.attempts.some((event) => (
    event.attemptId === attemptId
    && event.category === category
    && DRAFT_ATTEMPT_STAGES.includes(event.stage)
    && event.status === "started"
  ));
  if (!started) fail(`Category draft ${attemptId} ${category} has no protected started-attempt event.`);
}

function writeMissingCategoryDraftReceipt({ current, attemptId, category, content, now }) {
  validateSafeId(attemptId, "Category draft attemptId");
  validateCategory(category);
  assertDraftAttemptStarted(current, attemptId, category);
  const destinations = categoryDraftPaths(current.paths, attemptId, category);
  if (existsSync(destinations.sourceEnvelope)) {
    fail(`Refusing a generic receipt for an existing source category draft ${attemptId} ${category}.`);
  }
  if (existsSync(destinations.receipt)) {
    fail(`Refusing to overwrite an existing category draft receipt for ${attemptId} ${category}.`);
  }
  const receipt = {
    schemaVersion: CATEGORY_DRAFT_SCHEMA_VERSION,
    kind: "failed_category_draft",
    reportDate: current.manifest.reportDate,
    snapshotFingerprint: current.manifest.snapshotFingerprint,
    runtimeFingerprint: current.manifest.runtimeFingerprint,
    evaluationRunId: current.evaluationRunId,
    category,
    fileName: `${current.manifest.reportDate}-${category}.json`,
    sha256: sha256(content),
    bytes: content.length,
    preservedAt: isoTimestamp(now, "Category draft preservedAt"),
    attemptId,
  };
  validateCategoryDraftReceipt(
    receipt,
    current.manifest,
    { attemptId, category },
    `Category draft receipt ${attemptId} ${category}`,
  );
  writeAtomicExclusive(current.paths, destinations.receipt, serializeJson(receipt));
  return receipt;
}

export function preserveCheckpointCategoryDraft({
  job,
  category,
  sourcePath,
  normalizeReport,
  validateDraft,
  attemptId,
  now = new Date(),
}) {
  const current = reloadJob(job);
  validateCategory(category);
  validateSafeId(attemptId, "Category draft attemptId");
  assertDraftAttemptStarted(current, attemptId, category);
  if (typeof sourcePath !== "string" || !isAbsolute(sourcePath) || resolve(sourcePath) !== sourcePath) {
    fail("Category draft sourcePath must be an absolute normalized path.");
  }
  const content = readStableSecureFile(sourcePath, `Category draft source ${category}`, {
    maxBytes: MAX_REPORT_BYTES,
    immutable: false,
  });
  const candidate = validateCheckpointReportCandidate({
    current,
    category,
    content,
    normalizeReport,
    validateReport: validateDraft,
    label: `Category draft source ${category}`,
    validationContext: { attemptId },
  });
  const destinations = categoryDraftPaths(current.paths, attemptId, category);
  if (
    existsSync(destinations.report)
    || existsSync(destinations.receipt)
    || existsSync(destinations.sourceEnvelope)
  ) {
    fail(`Refusing to overwrite an existing category draft for ${attemptId} ${category}.`);
  }
  const digest = sha256(candidate.content);
  writeAtomicExclusive(current.paths, destinations.report, candidate.content);
  writeMissingCategoryDraftReceipt({ current, attemptId, category, content: candidate.content, now });
  const saved = reloadJob(current).drafts[category].find((entry) => entry.attemptId === attemptId);
  if (saved === undefined || saved.sha256 !== digest) fail(`Preserved category draft could not be reloaded: ${attemptId} ${category}`);
  return Object.freeze({ ...saved, report: candidate.report });
}

export function preserveCheckpointCategorySourceDraft({
  job,
  category,
  sourcePath,
  sourceReceipt,
  normalizeReport,
  validateDraft,
  attemptId,
  now = new Date(),
}) {
  const current = reloadJob(job);
  validateCategory(category);
  validateSafeId(attemptId, "Source category draft attemptId");
  assertDraftAttemptStarted(current, attemptId, category);
  if (typeof sourcePath !== "string" || !isAbsolute(sourcePath) || resolve(sourcePath) !== sourcePath) {
    fail("Source category draft sourcePath must be an absolute normalized path.");
  }
  const content = readStableSecureFile(sourcePath, `Source category draft source ${category}`, {
    maxBytes: MAX_REPORT_BYTES,
    immutable: false,
  });
  const normalizedSourceReceipt = validateCheckpointSourceBlockerReceipt(sourceReceipt, {
    snapshot: current.snapshot,
    category,
  });
  const candidate = validateCheckpointReportCandidate({
    current,
    category,
    content,
    normalizeReport,
    validateReport: validateDraft,
    label: `Source category draft source ${category}`,
    validationContext: { attemptId, sourceReceipt: normalizedSourceReceipt },
  });
  const report = candidate.report;
  const reportContent = Buffer.from(serializeJson(report), "utf8");
  if (reportContent.length > MAX_REPORT_BYTES) {
    fail(`Canonical source category draft exceeds the ${MAX_REPORT_BYTES}-byte report limit.`);
  }
  const destinations = categoryDraftPaths(current.paths, attemptId, category);
  if (
    existsSync(destinations.report)
    || existsSync(destinations.receipt)
    || existsSync(destinations.sourceEnvelope)
  ) {
    fail(`Refusing to overwrite an existing category draft for ${attemptId} ${category}.`);
  }
  const attemptStage = sourceDraftAttemptStage(
    current.attempts,
    attemptId,
    category,
    `Source category draft ${attemptId} ${category}`,
  );
  const envelope = {
    schemaVersion: CATEGORY_SOURCE_DRAFT_SCHEMA_VERSION,
    kind: "source_incomplete_category_draft",
    reportDate: current.manifest.reportDate,
    snapshotFingerprint: current.manifest.snapshotFingerprint,
    runtimeFingerprint: current.manifest.runtimeFingerprint,
    evaluationRunId: current.evaluationRunId,
    category,
    fileName: `${current.manifest.reportDate}-${category}.json`,
    reportSha256: sha256(reportContent),
    reportBytes: reportContent.length,
    report,
    sourceReceipt: normalizedSourceReceipt,
    preservedAt: isoTimestamp(now, "Source category draft preservedAt"),
    attemptId,
    attemptStage,
  };
  const envelopeContent = Buffer.from(serializeJson(envelope), "utf8");
  if (envelopeContent.length > MAX_SOURCE_DRAFT_ENVELOPE_BYTES) {
    fail("Source category draft envelope is unexpectedly large.");
  }
  writeAtomicExclusive(current.paths, destinations.sourceEnvelope, envelopeContent);
  const saved = reloadJob(current).drafts[category].find((entry) => attemptId === entry.attemptId);
  if (
    saved === undefined
    || saved.storageKind !== "source_envelope"
    || saved.sha256 !== envelope.reportSha256
  ) {
    fail(`Protected source category draft could not be reloaded: ${attemptId} ${category}`);
  }
  return saved;
}

function recoverIncompleteCategoryDrafts({ job, category, validateDraft, now }) {
  let current = reloadJob(job);
  for (const incomplete of current.incompleteDrafts.filter((entry) => entry.category === category)) {
    assertDraftAttemptStarted(current, incomplete.attemptId, category);
    const content = readStableSecureFile(
      incomplete.path,
      `Incomplete protected category draft ${incomplete.attemptId} ${category}`,
      { maxBytes: MAX_REPORT_BYTES },
    );
    validateCheckpointReportCandidate({
      current,
      category,
      content,
      validateReport: validateDraft,
      label: `Incomplete protected category draft ${incomplete.attemptId} ${category}`,
      validationContext: { attemptId: incomplete.attemptId },
    });
    writeMissingCategoryDraftReceipt({
      current,
      attemptId: incomplete.attemptId,
      category,
      content,
      now,
    });
    current = reloadJob(current);
  }
  return current;
}

export function latestCheckpointCategoryDraft({ job, category, validateDraft, now = new Date() }) {
  validateCategory(category);
  if (typeof validateDraft !== "function") fail("Category draft selection requires a validation callback.");
  const current = recoverIncompleteCategoryDrafts({ job, category, validateDraft, now });
  const draft = current.drafts[category].at(-1) ?? null;
  if (draft === null) return null;
  const validationResult = validateDraft(draft.report, {
    category,
    reportDate: current.manifest.reportDate,
    evaluationRunId: current.evaluationRunId,
    snapshot: current.snapshot,
    attemptId: draft.attemptId,
    draftSha256: draft.sha256,
    sourceReceipt: draft.sourceReceipt,
    attemptStage: draft.attemptStage,
    preservedAt: draft.preservedAt,
    storageKind: draft.storageKind,
  });
  if (validationResult === false) fail(`Protected category draft failed validation: ${draft.attemptId} ${category}`);
  return draft;
}

export function materializeCheckpointCategoryDraft({ job, draft, destination }) {
  const current = reloadJob(job);
  if (!draft || typeof draft !== "object") fail("A selected protected category draft is required.");
  validateCategory(draft.category);
  validateSafeId(draft.attemptId, "Selected category draft attemptId");
  const stored = current.drafts[draft.category].find((entry) => (
    entry.attemptId === draft.attemptId && entry.sha256 === draft.sha256
  ));
  if (stored === undefined) fail("Selected category draft is not part of this runtime-specific checkpoint job.");
  if (typeof destination !== "string" || !isAbsolute(destination) || resolve(destination) !== destination) {
    fail("Category draft destination must be an absolute normalized path.");
  }
  const parent = dirname(destination);
  assertSecureDirectory(parent, "Category draft materialization directory");
  if (readdirSync(parent).length !== 0) fail("Category draft materialization directory must start empty.");
  const expectedName = `${current.manifest.reportDate}-${draft.category}.json`;
  if (destination !== join(parent, expectedName)) fail(`Category draft destination must end in ${expectedName}.`);
  let content;
  if (stored.storageKind === "source_envelope") {
    const envelopeContent = readStableSecureFile(
      stored.path,
      `Protected source category draft ${draft.category}`,
      { maxBytes: MAX_SOURCE_DRAFT_ENVELOPE_BYTES },
    );
    const loaded = validateCategorySourceDraftEnvelope(
      parseJsonBuffer(envelopeContent, `Protected source category draft ${draft.category}`),
      current.manifest,
      current.snapshot,
      current.attempts,
      { attemptId: stored.attemptId, category: stored.category },
      `Protected source category draft ${draft.category}`,
    );
    content = loaded.reportContent;
  } else {
    content = readStableSecureFile(stored.path, `Protected category draft ${draft.category}`, {
      maxBytes: MAX_REPORT_BYTES,
    });
  }
  if (sha256(content) !== stored.sha256 || content.length !== stored.bytes) {
    fail(`Protected category draft changed before materialization: ${draft.attemptId} ${draft.category}`);
  }
  let descriptor;
  try {
    descriptor = openSync(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, MATERIALIZED_FILE_MODE);
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  assertSecureFile(destination, `Materialized category draft ${draft.category}`, {
    maxBytes: MAX_REPORT_BYTES,
    immutable: false,
  });
  return Object.freeze({ path: destination, sha256: stored.sha256, bytes: stored.bytes });
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
