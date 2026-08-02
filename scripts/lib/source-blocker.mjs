export const SOURCE_BLOCKER_SCHEMA_VERSION = "1.0";
export const SOURCE_BLOCKER_STATUS = "source_incomplete";
export const SOURCE_BLOCKER_MESSAGE_PREFIX = "DAILY_ARXIV_SOURCE_BLOCKER_V1:";
export const SOURCE_RETRY_BACKOFF_HOURS = Object.freeze([18, 36, 72]);
export const MODEL_SOURCE_FAILURE_CLASS = "all_official_full_text_pathways_unavailable";
export const HOST_SOURCE_PROBE_FAILURE_CLASS = "host_source_probe_failed";
export const ORPHANED_GENERATION_STALE_HOURS = 5;

const ARXIV_ID_PATTERN = /^\d{4}\.\d{4,5}$/u;
const FAILURE_CLASS_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const CATEGORIES = Object.freeze(["quant-ph", "gr-qc", "hep-th"]);
const MAX_EVENT_MESSAGE_LENGTH = 2_000;
const MILLISECONDS_PER_HOUR = 60 * 60 * 1_000;
export const ORPHANED_GENERATION_STALE_MS = ORPHANED_GENERATION_STALE_HOURS * MILLISECONDS_PER_HOUR;
const EVENT_FAILURE_CLASSES = new Set([
  MODEL_SOURCE_FAILURE_CLASS,
  HOST_SOURCE_PROBE_FAILURE_CLASS,
]);
const RECEIPT_KEYS = Object.freeze([
  "schemaVersion",
  "status",
  "arxivId",
  "failureClass",
  "provisionalCandidateIds",
]);
const EVENT_PAYLOAD_KEYS = Object.freeze([
  "schemaVersion",
  "kind",
  "observedAt",
  "receipt",
]);

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function requirePlainObject(value, label) {
  if (!isPlainObject(value)) fail(`${label} must be a plain JSON object.`);
  return value;
}

function requireExactKeys(value, expected, label) {
  requirePlainObject(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join("\0") !== wanted.join("\0")) {
    fail(`${label} must contain exactly: ${wanted.join(", ")}.`);
  }
}

function requireArxivId(value, label) {
  if (typeof value !== "string" || !ARXIV_ID_PATTERN.test(value)) {
    fail(`${label} must be an unversioned modern arXiv ID.`);
  }
  return value;
}

function requireCategory(value) {
  if (!CATEGORIES.includes(value)) fail(`Unsupported Daily arXiv category: ${String(value)}`);
  return value;
}

function canonicalTimestamp(value, label) {
  const parsed = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (parsed === null || Number.isNaN(parsed.getTime())) fail(`${label} must be a valid timestamp.`);
  const canonical = parsed.toISOString();
  if (typeof value === "string" && value !== canonical) {
    fail(`${label} must be a canonical UTC ISO timestamp.`);
  }
  return canonical;
}

function freezeReceipt(receipt) {
  return Object.freeze({
    schemaVersion: receipt.schemaVersion,
    status: receipt.status,
    arxivId: receipt.arxivId,
    failureClass: receipt.failureClass,
    provisionalCandidateIds: Object.freeze([...receipt.provisionalCandidateIds]),
  });
}

function validateReceiptShape(receipt, label = "Source-incomplete receipt") {
  requireExactKeys(receipt, RECEIPT_KEYS, label);
  if (receipt.schemaVersion !== SOURCE_BLOCKER_SCHEMA_VERSION) {
    fail(`${label}.schemaVersion must be ${SOURCE_BLOCKER_SCHEMA_VERSION}.`);
  }
  if (receipt.status !== SOURCE_BLOCKER_STATUS) {
    fail(`${label}.status must be ${SOURCE_BLOCKER_STATUS}.`);
  }
  requireArxivId(receipt.arxivId, `${label}.arxivId`);
  if (typeof receipt.failureClass !== "string" || !FAILURE_CLASS_PATTERN.test(receipt.failureClass)) {
    fail(`${label}.failureClass must be a lowercase safe identifier of at most 64 characters.`);
  }
  if (!EVENT_FAILURE_CLASSES.has(receipt.failureClass)) {
    fail(
      `${label}.failureClass must be one of the fixed host-reviewed source failure classes: `
      + `${[...EVENT_FAILURE_CLASSES].join(", ")}.`,
    );
  }
  if (!Array.isArray(receipt.provisionalCandidateIds)) {
    fail(`${label}.provisionalCandidateIds must be an array.`);
  }
  for (const [index, arxivId] of receipt.provisionalCandidateIds.entries()) {
    requireArxivId(arxivId, `${label}.provisionalCandidateIds[${index}]`);
  }
  if (new Set(receipt.provisionalCandidateIds).size !== receipt.provisionalCandidateIds.length) {
    fail(`${label}.provisionalCandidateIds must not contain duplicates.`);
  }
  return freezeReceipt(receipt);
}

