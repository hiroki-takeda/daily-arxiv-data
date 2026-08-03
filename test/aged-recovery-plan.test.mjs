import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgedRecoveryPlan,
  loadActiveAgedRecoveryPlan,
  validateAgedRecoveryPlan,
} from "../scripts/lib/aged-recovery-plan.mjs";
import {
  ARXIV_PASTWEEK_LISTING_URLS,
  fingerprintSnapshot,
} from "../scripts/lib/arxiv-source.mjs";

const CATEGORIES = Object.freeze(["quant-ph", "gr-qc", "hep-th"]);
const LATEST = "2026-07-24";
const TARGET = "2026-07-27";
const LIVE_DATES = Object.freeze(["2026-07-31", "2026-07-30", "2026-07-29", "2026-07-28"]);
const SOURCE_RUNTIME = "7".repeat(64);
const DESTINATION_RUNTIME = "6".repeat(64);
const SOURCE_RUN = "run-20260727T023139Z-a96a4dd333d0";

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalJson);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
}

function snapshot(date, suffix) {
  return {
    announcementDate: date,
    categories: Object.fromEntries(CATEGORIES.map((slug, index) => [slug, {
      slug,
      sourceUrl: ARXIV_PASTWEEK_LISTING_URLS[slug],
      newCount: slug === "quant-ph" ? 1 : 0,
      crosslistCount: 0,
      newIds: slug === "quant-ph" ? [`2607.${String(suffix + index).padStart(5, "0")}`] : [],
    }])),
  };
}

function evidence(selectionMode, expectedLatestDate, selectedSnapshot) {
  return {
    schemaVersion: "1.0",
    selectionMode,
    expectedLatestDate,
    targetDate: selectedSnapshot.announcementDate,
    targetSnapshotFingerprint: fingerprintSnapshot(selectedSnapshot),
    officialHeadDate: LIVE_DATES[0],
    officialHeadFingerprint: "c".repeat(64),
    pastweekAnnouncementDates: [...LIVE_DATES],
    completeSnapshotDates: [...LIVE_DATES],
  };
}

function provenanceEntry(path, inode) {
  return {
    path,
    type: "directory",
    mode: "0700",
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    dev: "1",
    ino: String(inode),
    nlink: "2",
    size: "0",
    birthtimeNs: "1",
    mtimeNs: "1",
    ctimeNs: "1",
    sha256: null,
  };
}

function sourceProvenance(targetSnapshot) {
  const value = {
    schemaVersion: "1.0",
    kind: "aged_checkpoint_provenance",
    targetDate: TARGET,
    oldestLiveDate: LIVE_DATES.at(-1),
    expectedUid: typeof process.getuid === "function" ? process.getuid() : 0,
    snapshotFingerprint: fingerprintSnapshot(targetSnapshot),
    snapshotRawSha256: "a".repeat(64),
    manifestRawSha256: "b".repeat(64),
    runtimeFingerprint: SOURCE_RUNTIME,
    evaluationRunId: SOURCE_RUN,
    manifestCreatedAt: "2026-07-27T02:31:39.921Z",
    attemptCount: 0,
    family: provenanceEntry(".", 1),
    entries: [
      `${SOURCE_RUNTIME}/.writes`,
      `${SOURCE_RUNTIME}/attempts`,
      `${SOURCE_RUNTIME}/drafts`,
      `${SOURCE_RUNTIME}/publication`,
      `${SOURCE_RUNTIME}/reports`,
      SOURCE_RUNTIME,
    ].sort().map((path, index) => provenanceEntry(path, index + 2)),
  };
  return {
    ...value,
    evidenceSha256: createHash("sha256")
      .update(`${JSON.stringify(canonicalJson(value), null, 2)}\n`)
      .digest("hex"),
  };
}

async function fixture() {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "daily-arxiv-aged-plan-test-")));
  const directory = join(root, "aged-recovery-plans");
  const stagingDirectory = join(root, "aged-recovery-plan-staging");
  mkdirSync(directory, { mode: 0o700 });
  mkdirSync(stagingDirectory, { mode: 0o700 });
  const snapshots = [
    snapshot(TARGET, 2_700),
    snapshot("2026-07-28", 2_800),
    snapshot("2026-07-29", 2_900),
    snapshot("2026-07-30", 3_000),
    snapshot("2026-07-31", 3_100),
  ];
  const entries = snapshots.map((selectedSnapshot, index) => {
    const selectionMode = index === 0
      ? "aged_checkpoint_recovery"
      : index === 1
        ? "aged_window_continuation"
        : "normal";
    const expectedLatestDate = index === 0 ? LATEST : snapshots[index - 1].announcementDate;
    return {
      selectionMode,
      expectedLatestDate,
      snapshot: selectedSnapshot,
      evidence: evidence(selectionMode, expectedLatestDate, selectedSnapshot),
    };
  });
  const sourceJob = {
    manifest: {
      reportDate: TARGET,
      snapshotFingerprint: fingerprintSnapshot(snapshots[0]),
      runtimeFingerprint: SOURCE_RUNTIME,
    },
    evaluationRunId: SOURCE_RUN,
  };
  return {
    root,
    directory,
    stagingDirectory,
    snapshots,
    entries,
    sourceJob,
    sourceCheckpointProvenance: sourceProvenance(snapshots[0]),
  };
}

