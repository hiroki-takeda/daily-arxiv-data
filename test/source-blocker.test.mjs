import assert from "node:assert/strict";
import test from "node:test";
import {
  HOST_SOURCE_PROBE_FAILURE_CLASS,
  MODEL_SOURCE_FAILURE_CLASS,
  ORPHANED_GENERATION_STALE_HOURS,
  SOURCE_BLOCKER_MESSAGE_PREFIX,
  computeSourceRetryBackoff,
  createHostSourceProbeFailureReceipt,
  decodeSourceBlockerEventMessage,
  encodeSourceBlockerEventMessage,
  validateCheckpointSourceBlockerReceipt,
  validateModelSourceIncompleteReceipt,
} from "../scripts/lib/source-blocker.mjs";

const CATEGORY = "quant-ph";
const IDS = Object.freeze(Array.from({ length: 15 }, (_, index) => `2607.${String(index + 1).padStart(5, "0")}`));
const SNAPSHOT = Object.freeze({
  announcementDate: "2026-07-27",
  categories: Object.freeze({
    "quant-ph": Object.freeze({
      slug: "quant-ph",
      newCount: IDS.length,
      newIds: IDS,
    }),
    "gr-qc": Object.freeze({
      slug: "gr-qc",
      newCount: 1,
      newIds: Object.freeze(["2607.10001"]),
    }),
    "hep-th": Object.freeze({
      slug: "hep-th",
      newCount: 1,
      newIds: Object.freeze(["2607.20001"]),
    }),
  }),
});
const CANDIDATES = Object.freeze(IDS.slice(0, 12));
const RECEIPT = Object.freeze({
  schemaVersion: "1.0",
  status: "source_incomplete",
  arxivId: CANDIDATES[3],
  failureClass: MODEL_SOURCE_FAILURE_CLASS,
  provisionalCandidateIds: CANDIDATES,
});

function attempt({
  at,
  attemptId,
  category = CATEGORY,
  stage = "category_generation",
  status = "failed",
  message = "Category generation failed without a reusable draft.",
}) {
  return { at, attemptId, category, stage, status, message };
}

test("model source-incomplete receipt is exact and bound to the snapshot candidate set", () => {
  const validated = validateModelSourceIncompleteReceipt(RECEIPT, {
    snapshot: SNAPSHOT,
    category: CATEGORY,
  });
  assert.deepEqual(validated, RECEIPT);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.provisionalCandidateIds), true);
});

test("candidate count is exactly min(12, totalNew) for small categories", () => {
  const receipt = {
    schemaVersion: "1.0",
    status: "source_incomplete",
    arxivId: "2607.10001",
    failureClass: MODEL_SOURCE_FAILURE_CLASS,
    provisionalCandidateIds: ["2607.10001"],
  };
  assert.doesNotThrow(() => validateModelSourceIncompleteReceipt(receipt, {
    snapshot: SNAPSHOT,
    category: "gr-qc",
  }));
});

test("receipt rejects extra keys, invalid identity, duplicates, wrong count, and out-of-snapshot IDs", () => {
  const cases = [
    [{ ...RECEIPT, note: "untrusted prose" }, /contain exactly/],
    [{ ...RECEIPT, schemaVersion: "2.0" }, /schemaVersion/],
    [{ ...RECEIPT, status: "failed" }, /status/],
    [{ ...RECEIPT, failureClass: "Network Error" }, /failureClass/],
    [{ ...RECEIPT, failureClass: HOST_SOURCE_PROBE_FAILURE_CLASS }, /must be exactly/],
    [{ ...RECEIPT, failureClass: "schema_failure" }, /fixed host-reviewed/],
    [{ ...RECEIPT, arxivId: "2607.99999" }, /one of its provisionalCandidateIds/],
    [{ ...RECEIPT, provisionalCandidateIds: [...CANDIDATES.slice(0, 11), CANDIDATES[0]] }, /duplicates/],
    [{ ...RECEIPT, provisionalCandidateIds: CANDIDATES.slice(0, 11) }, /min\(12, totalNew\)/],
    [{
      ...RECEIPT,
      provisionalCandidateIds: [...CANDIDATES.slice(0, 11), "2607.99999"],
    }, /outside the official/],
  ];
  for (const [receipt, expected] of cases) {
    assert.throws(
      () => validateModelSourceIncompleteReceipt(receipt, { snapshot: SNAPSHOT, category: CATEGORY }),
      expected,
    );
  }
});