function categorySnapshotContract(snapshot, category) {
  requirePlainObject(snapshot, "Official arXiv snapshot");
  requireCategory(category);
  requirePlainObject(snapshot.categories, "Official arXiv snapshot categories");
  const record = snapshot.categories[category];
  requirePlainObject(record, `Official arXiv snapshot category ${category}`);
  if (!Number.isSafeInteger(record.newCount) || record.newCount < 0) {
    fail(`Official arXiv snapshot category ${category}.newCount must be a non-negative safe integer.`);
  }
  if (!Array.isArray(record.newIds) || record.newIds.length !== record.newCount) {
    fail(`Official arXiv snapshot category ${category}.newIds must contain exactly newCount IDs.`);
  }
  for (const [index, arxivId] of record.newIds.entries()) {
    requireArxivId(arxivId, `Official arXiv snapshot category ${category}.newIds[${index}]`);
  }
  const ids = new Set(record.newIds);
  if (ids.size !== record.newIds.length) {
    fail(`Official arXiv snapshot category ${category}.newIds must not contain duplicates.`);
  }
  return Object.freeze({
    newCount: record.newCount,
    newIds: ids,
    requiredCandidateCount: Math.min(12, record.newCount),
  });
}

function validateReceiptAgainstSnapshot(receipt, { snapshot, category } = {}) {
  const normalized = validateReceiptShape(receipt);
  const contract = categorySnapshotContract(snapshot, category);
  if (normalized.provisionalCandidateIds.length !== contract.requiredCandidateCount) {
    fail(
      "Source-incomplete receipt.provisionalCandidateIds must contain exactly "
      + `min(12, totalNew)=${contract.requiredCandidateCount} IDs.`,
    );
  }
  for (const arxivId of normalized.provisionalCandidateIds) {
    if (!contract.newIds.has(arxivId)) {
      fail(`Source-incomplete receipt candidate ${arxivId} is outside the official ${category} snapshot.`);
    }
  }
  if (!normalized.provisionalCandidateIds.includes(normalized.arxivId)) {
    fail("Source-incomplete receipt.arxivId must be one of its provisionalCandidateIds.");
  }
  return normalized;
}

/**
 * Validates the model's deliberately small terminal SOURCE_INCOMPLETE receipt
 * against the host-owned official snapshot. The receipt contains no timestamp;
 * host code adds that only after this validation succeeds.
 */
export function validateModelSourceIncompleteReceipt(receipt, { snapshot, category } = {}) {
  const normalized = validateReceiptAgainstSnapshot(receipt, { snapshot, category });
  if (normalized.failureClass !== MODEL_SOURCE_FAILURE_CLASS) {
    fail(
      `Model source-incomplete receipt.failureClass must be exactly ${MODEL_SOURCE_FAILURE_CLASS}.`,
    );
  }
  return normalized;
}

/**
 * Revalidates a receipt already loaded from host-owned immutable checkpoint
 * history. Unlike model staging validation, this path accepts either the sole
 * model class or the host-generated source-probe class.
 */
export function validateCheckpointSourceBlockerReceipt(receipt, { snapshot, category } = {}) {
  return validateReceiptAgainstSnapshot(receipt, { snapshot, category });
}

/**
 * Creates the separate host-only receipt used after a token-free source probe
 * fails. Model output is never accepted through this path: callers supply a
 * previously validated receipt plus the exact failed candidate, while this
 * function fixes the host failure class itself.
 */
export function createHostSourceProbeFailureReceipt(
  sourceReceipt,
  { snapshot, category, failedArxivId } = {},
) {
  const normalized = validateCheckpointSourceBlockerReceipt(sourceReceipt, { snapshot, category });
  requireArxivId(failedArxivId, "Host source probe failedArxivId");
  if (!normalized.provisionalCandidateIds.includes(failedArxivId)) {
    fail("Host source probe failedArxivId must be one of the fixed provisional candidates.");
  }
  return validateCheckpointSourceBlockerReceipt({
    ...normalized,
    arxivId: failedArxivId,
    failureClass: HOST_SOURCE_PROBE_FAILURE_CLASS,
  }, {
    snapshot,
    category,
  });
}