function createOptions(state, overrides = {}) {
  return {
    directory: state.directory,
    stagingDirectory: state.stagingDirectory,
    expectedLatestDate: LATEST,
    sourceJob: state.sourceJob,
    automationRuntimeFingerprint: DESTINATION_RUNTIME,
    sourceCheckpointProvenance: state.sourceCheckpointProvenance,
    entries: state.entries,
    now: new Date("2026-08-03T03:00:00.000Z"),
    ...overrides,
  };
}

test("aged recovery plan is canonical, content-addressed, durable, and runtime-bound", async () => {
  const state = await fixture();
  const created = createAgedRecoveryPlan(createOptions(state));
  assert.match(created.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(statSync(created.path).mode & 0o777, 0o600);
  assert.equal(readdirSync(state.stagingDirectory).length, 0);
  assert.equal(created.plan.entries.length, 5);
  assert.equal(created.plan.entries[1].selectionMode, "aged_window_continuation");

  const loaded = loadActiveAgedRecoveryPlan({
    directory: state.directory,
    latestDate: LATEST,
    automationRuntimeFingerprint: DESTINATION_RUNTIME,
  });
  assert.equal(loaded.active.sha256, created.sha256);
  assert.equal(loaded.active.plan.targetDate, TARGET);
  assert.equal(loadActiveAgedRecoveryPlan({
    directory: state.directory,
    latestDate: TARGET,
    automationRuntimeFingerprint: DESTINATION_RUNTIME,
  }).active, null);
  assert.throws(() => loadActiveAgedRecoveryPlan({
    directory: state.directory,
    latestDate: LATEST,
    automationRuntimeFingerprint: "5".repeat(64),
  }), /runtime changed/u);
});

test("aged recovery plan publication is crash-safe before and after its atomic link", async () => {
  const state = await fixture();
  assert.throws(() => createAgedRecoveryPlan(createOptions(state, {
    publishLink: () => {
      throw new Error("simulated crash before link");
    },
  })), /simulated crash before link/u);
  assert.equal(readdirSync(state.directory).length, 0);
  assert.equal(readdirSync(state.stagingDirectory).length, 1);
  assert.equal(loadActiveAgedRecoveryPlan({
    directory: state.directory,
    latestDate: LATEST,
    automationRuntimeFingerprint: DESTINATION_RUNTIME,
  }).active, null);

  assert.throws(() => createAgedRecoveryPlan(createOptions(state, {
    now: new Date("2026-08-03T03:00:01.000Z"),
    removeStaged: () => {
      throw new Error("simulated crash after link");
    },
  })), /simulated crash after link/u);
  assert.equal(readdirSync(state.directory).length, 0);
  assert.equal(readdirSync(state.stagingDirectory).length, 2);
});

test("aged recovery plan rejects tampering, duplicate anchors, and identity drift", async () => {
  const state = await fixture();
  const created = createAgedRecoveryPlan(createOptions(state));
  const original = readFileSync(created.path, "utf8");
  writeFileSync(created.path, original.replace(TARGET, "2026-07-26"));
  assert.throws(() => loadActiveAgedRecoveryPlan({
    directory: state.directory,
    latestDate: LATEST,
    automationRuntimeFingerprint: DESTINATION_RUNTIME,
  }), /digest does not match/u);

  const duplicateState = await fixture();
  createAgedRecoveryPlan(createOptions(duplicateState));
  createAgedRecoveryPlan(createOptions(duplicateState, {
    now: new Date("2026-08-03T03:00:01.000Z"),
  }));
  assert.throws(() => loadActiveAgedRecoveryPlan({
    directory: duplicateState.directory,
    latestDate: LATEST,
    automationRuntimeFingerprint: DESTINATION_RUNTIME,
  }), /Multiple aged recovery plans/u);

  const sameRuntime = structuredClone(createOptions(duplicateState));
  sameRuntime.automationRuntimeFingerprint = SOURCE_RUNTIME;
  assert.throws(() => createAgedRecoveryPlan(sameRuntime), /must differ/u);

  const changedEntries = structuredClone(duplicateState.entries);
  changedEntries[1].evidence.targetSnapshotFingerprint = "0".repeat(64);
  assert.throws(() => createAgedRecoveryPlan(createOptions(duplicateState, {
    entries: changedEntries,
  })), /does not match/u);
});

test("aged recovery plan validator rejects a relabeled continuation mode", async () => {
  const state = await fixture();
  const created = createAgedRecoveryPlan(createOptions(state));
  const changed = structuredClone(created.plan);
  changed.entries[1].selectionMode = "normal";
  changed.entries[1].evidence.selectionMode = "normal";
  assert.throws(() => validateAgedRecoveryPlan(changed), /invalid selectionMode/u);
});