test("host source-probe failures use a separate fixed construction path", () => {
  const failedArxivId = CANDIDATES[5];
  const receipt = createHostSourceProbeFailureReceipt(RECEIPT, {
    snapshot: SNAPSHOT,
    category: CATEGORY,
    failedArxivId,
  });
  assert.deepEqual(receipt, {
    ...RECEIPT,
    arxivId: failedArxivId,
    failureClass: HOST_SOURCE_PROBE_FAILURE_CLASS,
  });
  assert.throws(
    () => validateModelSourceIncompleteReceipt(receipt, {
      snapshot: SNAPSHOT,
      category: CATEGORY,
    }),
    /must be exactly/,
  );
  assert.deepEqual(validateCheckpointSourceBlockerReceipt(receipt, {
    snapshot: SNAPSHOT,
    category: CATEGORY,
  }), receipt);
  assert.throws(
    () => createHostSourceProbeFailureReceipt(RECEIPT, {
      snapshot: SNAPSHOT,
      category: CATEGORY,
      failedArxivId: "2607.99999",
    }),
    /fixed provisional candidates/,
  );
  const message = encodeSourceBlockerEventMessage(receipt, {
    observedAt: new Date("2026-07-27T09:02:18.957Z"),
  });
  assert.equal(
    decodeSourceBlockerEventMessage(message).receipt.failureClass,
    HOST_SOURCE_PROBE_FAILURE_CLASS,
  );
});

test("snapshot contract is independently checked before accepting a receipt", () => {
  const wrongCount = structuredClone(SNAPSHOT);
  wrongCount.categories[CATEGORY].newCount += 1;
  assert.throws(
    () => validateModelSourceIncompleteReceipt(RECEIPT, { snapshot: wrongCount, category: CATEGORY }),
    /newIds must contain exactly newCount/,
  );
  assert.throws(
    () => validateModelSourceIncompleteReceipt(RECEIPT, { snapshot: SNAPSHOT, category: "astro-ph" }),
    /Unsupported/,
  );
});

test("event message round-trips the validated receipt with a host timestamp", () => {
  const observedAt = new Date("2026-07-27T09:02:18.957Z");
  const message = encodeSourceBlockerEventMessage(RECEIPT, { observedAt });
  assert.equal(message.startsWith(SOURCE_BLOCKER_MESSAGE_PREFIX), true);
  assert.ok(message.length < 2_000);
  const decoded = decodeSourceBlockerEventMessage(message);
  assert.deepEqual(decoded, {
    schemaVersion: "1.0",
    kind: "source_blocker",
    observedAt: observedAt.toISOString(),
    receipt: RECEIPT,
  });
  assert.equal(Object.isFrozen(decoded), true);
  assert.equal(Object.isFrozen(decoded.receipt), true);
  assert.equal(decodeSourceBlockerEventMessage("ordinary generation failure"), null);
});

test("event decoder rejects malformed reserved messages, noncanonical time, and extra payload keys", () => {
  assert.throws(
    () => decodeSourceBlockerEventMessage(`${SOURCE_BLOCKER_MESSAGE_PREFIX}{`),
    /not valid JSON/,
  );
  const valid = JSON.parse(encodeSourceBlockerEventMessage(RECEIPT, {
    observedAt: new Date("2026-07-27T09:02:18.957Z"),
  }).slice(SOURCE_BLOCKER_MESSAGE_PREFIX.length));
  assert.throws(
    () => decodeSourceBlockerEventMessage(
      `${SOURCE_BLOCKER_MESSAGE_PREFIX}${JSON.stringify({ ...valid, extra: true })}`,
    ),
    /contain exactly/,
  );
  assert.throws(
    () => decodeSourceBlockerEventMessage(
      `${SOURCE_BLOCKER_MESSAGE_PREFIX}${JSON.stringify({
        ...valid,
        observedAt: "2026-07-27T09:02:18Z",
      })}`,
    ),
    /canonical UTC ISO/,
  );
  assert.throws(
    () => decodeSourceBlockerEventMessage(`${SOURCE_BLOCKER_MESSAGE_PREFIX}${" ".repeat(2_000)}`),
    /unsafe or too long/,
  );
});