/**
 * Encodes a validated model receipt with a host-supplied observation time for
 * storage in the existing checkpoint attempt.message field.
 */
export function encodeSourceBlockerEventMessage(receipt, { observedAt } = {}) {
  const normalized = validateReceiptShape(receipt);
  const payload = {
    schemaVersion: SOURCE_BLOCKER_SCHEMA_VERSION,
    kind: "source_blocker",
    observedAt: canonicalTimestamp(observedAt, "Source blocker observedAt"),
    receipt: normalized,
  };
  const message = `${SOURCE_BLOCKER_MESSAGE_PREFIX}${JSON.stringify(payload)}`;
  if (
    message.length > MAX_EVENT_MESSAGE_LENGTH
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(message)
  ) {
    fail(`Source blocker event message must be at most ${MAX_EVENT_MESSAGE_LENGTH} safe characters.`);
  }
  return message;
}

/**
 * Strictly decodes only a complete source-blocker message. It returns null for
 * ordinary checkpoint messages and throws for a malformed message using the
 * reserved prefix.
 */
export function decodeSourceBlockerEventMessage(message) {
  if (typeof message !== "string") fail("Checkpoint attempt message must be a string.");
  if (!message.startsWith(SOURCE_BLOCKER_MESSAGE_PREFIX)) return null;
  if (
    message.length > MAX_EVENT_MESSAGE_LENGTH
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(message)
  ) {
    fail("Source blocker event message is unsafe or too long.");
  }
  let payload;
  try {
    payload = JSON.parse(message.slice(SOURCE_BLOCKER_MESSAGE_PREFIX.length));
  } catch (error) {
    fail(`Source blocker event message is not valid JSON: ${error.message}`);
  }
  requireExactKeys(payload, EVENT_PAYLOAD_KEYS, "Source blocker event payload");
  if (
    payload.schemaVersion !== SOURCE_BLOCKER_SCHEMA_VERSION
    || payload.kind !== "source_blocker"
  ) {
    fail("Source blocker event payload has an invalid schema or kind.");
  }
  const observedAt = canonicalTimestamp(payload.observedAt, "Source blocker event payload.observedAt");
  const receipt = validateReceiptShape(payload.receipt, "Source blocker event payload.receipt");
  return Object.freeze({
    schemaVersion: SOURCE_BLOCKER_SCHEMA_VERSION,
    kind: "source_blocker",
    observedAt,
    receipt,
  });
}

function inactiveRetryState() {
  return Object.freeze({
    active: false,
    shouldDefer: false,
    kind: null,
    failureCount: 0,
    sourceFailureCount: 0,
    delayHours: 0,
    delayMs: 0,
    observedAt: null,
    retryAt: null,
    remainingMs: 0,
    latestAttemptId: null,
    sourceBlocker: null,
  });
}

function normalizedAttemptEvent(event, index) {
  requirePlainObject(event, `Checkpoint attempt[${index}]`);
  if (event.category !== null && (typeof event.category !== "string" || !CATEGORIES.includes(event.category))) {
    fail(`Checkpoint attempt[${index}].category is invalid.`);
  }
  if (typeof event.stage !== "string" || event.stage === "") {
    fail(`Checkpoint attempt[${index}].stage is invalid.`);
  }
  if (typeof event.status !== "string" || event.status === "") {
    fail(`Checkpoint attempt[${index}].status is invalid.`);
  }
  if (typeof event.attemptId !== "string" || event.attemptId === "") {
    fail(`Checkpoint attempt[${index}].attemptId is invalid.`);
  }
  if (typeof event.message !== "string") {
    fail(`Checkpoint attempt[${index}].message is invalid.`);
  }
  const at = canonicalTimestamp(event.at, `Checkpoint attempt[${index}].at`);
  const sourceBlocker = decodeSourceBlockerEventMessage(event.message);
  return Object.freeze({ ...event, at, sourceBlocker, originalIndex: index });
}

/**
 * Computes retry suppression from immutable checkpoint attempt history.
 *
 * A completed category event clears preceding failures. Thereafter, each
 * distinct failed attempt counts once when it is a category_generation,
 * category_source_resume, or category_repair failure; carries a structured
 * source-blocker message; or is a generation/source-resume start that still
 * lacks any terminal event after the same five-hour interval used for stale
 * automation locks. Repair failures are counted so a bounded repair sequence
 * cannot fall through to an immediate full regeneration. Duplicate audit
 * events for one attemptId cannot accelerate the backoff.
 */
