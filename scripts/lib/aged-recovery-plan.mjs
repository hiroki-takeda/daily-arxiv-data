import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  ARXIV_CATEGORIES,
  ARXIV_PASTWEEK_LISTING_URLS,
  fingerprintSnapshot,
} from "./arxiv-source.mjs";

const PLAN_SCHEMA_VERSION = "1.0";
const PLAN_KIND = "aged_checkpoint_recovery_plan";
const MAX_PLAN_BYTES = 4 * 1024 * 1024;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RUN_ID_PATTERN = /^run-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/u;
const PLAN_KEYS = Object.freeze([
  "schemaVersion",
  "kind",
  "expectedLatestDate",
  "targetDate",
  "snapshotFingerprint",
  "sourceRuntimeFingerprint",
  "sourceEvaluationRunId",
  "automationRuntimeFingerprint",
  "createdAt",
  "sourceCheckpointProvenance",
  "entries",
]);
const PLAN_ENTRY_KEYS = Object.freeze([
  "selectionMode",
  "expectedLatestDate",
  "snapshot",
  "evidence",
]);
const EVIDENCE_KEYS = Object.freeze([
  "schemaVersion",
  "selectionMode",
  "expectedLatestDate",
  "targetDate",
  "targetSnapshotFingerprint",
  "officialHeadDate",
  "officialHeadFingerprint",
  "pastweekAnnouncementDates",
  "completeSnapshotDates",
]);
const PROVENANCE_KEYS = Object.freeze([
  "schemaVersion",
  "kind",
  "targetDate",
  "oldestLiveDate",
  "expectedUid",
  "snapshotFingerprint",
  "snapshotRawSha256",
  "manifestRawSha256",
  "runtimeFingerprint",
  "evaluationRunId",
  "manifestCreatedAt",
  "attemptCount",
  "family",
  "entries",
  "evidenceSha256",
]);
const PROVENANCE_ENTRY_KEYS = Object.freeze([
  "path",
  "type",
  "mode",
  "uid",
  "dev",
  "ino",
  "nlink",
  "size",
  "birthtimeNs",
  "mtimeNs",
  "ctimeNs",
  "sha256",
]);

function fail(message) {
  throw new Error(message);
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join("\0") !== wanted.join("\0")) {
    fail(`${label} must contain exactly: ${wanted.join(", ")}.`);
  }
}

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("Aged recovery plan JSON cannot contain a non-finite number.");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => {
      if (value[key] === undefined) fail("Aged recovery plan JSON cannot contain undefined values.");
      return [key, canonicalize(value[key])];
    }));
  }
  fail("Aged recovery plan must contain only plain JSON values.");
}

function serializeCanonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function validateDate(value, label) {
  const match = typeof value === "string" ? DATE_PATTERN.exec(value) : null;
  if (!match) fail(`${label} must use YYYY-MM-DD.`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    Number.isNaN(parsed.getTime())
    || parsed.getUTCFullYear() !== Number(match[1])
    || parsed.getUTCMonth() + 1 !== Number(match[2])
    || parsed.getUTCDate() !== Number(match[3])
  ) fail(`${label} must be a real calendar date.`);
  return value;
}

function immediateWeekdaySuccessor(date) {
  const cursor = new Date(`${validateDate(date, "Aged recovery boundary date")}T00:00:00Z`);
  do cursor.setUTCDate(cursor.getUTCDate() + 1);
  while ([0, 6].includes(cursor.getUTCDay()));
  return cursor.toISOString().slice(0, 10);
}

function validateSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function validateRunId(value, label) {
  if (typeof value !== "string" || !RUN_ID_PATTERN.test(value)) fail(`${label} is invalid.`);
  return value;
}

function validateTimestamp(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail(`${label} must be a canonical UTC ISO timestamp.`);
  }
  return value;
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

function validateProvenanceEntry(entry, label) {
  exactKeys(entry, PROVENANCE_ENTRY_KEYS, label);
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
  } else validateSha256(entry.sha256, `${label}.sha256`);
  return entry;
}