test("one ordinary category-generation failure defers for 18 hours", () => {
  const state = computeSourceRetryBackoff({
    attempts: [attempt({
      at: "2026-07-27T09:00:00.000Z",
      attemptId: "run-one",
    })],
    category: CATEGORY,
    now: new Date("2026-07-27T10:00:00.000Z"),
  });
  assert.equal(state.active, true);
  assert.equal(state.shouldDefer, true);
  assert.equal(state.kind, "generation_failure");
  assert.equal(state.failureCount, 1);
  assert.equal(state.delayHours, 18);
  assert.equal(state.retryAt, "2026-07-28T03:00:00.000Z");
  assert.equal(state.remainingMs, 17 * 60 * 60 * 1_000);
});

test("ordinary and orphaned source-resume failures use the same bounded backoff", () => {
  const started = attempt({
    at: "2026-07-27T09:00:00.000Z",
    attemptId: "run-source-resume-terminal",
    stage: "category_source_resume",
    status: "started",
    message: `SOURCE_RESUME_DRAFT_SHA256=${"a".repeat(64)}; resumed fixed candidates`,
  });
  const failed = attempt({
    at: "2026-07-27T10:00:00.000Z",
    attemptId: "run-source-resume-terminal",
    stage: "category_source_resume",
    status: "failed",
    message: "Source resume timed out before a new receipt or complete draft was produced.",
  });
  const terminal = computeSourceRetryBackoff({
    attempts: [started, failed],
    category: CATEGORY,
    now: new Date("2026-07-27T11:00:00.000Z"),
  });
  assert.equal(terminal.active, true);
  assert.equal(terminal.shouldDefer, true);
  assert.equal(terminal.failureCount, 1);
  assert.equal(terminal.delayHours, 18);
  assert.equal(terminal.observedAt, failed.at);

  const orphaned = computeSourceRetryBackoff({
    attempts: [attempt({
      at: "2026-07-27T09:00:00.000Z",
      attemptId: "run-source-resume-orphan",
      stage: "category_source_resume",
      status: "started",
      message: `SOURCE_RESUME_DRAFT_SHA256=${"b".repeat(64)}; resumed fixed candidates`,
    })],
    category: CATEGORY,
    now: new Date("2026-07-27T14:00:00.000Z"),
  });
  assert.equal(orphaned.active, true);
  assert.equal(orphaned.shouldDefer, true);
  assert.equal(orphaned.failureCount, 1);
  assert.equal(orphaned.delayHours, 18);
  assert.equal(orphaned.observedAt, "2026-07-27T09:00:00.000Z");
});

test("backoff advances 18h, 36h, then caps at 72h across distinct failed attempts", () => {
  const attempts = [
    attempt({ at: "2026-07-27T01:00:00.000Z", attemptId: "run-one" }),
    attempt({ at: "2026-07-27T02:00:00.000Z", attemptId: "run-two" }),
    attempt({ at: "2026-07-27T03:00:00.000Z", attemptId: "run-three" }),
    attempt({ at: "2026-07-27T04:00:00.000Z", attemptId: "run-four" }),
  ];
  assert.equal(computeSourceRetryBackoff({
    attempts: attempts.slice(0, 1),
    category: CATEGORY,
    now: new Date("2026-07-27T04:00:00.000Z"),
  }).delayHours, 18);
  assert.equal(computeSourceRetryBackoff({
    attempts: attempts.slice(0, 2),
    category: CATEGORY,
    now: new Date("2026-07-27T04:00:00.000Z"),
  }).delayHours, 36);
  assert.equal(computeSourceRetryBackoff({
    attempts: attempts.slice(0, 3),
    category: CATEGORY,
    now: new Date("2026-07-27T04:00:00.000Z"),
  }).delayHours, 72);
  assert.equal(computeSourceRetryBackoff({
    attempts,
    category: CATEGORY,
    now: new Date("2026-07-27T04:00:00.000Z"),
  }).delayHours, 72);
});