export function computeSourceRetryBackoff({ attempts, category, now = new Date() } = {}) {
  if (!Array.isArray(attempts)) fail("Checkpoint attempts must be an array.");
  requireCategory(category);
  const nowIso = canonicalTimestamp(now, "Retry computation now");
  const nowMs = Date.parse(nowIso);
  const events = attempts
    .map(normalizedAttemptEvent)
    .filter((event) => event.category === category)
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at) || left.originalIndex - right.originalIndex);

  let failures = new Map();
  let pendingGenerationStarts = new Map();
  for (const event of events) {
    if (event.status === "completed") {
      failures = new Map();
      pendingGenerationStarts = new Map();
      continue;
    }
    if (
      event.status === "started"
      && ["category_generation", "category_source_resume"].includes(event.stage)
    ) {
      pendingGenerationStarts.set(event.attemptId, Object.freeze({
        attemptId: event.attemptId,
        eventAt: event.at,
        observedAt: event.at,
        kind: "generation_failure",
        sourceBlocker: null,
        originalIndex: event.originalIndex,
      }));
      continue;
    }
    if (event.status === "failed") {
      // Any explicit terminal failure for the same attempt means its started
      // event is not an orphan, even when the terminal stage itself is not a
      // retry-counted generation failure.
      pendingGenerationStarts.delete(event.attemptId);
    }
    const isSourceBlocker = event.status === "failed" && event.sourceBlocker !== null;
    const isOrdinaryRetryFailure = event.status === "failed"
      && ["category_generation", "category_source_resume", "category_repair"].includes(event.stage);
    if (!isSourceBlocker && !isOrdinaryRetryFailure) continue;
    const observedAt = isSourceBlocker ? event.sourceBlocker.observedAt : event.at;
    const candidate = Object.freeze({
      attemptId: event.attemptId,
      eventAt: event.at,
      observedAt,
      kind: isSourceBlocker
        ? SOURCE_BLOCKER_STATUS
        : event.stage === "category_repair"
          ? "repair_failure"
          : "generation_failure",
      sourceBlocker: event.sourceBlocker,
      originalIndex: event.originalIndex,
    });
    const previous = failures.get(event.attemptId);
    if (
      previous === undefined
      || (candidate.sourceBlocker !== null && previous.sourceBlocker === null)
      || (
        (candidate.sourceBlocker === null) === (previous.sourceBlocker === null)
        && (
          Date.parse(candidate.observedAt) > Date.parse(previous.observedAt)
          || (
            candidate.observedAt === previous.observedAt
            && candidate.originalIndex > previous.originalIndex
          )
        )
      )
    ) {
      failures.set(event.attemptId, candidate);
    }
  }
  for (const orphan of pendingGenerationStarts.values()) {
    if (Date.parse(orphan.observedAt) + ORPHANED_GENERATION_STALE_MS > nowMs) continue;
    if (!failures.has(orphan.attemptId)) failures.set(orphan.attemptId, orphan);
  }
  if (failures.size === 0) return inactiveRetryState();

  const orderedFailures = [...failures.values()].sort(
    (left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt)
      || left.originalIndex - right.originalIndex,
  );
  const latest = orderedFailures.at(-1);
  const failureCount = orderedFailures.length;
  const sourceFailureCount = orderedFailures.filter(({ sourceBlocker }) => sourceBlocker !== null).length;
  const delayHours = SOURCE_RETRY_BACKOFF_HOURS[
    Math.min(failureCount - 1, SOURCE_RETRY_BACKOFF_HOURS.length - 1)
  ];
  const delayMs = delayHours * MILLISECONDS_PER_HOUR;
  const retryAtMs = Date.parse(latest.observedAt) + delayMs;
  const remainingMs = Math.max(0, retryAtMs - nowMs);
  return Object.freeze({
    active: true,
    shouldDefer: remainingMs > 0,
    kind: latest.kind,
    failureCount,
    sourceFailureCount,
    delayHours,
    delayMs,
    observedAt: latest.observedAt,
    retryAt: new Date(retryAtMs).toISOString(),
    remainingMs,
    latestAttemptId: latest.attemptId,
    sourceBlocker: latest.sourceBlocker,
  });
}