function validateSourceProvenance(provenance, plan) {
  exactKeys(provenance, PROVENANCE_KEYS, "Aged recovery plan source provenance");
  if (provenance.schemaVersion !== "1.0" || provenance.kind !== "aged_checkpoint_provenance") {
    fail("Aged recovery plan source provenance has an invalid schema or kind.");
  }
  validateDate(provenance.targetDate, "Aged recovery plan provenance targetDate");
  validateDate(provenance.oldestLiveDate, "Aged recovery plan provenance oldestLiveDate");
  if (!Number.isSafeInteger(provenance.expectedUid) || provenance.expectedUid !== currentUid()) {
    fail("Aged recovery plan source provenance must belong to the current user.");
  }
  for (const key of [
    "snapshotFingerprint",
    "snapshotRawSha256",
    "manifestRawSha256",
    "runtimeFingerprint",
    "evidenceSha256",
  ]) validateSha256(provenance[key], `Aged recovery plan provenance ${key}`);
  validateRunId(provenance.evaluationRunId, "Aged recovery plan provenance evaluationRunId");
  validateTimestamp(provenance.manifestCreatedAt, "Aged recovery plan provenance manifestCreatedAt");
  if (!Number.isSafeInteger(provenance.attemptCount) || provenance.attemptCount < 0) {
    fail("Aged recovery plan provenance attemptCount is invalid.");
  }
  validateProvenanceEntry(provenance.family, "Aged recovery plan provenance family");
  if (provenance.family.path !== "." || provenance.family.type !== "directory") {
    fail("Aged recovery plan provenance family must describe the family root.");
  }
  if (!Array.isArray(provenance.entries) || provenance.entries.length < 6) {
    fail("Aged recovery plan provenance entries are incomplete.");
  }
  const paths = provenance.entries.map((entry, index) => {
    validateProvenanceEntry(entry, `Aged recovery plan provenance entries[${index}]`);
    if (entry.path === ".") fail("Aged recovery plan provenance source entries may not replace the family root.");
    return entry.path;
  });
  if (new Set(paths).size !== paths.length || [...paths].sort().join("\0") !== paths.join("\0")) {
    fail("Aged recovery plan provenance entries must be unique and sorted by path.");
  }
  const { evidenceSha256, ...digestInput } = provenance;
  if (sha256(Buffer.from(serializeCanonicalJson(digestInput), "utf8")) !== evidenceSha256) {
    fail("Aged recovery plan source provenance digest is invalid.");
  }
  if (
    provenance.targetDate !== plan.targetDate
    || provenance.snapshotFingerprint !== plan.snapshotFingerprint
    || provenance.runtimeFingerprint !== plan.sourceRuntimeFingerprint
    || provenance.evaluationRunId !== plan.sourceEvaluationRunId
  ) {
    fail("Aged recovery plan source provenance does not match the plan identity.");
  }
  return provenance;
}

function validateDateArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) fail(`${label} must be a non-empty date array.`);
  value.forEach((date) => validateDate(date, label));
  if (
    new Set(value).size !== value.length
    || value.some((date, index) => index > 0 && value[index - 1] <= date)
  ) fail(`${label} must contain unique newest-to-oldest dates.`);
  return value;
}

function validateEvidence(evidence, entry, label) {
  exactKeys(evidence, EVIDENCE_KEYS, label);
  if (evidence.schemaVersion !== "1.0" || evidence.selectionMode !== entry.selectionMode) {
    fail(`${label} has an invalid schema or selection mode.`);
  }
  validateDate(evidence.expectedLatestDate, `${label}.expectedLatestDate`);
  validateDate(evidence.targetDate, `${label}.targetDate`);
  validateDate(evidence.officialHeadDate, `${label}.officialHeadDate`);
  validateSha256(evidence.targetSnapshotFingerprint, `${label}.targetSnapshotFingerprint`);
  validateSha256(evidence.officialHeadFingerprint, `${label}.officialHeadFingerprint`);
  validateDateArray(evidence.pastweekAnnouncementDates, `${label}.pastweekAnnouncementDates`);
  validateDateArray(evidence.completeSnapshotDates, `${label}.completeSnapshotDates`);
  const snapshotFingerprint = fingerprintSnapshot(entry.snapshot);
  if (
    evidence.expectedLatestDate !== entry.expectedLatestDate
    || evidence.targetDate !== entry.snapshot.announcementDate
    || evidence.targetSnapshotFingerprint !== snapshotFingerprint
    || evidence.pastweekAnnouncementDates[0] !== evidence.officialHeadDate
    || evidence.completeSnapshotDates.join("\0") !== evidence.pastweekAnnouncementDates.join("\0")
  ) fail(`${label} does not match its exact plan entry or complete official window.`);
  return evidence;
}