test("structured blocker uses its host observation time and is exposed to orchestration", () => {
  const message = encodeSourceBlockerEventMessage(RECEIPT, {
    observedAt: new Date("2026-07-27T09:02:18.957Z"),
  });
  const state = computeSourceRetryBackoff({
    attempts: [attempt({
      at: "2026-07-27T09:02:20.000Z",
      attemptId: "run-source",
      message,
    })],
    category: CATEGORY,
    now: new Date("2026-07-27T09:17:18.956Z"),
  });
  assert.equal(state.kind, "source_incomplete");
  assert.equal(state.delayHours, 0.25);
  assert.equal(state.observedAt, "2026-07-27T09:02:18.957Z");
  assert.equal(state.retryAt, "2026-07-27T09:17:18.957Z");
  assert.equal(state.shouldDefer, true);
  assert.equal(state.remainingMs, 1);
  assert.equal(state.sourceBlocker.receipt.arxivId, RECEIPT.arxivId);

  const elapsed = computeSourceRetryBackoff({
    attempts: [attempt({
      at: "2026-07-27T09:02:20.000Z",
      attemptId: "run-source",
      message,
    })],
    category: CATEGORY,
    now: new Date("2026-07-27T09:17:18.957Z"),
  });
  assert.equal(elapsed.shouldDefer, false);
  assert.equal(elapsed.remainingMs, 0);
});

test("token-free source probes retry after 15 minutes, then use a bounded 4h to 72h schedule", () => {
  const observations = [
    "2026-07-27T01:00:00.000Z",
    "2026-07-27T02:00:00.000Z",
    "2026-07-27T03:00:00.000Z",
    "2026-07-27T04:00:00.000Z",
    "2026-07-27T05:00:00.000Z",
    "2026-07-27T06:00:00.000Z",
  ];
  const attempts = observations.map((observedAt, index) => attempt({
    at: new Date(Date.parse(observedAt) + 1_000).toISOString(),
    attemptId: `run-source-${index + 1}`,
    message: encodeSourceBlockerEventMessage(RECEIPT, {
      observedAt: new Date(observedAt),
    }),
  }));
  const expected = [0.25, 4, 18, 36, 72, 72];
  for (const [index, delayHours] of expected.entries()) {
    const state = computeSourceRetryBackoff({
      attempts: attempts.slice(0, index + 1),
      category: CATEGORY,
      now: new Date("2026-07-27T07:00:00.000Z"),
    });
    assert.equal(state.delayHours, delayHours);
    assert.equal(state.sourceFailureCount, index + 1);
  }
});

test("source failure count excludes ordinary generation failures", () => {
  const sourceMessage = encodeSourceBlockerEventMessage(RECEIPT, {
    observedAt: new Date("2026-07-27T11:00:00.000Z"),
  });
  const state = computeSourceRetryBackoff({
    attempts: [
      attempt({ at: "2026-07-27T09:00:00.000Z", attemptId: "run-generic-one" }),
      attempt({ at: "2026-07-27T10:00:00.000Z", attemptId: "run-generic-two" }),
      attempt({
        at: "2026-07-27T11:00:01.000Z",
        attemptId: "run-source-one",
        message: sourceMessage,
      }),
    ],
    category: CATEGORY,
    now: new Date("2026-07-30T12:00:00.000Z"),
  });
  assert.equal(state.failureCount, 3);
  assert.equal(state.sourceFailureCount, 1);
  assert.equal(state.delayHours, 0.25);
});