function validatePlanEntry(entry, index) {
  exactKeys(entry, PLAN_ENTRY_KEYS, `Aged recovery plan entries[${index}]`);
  const expectedMode = index === 0
    ? "aged_checkpoint_recovery"
    : index === 1
      ? "aged_window_continuation"
      : "normal";
  if (entry.selectionMode !== expectedMode) {
    fail(`Aged recovery plan entries[${index}] has an invalid selectionMode.`);
  }
  validateDate(entry.expectedLatestDate, `Aged recovery plan entries[${index}].expectedLatestDate`);
  const fingerprint = fingerprintSnapshot(entry.snapshot);
  for (const slug of ARXIV_CATEGORIES) {
    if (entry.snapshot.categories[slug].sourceUrl !== ARXIV_PASTWEEK_LISTING_URLS[slug]) {
      fail(`Aged recovery plan entries[${index}] must use official pastweek source URLs.`);
    }
  }
  if (!ARXIV_CATEGORIES.some((slug) => entry.snapshot.categories[slug].newCount > 0)) {
    fail(`Aged recovery plan entries[${index}] may not contain an empty publication target.`);
  }
  validateEvidence(entry.evidence, entry, `Aged recovery plan entries[${index}].evidence`);
  return fingerprint;
}

function deepFreezeJson(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function freezePlan(plan) {
  return deepFreezeJson(structuredClone(plan));
}

export function validateAgedRecoveryPlan(plan) {
  exactKeys(plan, PLAN_KEYS, "Aged recovery plan");
  if (plan.schemaVersion !== PLAN_SCHEMA_VERSION || plan.kind !== PLAN_KIND) {
    fail("Aged recovery plan has an invalid schema or kind.");
  }
  validateDate(plan.expectedLatestDate, "Aged recovery plan expectedLatestDate");
  validateDate(plan.targetDate, "Aged recovery plan targetDate");
  validateSha256(plan.snapshotFingerprint, "Aged recovery plan snapshotFingerprint");
  validateSha256(plan.sourceRuntimeFingerprint, "Aged recovery plan sourceRuntimeFingerprint");
  validateRunId(plan.sourceEvaluationRunId, "Aged recovery plan sourceEvaluationRunId");
  validateSha256(plan.automationRuntimeFingerprint, "Aged recovery plan automationRuntimeFingerprint");
  validateTimestamp(plan.createdAt, "Aged recovery plan createdAt");
  if (plan.sourceRuntimeFingerprint === plan.automationRuntimeFingerprint) {
    fail("Aged recovery plan source and destination automation runtimes must differ.");
  }
  if (!Array.isArray(plan.entries) || plan.entries.length < 1) {
    fail("Aged recovery plan requires at least one entry.");
  }

  const fingerprints = plan.entries.map(validatePlanEntry);
  const first = plan.entries[0];
  if (
    first.expectedLatestDate !== plan.expectedLatestDate
    || first.snapshot.announcementDate !== plan.targetDate
    || fingerprints[0] !== plan.snapshotFingerprint
    || plan.targetDate <= plan.expectedLatestDate
  ) fail("Aged recovery plan head does not match its fixed identity.");
  for (let index = 1; index < plan.entries.length; index += 1) {
    const previousDate = plan.entries[index - 1].snapshot.announcementDate;
    const entry = plan.entries[index];
    if (
      entry.expectedLatestDate !== previousDate
      || entry.snapshot.announcementDate <= previousDate
    ) fail(`Aged recovery plan entries[${index}] breaks the oldest-to-newest anchor chain.`);
  }

  const referenceEvidence = first.evidence;
  const announcementDates = referenceEvidence.pastweekAnnouncementDates;
  const oldestLiveDate = referenceEvidence.completeSnapshotDates.at(-1);
  for (const [index, entry] of plan.entries.entries()) {
    const evidence = entry.evidence;
    if (
      evidence.officialHeadDate !== referenceEvidence.officialHeadDate
      || evidence.officialHeadFingerprint !== referenceEvidence.officialHeadFingerprint
      || evidence.pastweekAnnouncementDates.join("\0") !== announcementDates.join("\0")
      || evidence.completeSnapshotDates.join("\0")
        !== referenceEvidence.completeSnapshotDates.join("\0")
    ) fail(`Aged recovery plan entries[${index}] does not share the sealed official window.`);
  }
  if (
    announcementDates.includes(plan.targetDate)
    || announcementDates.some((date) => date <= plan.targetDate)
    || immediateWeekdaySuccessor(plan.expectedLatestDate) !== plan.targetDate
    || immediateWeekdaySuccessor(plan.targetDate) !== oldestLiveDate
  ) fail("Aged recovery plan does not bridge the two exact weekday-successor boundaries.");
  if (plan.entries.length > 1) {
    const second = plan.entries[1];
    if (
      second.expectedLatestDate !== plan.targetDate
      || !announcementDates.includes(second.snapshot.announcementDate)
    ) fail("Aged recovery plan first live continuation does not belong to the sealed complete window.");
  }
  for (const entry of plan.entries.slice(2)) {
    if (
      !announcementDates.includes(entry.expectedLatestDate)
      || !announcementDates.includes(entry.snapshot.announcementDate)
    ) fail("Aged recovery plan normal successors must remain inside the sealed complete window.");
  }
  validateSourceProvenance(plan.sourceCheckpointProvenance, plan);
  if (plan.sourceCheckpointProvenance.oldestLiveDate !== oldestLiveDate) {
    fail("Aged recovery plan source provenance does not match the sealed oldest live date.");
  }
  return freezePlan(plan);
}

function ensureSecureDirectory(path, label) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(path);
  if (
    metadata.isSymbolicLink()
    || !metadata.isDirectory()
    || metadata.uid !== currentUid()
    || (metadata.mode & 0o777) !== 0o700
    || realpathSync(path) !== resolve(path)
  ) fail(`${label} must be an owned canonical 0700 directory: ${path}`);
}