test("ordinary and source failures advance independent retry schedules", () => {
  const sourceAttempts = [
    "2026-07-27T09:00:00.000Z",
    "2026-07-27T10:00:00.000Z",
  ].map((observedAt, index) => attempt({
    at: new Date(Date.parse(observedAt) + 1_000).toISOString(),
    attemptId: `run-source-mixed-${index + 1}`,
    message: encodeSourceBlockerEventMessage(RECEIPT, {
      observedAt: new Date(observedAt),
    }),
  }));
  const firstOrdinary = attempt({
    at: "2026-07-27T11:00:00.000Z",
    attemptId: "run-ordinary-mixed-one",
    stage: "category_source_resume",
    message: "Source resume failed after prefetch completed.",
  });
  const secondOrdinary = attempt({
    at: "2026-07-27T12:00:00.000Z",
    attemptId: "run-ordinary-mixed-two",
    stage: "category_source_resume",
    message: "A later source resume failed after prefetch completed.",
  });

  const firstState = computeSourceRetryBackoff({
    attempts: [...sourceAttempts, firstOrdinary],
    category: CATEGORY,
    now: new Date("2026-07-27T13:00:00.000Z"),
  });
  assert.equal(firstState.failureCount, 3);
  assert.equal(firstState.sourceFailureCount, 2);
  assert.equal(firstState.kind, "generation_failure");
  assert.equal(firstState.delayHours, 18);

  const secondState = computeSourceRetryBackoff({
    attempts: [...sourceAttempts, firstOrdinary, secondOrdinary],
    category: CATEGORY,
    now: new Date("2026-07-27T13:00:00.000Z"),
  });
  assert.equal(secondState.failureCount, 4);
  assert.equal(secondState.sourceFailureCount, 2);
  assert.equal(secondState.delayHours, 36);
});

test("elapsed cooldown remains active history but no longer requests deferral", () => {
  const state = computeSourceRetryBackoff({
    attempts: [attempt({
      at: "2026-07-27T09:00:00.000Z",
      attemptId: "run-one",
    })],
    category: CATEGORY,
    now: new Date("2026-07-28T03:00:00.000Z"),
  });
  assert.equal(state.active, true);
  assert.equal(state.shouldDefer, false);
  assert.equal(state.remainingMs, 0);
});

test("terminal repair failures force full regeneration through the shared 72-hour cap", () => {
  const attempts = Array.from({ length: 4 }, (_, index) => attempt({
    at: `2026-07-27T${String(9 + index).padStart(2, "0")}:00:00.000Z`,
    attemptId: `run-repair-${index + 1}`,
    stage: "category_repair",
    message: `REPAIR_SOURCE_DRAFT_SHA256=${"a".repeat(64)}; repair failed`,
  }));
  const state = computeSourceRetryBackoff({
    attempts,
    category: CATEGORY,
    now: new Date("2026-07-27T13:00:00.000Z"),
  });
  assert.equal(state.active, true);
  assert.equal(state.shouldDefer, true);
  assert.equal(state.failureCount, 4);
  assert.equal(state.sourceFailureCount, 0);
  assert.equal(state.kind, "repair_failure");
  assert.equal(state.delayHours, 72);
  assert.equal(state.observedAt, "2026-07-27T12:00:00.000Z");
  assert.equal(state.retryAt, "2026-07-30T12:00:00.000Z");
});

test("an old unterminated generation start becomes one distinct retry failure after the lock-stale interval", () => {
  const startedAt = "2026-07-27T09:00:00.000Z";
  const recent = computeSourceRetryBackoff({
    attempts: [attempt({
      at: startedAt,
      attemptId: "run-interrupted",
      status: "started",
      message: "Started quant-ph generation.",
    })],
    category: CATEGORY,
    now: new Date("2026-07-27T13:59:59.999Z"),
  });
  assert.equal(ORPHANED_GENERATION_STALE_HOURS, 5);
  assert.equal(recent.active, false);

  const stale = computeSourceRetryBackoff({
    attempts: [attempt({
      at: startedAt,
      attemptId: "run-interrupted",
      status: "started",
      message: "Started quant-ph generation.",
    })],
    category: CATEGORY,
    now: new Date("2026-07-27T14:00:00.000Z"),
  });
  assert.equal(stale.active, true);
  assert.equal(stale.shouldDefer, true);
  assert.equal(stale.failureCount, 1);
  assert.equal(stale.kind, "generation_failure");
  assert.equal(stale.observedAt, startedAt);
  assert.equal(stale.retryAt, "2026-07-28T03:00:00.000Z");
});