function readStablePlan(path) {
  const beforePath = lstatSync(path);
  if (
    beforePath.isSymbolicLink()
    || !beforePath.isFile()
    || beforePath.uid !== currentUid()
    || (beforePath.mode & 0o777) !== 0o600
    || realpathSync(path) !== resolve(path)
  ) fail(`Aged recovery plan must be an owned canonical 0600 file: ${path}`);
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(descriptor);
    if (before.size > MAX_PLAN_BYTES) fail(`Aged recovery plan exceeds ${MAX_PLAN_BYTES} bytes.`);
    const content = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const finalPath = lstatSync(path);
    if (
      beforePath.dev !== before.dev
      || beforePath.ino !== before.ino
      || beforePath.uid !== before.uid
      || beforePath.mode !== before.mode
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || after.dev !== finalPath.dev
      || after.ino !== finalPath.ino
      || after.uid !== currentUid()
      || (after.mode & 0o777) !== 0o600
      || finalPath.uid !== currentUid()
      || (finalPath.mode & 0o777) !== 0o600
      || content.length !== after.size
    ) fail(`Aged recovery plan changed while being read: ${path}`);
    return content;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readPlanFile(path, expectedDigest) {
  const content = readStablePlan(path);
  if (sha256(content) !== expectedDigest) {
    fail(`Aged recovery plan digest does not match its filename: ${path}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(content.toString("utf8"));
  } catch (error) {
    fail(`Aged recovery plan is not valid JSON: ${error.message}`);
  }
  const plan = validateAgedRecoveryPlan(parsed);
  if (!content.equals(Buffer.from(serializeCanonicalJson(plan), "utf8"))) {
    fail(`Aged recovery plan is not canonical immutable content: ${path}`);
  }
  return plan;
}

export function loadActiveAgedRecoveryPlan({
  directory,
  latestDate,
  automationRuntimeFingerprint,
} = {}) {
  validateDate(latestDate, "Aged recovery plan public latestDate");
  validateSha256(automationRuntimeFingerprint, "Aged recovery plan automation runtime fingerprint");
  ensureSecureDirectory(directory, "Aged recovery plan directory");
  const records = readdirSync(directory).sort().map((name) => {
    const match = /^([a-f0-9]{64})\.json$/u.exec(name);
    if (!match) fail(`Unexpected aged recovery plan entry: ${name}`);
    const path = join(directory, name);
    return Object.freeze({ path, sha256: match[1], plan: readPlanFile(path, match[1]) });
  });
  const byAnchor = new Map();
  for (const record of records) {
    const anchor = record.plan.expectedLatestDate;
    if (byAnchor.has(anchor)) fail(`Multiple aged recovery plans target public latestDate ${anchor}.`);
    byAnchor.set(anchor, record);
  }
  const active = byAnchor.get(latestDate) ?? null;
  if (
    active !== null
    && active.plan.automationRuntimeFingerprint !== automationRuntimeFingerprint
  ) {
    fail("Automation runtime changed while an aged recovery plan is active; manual review is required.");
  }
  return Object.freeze({ active, records: Object.freeze(records) });
}

export function createAgedRecoveryPlan({
  directory,
  stagingDirectory = join(dirname(directory), "aged-recovery-plan-staging"),
  expectedLatestDate,
  sourceJob,
  automationRuntimeFingerprint,
  sourceCheckpointProvenance,
  entries,
  now = new Date(),
  publishLink = linkSync,
  removeStaged = unlinkSync,
} = {}) {
  ensureSecureDirectory(directory, "Aged recovery plan directory");
  ensureSecureDirectory(stagingDirectory, "Aged recovery plan staging directory");
  if (statSync(directory).dev !== statSync(stagingDirectory).dev) {
    fail("Aged recovery plan staging must be on the same filesystem as its active directory.");
  }
  if (!sourceJob || typeof sourceJob !== "object" || !sourceJob.manifest) {
    fail("A loaded source checkpoint job is required for an aged recovery plan.");
  }
  if (!Array.isArray(entries) || entries.length < 1) {
    fail("Aged recovery plan creation requires its complete entry queue.");
  }
  if (typeof publishLink !== "function" || typeof removeStaged !== "function") {
    fail("Aged recovery plan filesystem operations must be functions.");
  }
  const first = entries[0];
  const candidate = validateAgedRecoveryPlan({
    schemaVersion: PLAN_SCHEMA_VERSION,
    kind: PLAN_KIND,
    expectedLatestDate,
    targetDate: first.snapshot.announcementDate,
    snapshotFingerprint: fingerprintSnapshot(first.snapshot),
    sourceRuntimeFingerprint: sourceJob.manifest.runtimeFingerprint,
    sourceEvaluationRunId: sourceJob.evaluationRunId,
    automationRuntimeFingerprint,
    createdAt: new Date(now).toISOString(),
    sourceCheckpointProvenance,
    entries,
  });
  if (
    sourceJob.manifest.reportDate !== candidate.targetDate
    || sourceJob.manifest.snapshotFingerprint !== candidate.snapshotFingerprint
  ) fail("Aged recovery plan source checkpoint does not match its selected target snapshot.");

  const content = Buffer.from(serializeCanonicalJson(candidate), "utf8");
  if (content.length > MAX_PLAN_BYTES) fail("Aged recovery plan is unexpectedly large.");
  const digest = sha256(content);
  const destination = join(directory, `${digest}.json`);
  const temporary = join(
    stagingDirectory,
    `${digest}.${process.pid}.${randomBytes(16).toString("hex")}.staged`,
  );
  let descriptor;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  let published = false;
  try {
    publishLink(temporary, destination);
    published = true;
    const directoryDescriptor = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
    removeStaged(temporary);
    const stagingDescriptor = openSync(
      stagingDirectory,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
    );
    try {
      fsyncSync(stagingDescriptor);
    } finally {
      closeSync(stagingDescriptor);
    }
    return Object.freeze({
      path: destination,
      sha256: digest,
      plan: readPlanFile(destination, digest),
    });
  } catch (error) {
    if (published) {
      try {
        unlinkSync(destination);
        const directoryDescriptor = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
        try {
          fsyncSync(directoryDescriptor);
        } finally {
          closeSync(directoryDescriptor);
        }
      } catch (rollbackError) {
        error.message += `; newly published aged recovery plan rollback failed (${rollbackError.message})`;
      }
    }
    throw error;
  }
}