test("an explicit terminal event prevents an old started event from double-counting as orphaned", () => {
  const started = attempt({
    at: "2026-07-27T08:00:00.000Z",
    attemptId: "run-terminal",
    status: "started",
    message: "Started quant-ph generation.",
  });
  const failed = attempt({
    at: "2026-07-27T09:00:00.000Z",
    attemptId: "run-terminal",
  });
  const failedState = computeSourceRetryBackoff({
    attempts: [started, failed],
    category: CATEGORY,
    now: new Date("2026-07-27T14:00:00.000Z"),
  });
  assert.equal(failedState.failureCount, 1);
  assert.equal(failedState.observedAt, failed.at);

  const completedState = computeSourceRetryBackoff({
    attempts: [
      started,
      attempt({
        at: "2026-07-27T09:00:00.000Z",
        attemptId: "run-terminal",
        status: "completed",
        message: "Validated and checkpointed.",
      }),
    ],
    category: CATEGORY,
    now: new Date("2026-07-27T14:00:00.000Z"),
  });
  assert.equal(completedState.active, false);
});

test("completion clears prior failures and unrelated events do not create an active blocker", () => {
  const state = computeSourceRetryBackoff({
    attempts: [
      attempt({
        at: "2026-07-27T08:00:00.000Z",
        attemptId: "overall-event",
        category: null,
        stage: "job_preflight",
        status: "deferred",
      }),
      attempt({ at: "2026-07-27T09:00:00.000Z", attemptId: "run-one" }),
      attempt({
        at: "2026-07-27T10:00:00.000Z",
        attemptId: "run-one",
        status: "completed",
        message: "Validated and checkpointed.",
      }),
      attempt({
        at: "2026-07-27T11:00:00.000Z",
        attemptId: "repair",
        stage: "category_repair",
        status: "deferred",
      }),
      attempt({
        at: "2026-07-27T12:00:00.000Z",
        attemptId: "other-category",
        category: "gr-qc",
      }),
    ],
    category: CATEGORY,
    now: new Date("2026-07-27T13:00:00.000Z"),
  });
  assert.deepEqual(state, {
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
});

test("duplicate failure events for one attempt count once and input order is not mutated", () => {
  const first = attempt({
    at: "2026-07-27T09:01:00.000Z",
    attemptId: "run-one",
  });
  const duplicate = attempt({
    at: "2026-07-27T09:00:00.000Z",
    attemptId: "run-one",
    message: encodeSourceBlockerEventMessage(RECEIPT, {
      observedAt: new Date("2026-07-27T09:00:00.000Z"),
    }),
  });
  const input = [duplicate, first];
  const state = computeSourceRetryBackoff({
    attempts: input,
    category: CATEGORY,
    now: new Date("2026-07-27T10:00:00.000Z"),
  });
  assert.equal(state.failureCount, 1);
  assert.equal(state.kind, "source_incomplete");
  assert.equal(input[0], duplicate);
  assert.equal(input[1], first);
});

test("a malformed reserved source message fails closed instead of becoming a generic failure", () => {
  assert.throws(() => computeSourceRetryBackoff({
    attempts: [attempt({
      at: "2026-07-27T09:00:00.000Z",
      attemptId: "run-one",
      message: `${SOURCE_BLOCKER_MESSAGE_PREFIX}{`,
    })],
    category: CATEGORY,
    now: new Date("2026-07-27T10:00:00.000Z"),
  }), /not valid JSON/);
});
