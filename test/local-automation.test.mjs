import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CATEGORIES,
  AUTOMATION_RUNTIME_PATHS,
  MODEL_ID,
  acquireLock,
  assertAgedRecoveryPlanMatchesQueue,
  assertPublisherControlFastForward,
  assertGenericCategoryDraftRescueAllowed,
  assertChatGptLogin,
  assertPinnedCodexIdentity,
  bindCategoryReportForCheckpoint,
  buildAutomationPrompt,
  buildCategoryAutomationPrompt,
  buildCategoryRepairPrompt,
  buildCodexArgs,
  buildAgedRecoveryPlanEntries,
  codexBinaryIdentity,
  classifyFullTextReadiness,
  computeCategoryRetryState,
  copyReportsToHostStaging,
  createDurableRecoveryAuthorization,
  discoverCodex,
  ensureDurableContinuationQueue,
  fingerprintAutomationRuntime,
  isRetryableGitNetworkFailure,
  invokeCodexCategory,
  loadCheckpointRecoverySource,
  loadActiveDurableRecoveryAuthorization,
  loadAuthorizedContinuationJob,
  macNotificationBody,
  makeRunId,
  openRecoverableCheckpointJob,
  parseAutomationInvocation,
  parseMode,
  prefetchSourceBlockerCandidates,
  preparePublicationWorktree,
  probeOfficialVersionFixedPdf,
  removeSuccessfulRunArtifacts,
  resolveAgentWorktreeBase,
  resolvePublicationWorktreeBase,
  runStreamingCommand,
  runPaths,
  sanitizedChildEnv,
  sourceFailureNeedsAttention,
  validateCodexCompletionResponse,
  validateCategoryModelOutputLayout,
  validateCategorySourceBlockerLayout,
  validateManifest,
  validateModelOutputLayout,
  verifyPublisherControlRuntime,
} from "../scripts/lib/local-automation.mjs";
import {
  importCheckpointCategoryReport,
  openCheckpointJob,
} from "../scripts/lib/checkpoint.mjs";
import {
  ARXIV_LISTING_URLS,
  ARXIV_PASTWEEK_LISTING_URLS,
  fingerprintSnapshot,
  selectAgedCheckpointRecoverySnapshot,
  selectAuthorizedContinuationSnapshot,
  selectBackfillSnapshot,
  selectCheckpointRecoverySnapshot,
} from "../scripts/lib/arxiv-source.mjs";
import {
  fetchArxivSourceArchive,
  parseArxivSourceArchive,
} from "../scripts/extract-arxiv-source.mjs";
import { MODEL_SOURCE_FAILURE_CLASS } from "../scripts/lib/source-blocker.mjs";
import { validPolicy, validReport, validRun } from "./helpers.mjs";

const RUN_ID = "run-20990105T123456Z-abcdef123456";
const DATE = "2099-01-05";
const SNAPSHOT = Object.freeze({
  announcementDate: DATE,
  categories: {
    "quant-ph": { slug: "quant-ph", sourceUrl: "https://arxiv.org/list/quant-ph/new", newCount: 1, crosslistCount: 0, newIds: ["2099.00003"] },
    "gr-qc": { slug: "gr-qc", sourceUrl: "https://arxiv.org/list/gr-qc/new", newCount: 1, crosslistCount: 0, newIds: ["2099.00002"] },
    "hep-th": { slug: "hep-th", sourceUrl: "https://arxiv.org/list/hep-th/new", newCount: 1, crosslistCount: 0, newIds: ["2099.00001"] },
  },
});

function categoryMetadataFixture(snapshot = SNAPSHOT, slug = "quant-ph") {
  return {
    schemaVersion: "1.0",
    announcementDate: snapshot.announcementDate,
    slug,
    snapshotFingerprint: fingerprintSnapshot(snapshot),
    papers: snapshot.categories[slug].newIds.map((arxivId, index) => ({
      arxivId,
      arxivVersion: "v1",
      submissionType: "new",
      url: `https://arxiv.org/abs/${arxivId}`,
      sourceUrl: `https://arxiv.org/abs/${arxivId}v1`,
      title: `Exact original title ${index + 1}`,
      authors: [`Author ${index + 1}`],
      abstract: `Paper-specific abstract evidence ${index + 1}.`,
      comments: null,
      primaryCategory: slug,
    })),
  };
}

function typedUnavailableSource(arxivId) {
  return fetchArxivSourceArchive(arxivId, {
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
    sleepImpl: async () => {},
    maxAttempts: 1,
  });
}

function runFixtureGit(cwd, args) {
  const result = spawnSync("/usr/bin/git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function queueSnapshot(date, urls, idSuffix, { empty = false } = {}) {
  return {
    announcementDate: date,
    categories: Object.fromEntries(CATEGORIES.map((slug, index) => {
      const newIds = !empty && slug === "quant-ph"
        ? [`2099.${String(idSuffix + index).padStart(5, "0")}`]
        : [];
      return [slug, {
        slug,
        sourceUrl: urls[slug],
        newCount: newIds.length,
        crosslistCount: 0,
        newIds,
      }];
    })),
  };
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalJson);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
}

function readHostStreamAudit(path) {
  const content = readFileSync(path, "utf8");
  const marker = "\n--- HOST STREAM AUDIT ---\n";
  const index = content.lastIndexOf(marker);
  assert.notEqual(index, -1, "bounded stream log must end with a host audit footer");
  return JSON.parse(content.slice(index + marker.length).trim());
}

async function waitForProcessToDisappear(pid) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolvePromise) => globalThis.setTimeout(resolvePromise, 25));
  }
  assert.fail(`process ${pid} survived bounded process-group cleanup`);
}

function agedProvenanceFixture({
  targetDate,
  oldestLiveDate,
  snapshotFingerprint,
  runtimeFingerprint,
  evaluationRunId,
}) {
  const timestamp = `${targetDate}T03:00:00.000Z`;
  const directoryEntry = (path, inode) => ({
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
  });
  const evidence = {
    schemaVersion: "1.0",
    kind: "aged_checkpoint_provenance",
    targetDate,
    oldestLiveDate,
    expectedUid: typeof process.getuid === "function" ? process.getuid() : 0,
    snapshotFingerprint,
    snapshotRawSha256: "a".repeat(64),
    manifestRawSha256: "b".repeat(64),
    runtimeFingerprint,
    evaluationRunId,
    manifestCreatedAt: timestamp,
    attemptCount: 0,
    family: directoryEntry(".", 1),
    entries: [
      ".writes",
      "attempts",
      "drafts",
      "publication",
      "reports",
      runtimeFingerprint,
    ].sort().map((path, index) => directoryEntry(path, index + 2)),
  };
  return {
    ...evidence,
    evidenceSha256: createHash("sha256")
      .update(`${JSON.stringify(canonicalJson(evidence), null, 2)}\n`)
      .digest("hex"),
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-runner-test-"));
  const staging = join(root, "staging");
  const outbox = join(root, "outbox");
  mkdirSync(staging);
  mkdirSync(outbox);
  return { root, staging, manifest: join(outbox, "manifest.json") };
}

function manifestObject(staging, overrides = {}) {
  return {
    schemaVersion: "1.0",
    runId: RUN_ID,
    status: "ready",
    reportDate: DATE,
    stagingDirectory: staging,
    reportFiles: CATEGORIES.map((category) => `${DATE}-${category}.json`),
    message: "Three complete reports are ready.",
    ...overrides,
  };
}

test("mode parser exposes normal, diagnostic, live, and aged one-shot checkpoint recovery modes", () => {
  assert.equal(parseMode([]), "run");
  assert.equal(parseMode(["--check"]), "check");
  assert.deepEqual(parseAutomationInvocation([
    "--recover-checkpoint",
    "2026-07-24",
    "2026-07-27",
    "a".repeat(64),
    "b".repeat(64),
  ]), {
    mode: "run",
    recovery: {
      selectionMode: "checkpoint_recovery",
      expectedLatestDate: "2026-07-24",
      targetDate: "2026-07-27",
      snapshotFingerprint: "a".repeat(64),
      sourceRuntimeFingerprint: "b".repeat(64),
    },
  });
  assert.deepEqual(parseAutomationInvocation([
    "--recover-aged-checkpoint",
    "2026-07-24",
    "2026-07-27",
    "a".repeat(64),
    "b".repeat(64),
  ]), {
    mode: "run",
    recovery: {
      selectionMode: "aged_checkpoint_recovery",
      expectedLatestDate: "2026-07-24",
      targetDate: "2026-07-27",
      snapshotFingerprint: "a".repeat(64),
      sourceRuntimeFingerprint: "b".repeat(64),
    },
  });
  assert.throws(() => parseMode(["--dry-run"]), /Usage/);
  assert.throws(() => parseMode(["--check", "extra"]), /Usage/);
  assert.throws(() => parseMode(["--recover-checkpoint", "2026-07-24"]), /Usage/);
  assert.throws(() => parseMode(["--recover-aged-checkpoint", "2026-07-24"]), /Usage/);
  assert.throws(() => parseMode([
    "--recover-checkpoint",
    "2026-07-24",
    "2026-07-27",
    "not-a-digest",
    "b".repeat(64),
  ]), /SHA-256/);
  assert.throws(() => parseMode([
    "--recover-aged-checkpoint",
    "2026-07-24",
    "2026-07-27",
    "a".repeat(64),
    "not-a-digest",
  ]), /SHA-256/);
});

test("one-shot recovery loads only the exact unpublished immutable checkpoint snapshot", async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "daily-arxiv-recovery-test-")));
  const controlRoot = join(root, "control");
  const dataRoot = join(root, "public", "data");
  mkdirSync(dataRoot, { recursive: true });
  const latestDate = "2099-01-04";
  const index = {
    latestDate,
    availableDates: [latestDate],
  };
  writeFileSync(join(dataRoot, "index.json"), `${JSON.stringify(index)}\n`);
  writeFileSync(join(dataRoot, "current.json"), `${JSON.stringify({
    date: latestDate,
    availableDates: [latestDate],
  })}\n`);
  const recoverySnapshot = structuredClone(SNAPSHOT);
  for (const slug of CATEGORIES) {
    recoverySnapshot.categories[slug].sourceUrl = `https://arxiv.org/list/${slug}/pastweek`;
  }
  const snapshotFingerprint = fingerprintSnapshot(recoverySnapshot);
  const sourceRuntimeFingerprint = "c".repeat(64);
  const sourceJob = openCheckpointJob({
    controlRoot,
    snapshot: recoverySnapshot,
    snapshotFingerprint,
    runtimeFingerprint: sourceRuntimeFingerprint,
    evaluationRunId: RUN_ID,
  });
  const recovery = {
    selectionMode: "checkpoint_recovery",
    expectedLatestDate: latestDate,
    targetDate: DATE,
    snapshotFingerprint,
    sourceRuntimeFingerprint,
  };
  const loaded = loadCheckpointRecoverySource({
    root,
    controlRoot,
    index,
    recovery,
  });
  assert.equal(loaded.sourceJob.path, sourceJob.path);
  assert.deepEqual(loaded.storedSnapshot, recoverySnapshot);

  assert.throws(() => loadCheckpointRecoverySource({
    root,
    controlRoot,
    index: { ...index, latestDate: "2099-01-03" },
    recovery,
  }), /expected public latestDate/);

  writeFileSync(join(dataRoot, `${DATE}.json`), "{}\n");
  assert.throws(() => loadCheckpointRecoverySource({
    root,
    controlRoot,
    index,
    recovery,
  }), /already exists on disk/);
});

test("durable authorization survives a deferred run and becomes inactive only after public latest advances", async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "daily-arxiv-durable-auth-test-")));
  const controlRoot = join(root, "control");
  const authorizationDirectory = join(controlRoot, "recovery-authorizations");
  const stagingDirectory = join(controlRoot, "recovery-authorization-staging");
  const dataRoot = join(root, "public", "data");
  mkdirSync(authorizationDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(stagingDirectory, { mode: 0o700 });
  mkdirSync(dataRoot, { recursive: true });
  const latestDate = "2099-01-04";
  const index = { latestDate, availableDates: [latestDate] };
  writeFileSync(join(dataRoot, "index.json"), `${JSON.stringify(index)}\n`);
  writeFileSync(join(dataRoot, "current.json"), `${JSON.stringify({
    date: latestDate,
    availableDates: [latestDate],
  })}\n`);
  const snapshot = structuredClone(SNAPSHOT);
  for (const slug of CATEGORIES) snapshot.categories[slug].sourceUrl = `https://arxiv.org/list/${slug}/pastweek`;
  const snapshotFingerprint = fingerprintSnapshot(snapshot);
  const runtimeFingerprint = "d".repeat(64);
  const job = openCheckpointJob({
    controlRoot,
    snapshot,
    snapshotFingerprint,
    runtimeFingerprint,
    evaluationRunId: RUN_ID,
  });
  const evidence = {
    schemaVersion: "1.0",
    selectionMode: "normal",
    expectedLatestDate: latestDate,
    targetDate: DATE,
    targetSnapshotFingerprint: snapshotFingerprint,
    officialHeadDate: DATE,
    officialHeadFingerprint: snapshotFingerprint,
    pastweekAnnouncementDates: [DATE, latestDate],
    completeSnapshotDates: [DATE],
  };
  const created = createDurableRecoveryAuthorization({
    directory: authorizationDirectory,
    stagingDirectory,
    selectionMode: "normal",
    expectedLatestDate: latestDate,
    snapshot,
    automationRuntimeFingerprint: runtimeFingerprint,
    job,
    evidence,
    now: new Date("2099-01-05T01:02:03.000Z"),
  });
  assert.equal(statSync(created.path).mode & 0o777, 0o600);
  assert.equal(readdirSync(stagingDirectory).length, 0);

  const afterDeferred = loadActiveDurableRecoveryAuthorization({
    directory: authorizationDirectory,
    latestDate,
  });
  assert.equal(afterDeferred.active.targetDate, DATE);
  const resumed = loadAuthorizedContinuationJob({
    root,
    controlRoot,
    index,
    authorization: afterDeferred.active,
    runtimeFingerprint,
  });
  assert.equal(resumed.job.evaluationRunId, RUN_ID);
  assert.equal(fingerprintSnapshot(resumed.storedSnapshot), snapshotFingerprint);

  createDurableRecoveryAuthorization({
    directory: authorizationDirectory,
    stagingDirectory,
    selectionMode: "normal",
    expectedLatestDate: latestDate,
    snapshot,
    automationRuntimeFingerprint: runtimeFingerprint,
    job,
    evidence,
    now: new Date("2099-01-05T01:02:04.000Z"),
  });
  assert.throws(() => loadActiveDurableRecoveryAuthorization({
    directory: authorizationDirectory,
    latestDate,
  }), /Multiple durable recovery authorizations/);

  assert.throws(() => loadActiveDurableRecoveryAuthorization({
    directory: authorizationDirectory,
    latestDate: DATE,
  }), /Multiple durable recovery authorizations target the same public latestDate/);
  assert.equal(existsSync(created.path), true);
});

test("durable authorization publishes atomically from private staging and detects tampering", async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "daily-arxiv-durable-auth-atomic-test-")));
  const controlRoot = join(root, "control");
  const authorizationDirectory = join(controlRoot, "recovery-authorizations");
  const stagingDirectory = join(controlRoot, "recovery-authorization-staging");
  mkdirSync(authorizationDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(stagingDirectory, { mode: 0o700 });
  const snapshot = structuredClone(SNAPSHOT);
  for (const slug of CATEGORIES) snapshot.categories[slug].sourceUrl = `https://arxiv.org/list/${slug}/pastweek`;
  const snapshotFingerprint = fingerprintSnapshot(snapshot);
  const runtimeFingerprint = "e".repeat(64);
  const job = openCheckpointJob({
    controlRoot,
    snapshot,
    snapshotFingerprint,
    runtimeFingerprint,
    evaluationRunId: RUN_ID,
  });
  const latestDate = "2099-01-04";
  const evidence = {
    schemaVersion: "1.0",
    selectionMode: "normal",
    expectedLatestDate: latestDate,
    targetDate: DATE,
    targetSnapshotFingerprint: snapshotFingerprint,
    officialHeadDate: DATE,
    officialHeadFingerprint: snapshotFingerprint,
    pastweekAnnouncementDates: [DATE, latestDate],
    completeSnapshotDates: [DATE],
  };
  assert.throws(() => createDurableRecoveryAuthorization({
    directory: authorizationDirectory,
    stagingDirectory,
    selectionMode: "normal",
    expectedLatestDate: latestDate,
    snapshot,
    automationRuntimeFingerprint: runtimeFingerprint,
    job,
    evidence,
    now: new Date("2099-01-05T01:02:03.000Z"),
    publishLink: () => {
      throw new Error("simulated kill before atomic link");
    },
  }), /simulated kill/);
  assert.equal(readdirSync(authorizationDirectory).length, 0);
  assert.equal(readdirSync(stagingDirectory).length, 1);
  assert.equal(loadActiveDurableRecoveryAuthorization({
    directory: authorizationDirectory,
    latestDate,
  }).active, null);

  assert.throws(() => createDurableRecoveryAuthorization({
    directory: authorizationDirectory,
    stagingDirectory,
    selectionMode: "normal",
    expectedLatestDate: latestDate,
    snapshot,
    automationRuntimeFingerprint: runtimeFingerprint,
    job,
    evidence,
    now: new Date("2099-01-05T01:02:03.500Z"),
    removeStaged: () => {
      throw new Error("simulated failure after atomic link");
    },
  }), /simulated failure after atomic link/);
  assert.equal(readdirSync(authorizationDirectory).length, 0);
  assert.equal(readdirSync(stagingDirectory).length, 2);
  assert.equal(loadActiveDurableRecoveryAuthorization({
    directory: authorizationDirectory,
    latestDate,
  }).active, null);

  const created = createDurableRecoveryAuthorization({
    directory: authorizationDirectory,
    stagingDirectory,
    selectionMode: "normal",
    expectedLatestDate: latestDate,
    snapshot,
    automationRuntimeFingerprint: runtimeFingerprint,
    job,
    evidence,
    now: new Date("2099-01-05T01:02:04.000Z"),
  });
  const original = readFileSync(created.path, "utf8");
  writeFileSync(created.path, original.replace('"kind": "edition_continuation"', '"kind": "edition_continuatioN"'));
  assert.throws(() => loadActiveDurableRecoveryAuthorization({
    directory: authorizationDirectory,
    latestDate,
  }), /digest does not match/);
});

test("durable queue protects every captured missing edition before the oldest one is published", async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "daily-arxiv-durable-queue-test-")));
  const controlRoot = join(root, "control");
  const directory = join(controlRoot, "recovery-authorizations");
  const stagingDirectory = join(controlRoot, "recovery-authorization-staging");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  mkdirSync(stagingDirectory, { mode: 0o700 });
  const latestDate = "2099-01-02";
  const dates = ["2099-01-07", "2099-01-06", "2099-01-05", latestDate];
  const snapshots = [
    queueSnapshot("2099-01-07", ARXIV_PASTWEEK_LISTING_URLS, 700),
    queueSnapshot("2099-01-06", ARXIV_PASTWEEK_LISTING_URLS, 600),
    queueSnapshot("2099-01-05", ARXIV_PASTWEEK_LISTING_URLS, 500),
    queueSnapshot(latestDate, ARXIV_PASTWEEK_LISTING_URLS, 200, { empty: true }),
  ];
  const pastweekWindow = {
    announcementDates: dates,
    snapshots,
  };
  const currentSnapshot = queueSnapshot("2099-01-07", ARXIV_LISTING_URLS, 700);
  const now = new Date("2099-01-07T03:00:00.000Z");
  const selection = selectBackfillSnapshot({
    currentSnapshot,
    pastweekWindow,
    latestDate,
    now,
  });
  assert.deepEqual(
    selection.pendingSnapshots.map(({ announcementDate }) => announcementDate),
    ["2099-01-05", "2099-01-06", "2099-01-07"],
  );
  const runtimeFingerprint = "f".repeat(64);
  const firstJob = openCheckpointJob({
    controlRoot,
    snapshot: selection.snapshot,
    snapshotFingerprint: fingerprintSnapshot(selection.snapshot),
    runtimeFingerprint,
    evaluationRunId: RUN_ID,
    now,
  });
  const queue = ensureDurableContinuationQueue({
    directory,
    stagingDirectory,
    controlRoot,
    records: [],
    selectionMode: "normal",
    expectedLatestDate: latestDate,
    pendingSnapshots: selection.pendingSnapshots,
    automationRuntimeFingerprint: runtimeFingerprint,
    firstJob,
    policy: validPolicy(),
    currentSnapshot,
    pastweekWindow,
    attemptId: RUN_ID,
    now,
  });
  assert.deepEqual(queue.targets, ["2099-01-05", "2099-01-06", "2099-01-07"]);
  assert.equal(readdirSync(directory).length, 3);
  for (const [anchor, target] of [
    ["2099-01-02", "2099-01-05"],
    ["2099-01-05", "2099-01-06"],
    ["2099-01-06", "2099-01-07"],
  ]) {
    const active = loadActiveDurableRecoveryAuthorization({
      directory,
      latestDate: anchor,
    }).active;
    assert.equal(active.targetDate, target);
    assert.equal(
      loadAuthorizedContinuationJob({
        root: (() => {
          const publicData = join(root, "public", "data");
          mkdirSync(publicData, { recursive: true });
          const index = { latestDate: anchor, availableDates: [anchor] };
          writeFileSync(join(publicData, "index.json"), `${JSON.stringify(index)}\n`);
          writeFileSync(join(publicData, "current.json"), `${JSON.stringify({
            date: anchor,
            availableDates: [anchor],
          })}\n`);
          return root;
        })(),
        controlRoot,
        index: { latestDate: anchor, availableDates: [anchor] },
        authorization: active,
        runtimeFingerprint,
      }).storedSnapshot.announcementDate,
      target,
    );
  }
});

test("checkpoint recovery protects an aged-out 7/27-style head and every live successor", async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "daily-arxiv-checkpoint-queue-test-")));
  const controlRoot = join(root, "control");
  const directory = join(controlRoot, "recovery-authorizations");
  const stagingDirectory = join(controlRoot, "recovery-authorization-staging");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  mkdirSync(stagingDirectory, { mode: 0o700 });
  const latestDate = "2026-07-24";
  const dates = ["2026-07-31", "2026-07-30", "2026-07-29", "2026-07-28"];
  const snapshots = dates.map((date, index) => (
    queueSnapshot(date, ARXIV_PASTWEEK_LISTING_URLS, 3_100 - (index * 100))
  ));
  const pastweekWindow = { announcementDates: dates, snapshots };
  const currentSnapshot = queueSnapshot("2026-07-31", ARXIV_LISTING_URLS, 3_100);
  const targetSnapshot = queueSnapshot("2026-07-27", ARXIV_PASTWEEK_LISTING_URLS, 2_700);
  const sourceRuntimeFingerprint = "7".repeat(64);
  const destinationRuntimeFingerprint = "6".repeat(64);
  const sourceEvaluationRunId = "run-20260727T023139Z-a96a4dd333d0";
  const destinationEvaluationRunId = "run-20260731T030000Z-abcdef123456";
  const now = new Date("2026-07-31T03:00:00.000Z");
  const sourceJob = openCheckpointJob({
    controlRoot,
    snapshot: targetSnapshot,
    snapshotFingerprint: fingerprintSnapshot(targetSnapshot),
    runtimeFingerprint: sourceRuntimeFingerprint,
    evaluationRunId: sourceEvaluationRunId,
    now,
  });
  const firstJob = openCheckpointJob({
    controlRoot,
    snapshot: targetSnapshot,
    snapshotFingerprint: fingerprintSnapshot(targetSnapshot),
    runtimeFingerprint: destinationRuntimeFingerprint,
    evaluationRunId: destinationEvaluationRunId,
    now,
  });
  const selection = selectAgedCheckpointRecoverySnapshot({
    storedSnapshot: targetSnapshot,
    currentSnapshot,
    pastweekWindow,
    latestDate,
    expectedDate: "2026-07-27",
    expectedSnapshotFingerprint: fingerprintSnapshot(targetSnapshot),
    now,
  });
  assert.deepEqual(
    selection.pendingSnapshots.map(({ announcementDate }) => announcementDate),
    ["2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31"],
  );
  const sourceCheckpointProvenance = agedProvenanceFixture({
    targetDate: "2026-07-27",
    oldestLiveDate: "2026-07-28",
    snapshotFingerprint: fingerprintSnapshot(targetSnapshot),
    runtimeFingerprint: sourceRuntimeFingerprint,
    evaluationRunId: sourceEvaluationRunId,
  });
  const sealedEntries = buildAgedRecoveryPlanEntries({
    latestDate,
    pendingSnapshots: selection.pendingSnapshots,
    currentSnapshot,
    pastweekWindow,
    now,
  });
  const tamperedEntries = structuredClone(sealedEntries);
  tamperedEntries[1].evidence.targetSnapshotFingerprint = "0".repeat(64);
  assert.throws(() => ensureDurableContinuationQueue({
    directory,
    stagingDirectory,
    controlRoot,
    records: [],
    selectionMode: "aged_checkpoint_recovery",
    expectedLatestDate: latestDate,
    pendingSnapshots: selection.pendingSnapshots,
    sourceJob,
    sourceCheckpointProvenance,
    sealedEntries: tamperedEntries,
    automationRuntimeFingerprint: destinationRuntimeFingerprint,
    firstJob,
    policy: validPolicy(),
    currentSnapshot,
    pastweekWindow,
    attemptId: destinationEvaluationRunId,
    now,
  }), /evidence does not match|sealed/u);
  assert.equal(readdirSync(directory).length, 0);
  const queue = ensureDurableContinuationQueue({
    directory,
    stagingDirectory,
    controlRoot,
    records: [],
    selectionMode: "aged_checkpoint_recovery",
    expectedLatestDate: latestDate,
    pendingSnapshots: selection.pendingSnapshots,
    sourceJob,
    sourceCheckpointProvenance,
    sealedEntries,
    automationRuntimeFingerprint: destinationRuntimeFingerprint,
    firstJob,
    policy: validPolicy(),
    currentSnapshot,
    pastweekWindow,
    attemptId: destinationEvaluationRunId,
    now,
  });
  assert.deepEqual(queue.targets, ["2026-07-27", ...dates.toReversed()]);
  assert.equal(readdirSync(directory).length, 5);
  const plan = {
    expectedLatestDate: latestDate,
    targetDate: targetSnapshot.announcementDate,
    snapshotFingerprint: fingerprintSnapshot(targetSnapshot),
    sourceRuntimeFingerprint,
    sourceEvaluationRunId,
    automationRuntimeFingerprint: destinationRuntimeFingerprint,
    sourceCheckpointProvenance,
    entries: sealedEntries,
  };
  const queueRecords = queue.entries.map(({ record }) => record);
  assert.doesNotThrow(() => assertAgedRecoveryPlanMatchesQueue(plan, queueRecords));
  assert.throws(
    () => assertAgedRecoveryPlanMatchesQueue(plan, queueRecords.slice(0, -1)),
    /does not match sealed entry 4/u,
  );
  const tamperedQueueRecords = structuredClone(queueRecords);
  tamperedQueueRecords[1].evidence.officialHeadFingerprint = "0".repeat(64);
  assert.throws(
    () => assertAgedRecoveryPlanMatchesQueue(plan, tamperedQueueRecords),
    /does not match sealed entry 1/u,
  );
  const extensionSnapshot = queueSnapshot("2026-08-03", ARXIV_PASTWEEK_LISTING_URLS, 3_300);
  const advancedCurrentSnapshot = queueSnapshot("2026-08-03", ARXIV_LISTING_URLS, 3_300);
  const advancedPastweekWindow = {
    announcementDates: ["2026-08-03", ...dates],
    snapshots: [extensionSnapshot, ...snapshots],
  };
  const advancedNow = new Date("2026-08-03T03:00:00.000Z");
  const advancedSelection = selectAuthorizedContinuationSnapshot({
    storedSnapshot: queue.first.job.snapshot,
    currentSnapshot: advancedCurrentSnapshot,
    pastweekWindow: advancedPastweekWindow,
    latestDate,
    expectedDate: queue.first.record.targetDate,
    expectedSnapshotFingerprint: queue.first.record.snapshotFingerprint,
    evidence: queue.first.record.evidence,
    now: advancedNow,
  });
  const advancedQueue = ensureDurableContinuationQueue({
    directory,
    stagingDirectory,
    controlRoot,
    records: queueRecords,
    selectionMode: "aged_checkpoint_recovery",
    expectedLatestDate: latestDate,
    pendingSnapshots: advancedSelection.pendingSnapshots,
    sourceJob,
    sourceCheckpointProvenance,
    automationRuntimeFingerprint: destinationRuntimeFingerprint,
    firstJob: queue.first.job,
    policy: validPolicy(),
    currentSnapshot: advancedCurrentSnapshot,
    pastweekWindow: advancedPastweekWindow,
    attemptId: "run-20260803T030000Z-123456abcdef",
    now: advancedNow,
  });
  assert.deepEqual(advancedQueue.targets, ["2026-07-27", ...dates.toReversed(), "2026-08-03"]);
  assert.doesNotThrow(() => assertAgedRecoveryPlanMatchesQueue(
    plan,
    advancedQueue.entries.map(({ record }) => record),
  ));
  const disconnectedExtension = structuredClone(advancedQueue.entries.at(-1).record);
  disconnectedExtension.expectedLatestDate = "2026-08-04";
  disconnectedExtension.targetDate = "2026-08-05";
  disconnectedExtension.evidence.expectedLatestDate = disconnectedExtension.expectedLatestDate;
  disconnectedExtension.evidence.targetDate = disconnectedExtension.targetDate;
  assert.throws(
    () => assertAgedRecoveryPlanMatchesQueue(plan, [...queueRecords, disconnectedExtension]),
    /Unexpected authorization intersects aged recovery chain at 2026-08-04/u,
  );
  const first = loadActiveDurableRecoveryAuthorization({
    directory,
    latestDate,
  }).active;
  assert.equal(first.selectionMode, "aged_checkpoint_recovery");
  assert.equal(first.targetDate, "2026-07-27");
  assert.equal(first.sourceRuntimeFingerprint, sourceRuntimeFingerprint);
  assert.equal(first.sourceEvaluationRunId, sourceEvaluationRunId);
  assert.equal(
    first.sourceCheckpointProvenance.evidenceSha256,
    sourceCheckpointProvenance.evidenceSha256,
  );
  for (const [anchor, target, mode] of [
    ["2026-07-27", "2026-07-28", "aged_window_continuation"],
    ["2026-07-28", "2026-07-29", "normal"],
    ["2026-07-29", "2026-07-30", "normal"],
    ["2026-07-30", "2026-07-31", "normal"],
  ]) {
    const successor = loadActiveDurableRecoveryAuthorization({
      directory,
      latestDate: anchor,
    }).active;
    assert.equal(successor.selectionMode, mode);
    assert.equal(successor.targetDate, target);
  }
});

test("aged durable queue processes its protected chain without crossing an uncaptured gap", async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "daily-arxiv-aged-queue-test-")));
  const controlRoot = join(root, "control");
  const directory = join(controlRoot, "recovery-authorizations");
  const stagingDirectory = join(controlRoot, "recovery-authorization-staging");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  mkdirSync(stagingDirectory, { mode: 0o700 });
  const latestDate = "2099-07-08";
  const initialDates = ["2099-07-10", "2099-07-09", latestDate];
  const initialSnapshots = [
    queueSnapshot("2099-07-10", ARXIV_PASTWEEK_LISTING_URLS, 1_000),
    queueSnapshot("2099-07-09", ARXIV_PASTWEEK_LISTING_URLS, 900),
    queueSnapshot(latestDate, ARXIV_PASTWEEK_LISTING_URLS, 800, { empty: true }),
  ];
  const initialWindow = {
    announcementDates: initialDates,
    snapshots: initialSnapshots,
  };
  const initialCurrent = queueSnapshot("2099-07-10", ARXIV_LISTING_URLS, 1_000);
  const initialNow = new Date("2099-07-10T03:00:00.000Z");
  const initialSelection = selectBackfillSnapshot({
    currentSnapshot: initialCurrent,
    pastweekWindow: initialWindow,
    latestDate,
    now: initialNow,
  });
  const runtimeFingerprint = "9".repeat(64);
  const firstJob = openCheckpointJob({
    controlRoot,
    snapshot: initialSelection.snapshot,
    snapshotFingerprint: fingerprintSnapshot(initialSelection.snapshot),
    runtimeFingerprint,
    evaluationRunId: RUN_ID,
    now: initialNow,
  });
  const initialQueue = ensureDurableContinuationQueue({
    directory,
    stagingDirectory,
    controlRoot,
    records: [],
    selectionMode: "normal",
    expectedLatestDate: latestDate,
    pendingSnapshots: initialSelection.pendingSnapshots,
    automationRuntimeFingerprint: runtimeFingerprint,
    firstJob,
    policy: validPolicy(),
    currentSnapshot: initialCurrent,
    pastweekWindow: initialWindow,
    attemptId: RUN_ID,
    now: initialNow,
  });
  assert.deepEqual(initialQueue.targets, ["2099-07-09", "2099-07-10"]);
  assert.equal(readdirSync(directory).length, 2);

  const authorizationState = loadActiveDurableRecoveryAuthorization({
    directory,
    latestDate,
  });
  const laterDates = ["2099-07-31", "2099-07-30", "2099-07-29", "2099-07-28", "2099-07-27"];
  const laterSnapshots = laterDates.map((date, index) => (
    queueSnapshot(date, ARXIV_PASTWEEK_LISTING_URLS, 3_100 - (index * 100))
  ));
  const laterWindow = {
    announcementDates: laterDates,
    snapshots: laterSnapshots,
  };
  const laterCurrent = queueSnapshot("2099-07-31", ARXIV_LISTING_URLS, 3_100);
  const laterNow = new Date("2099-07-31T03:00:00.000Z");
  const agedSelection = selectAuthorizedContinuationSnapshot({
    storedSnapshot: initialQueue.first.job.snapshot,
    currentSnapshot: laterCurrent,
    pastweekWindow: laterWindow,
    latestDate,
    expectedDate: authorizationState.active.targetDate,
    expectedSnapshotFingerprint: authorizationState.active.snapshotFingerprint,
    evidence: authorizationState.active.evidence,
    now: laterNow,
  });
  assert.deepEqual(
    agedSelection.pendingSnapshots.map(({ announcementDate }) => announcementDate),
    ["2099-07-09", ...laterDates.toReversed()],
  );

  const resumedQueue = ensureDurableContinuationQueue({
    directory,
    stagingDirectory,
    controlRoot,
    records: authorizationState.records,
    selectionMode: authorizationState.active.selectionMode,
    expectedLatestDate: latestDate,
    pendingSnapshots: agedSelection.pendingSnapshots,
    automationRuntimeFingerprint: runtimeFingerprint,
    firstJob: initialQueue.first.job,
    policy: validPolicy(),
    currentSnapshot: laterCurrent,
    pastweekWindow: laterWindow,
    attemptId: "run-20990731T030000Z-fedcba654321",
    now: laterNow,
  });
  assert.deepEqual(resumedQueue.targets, ["2099-07-09", "2099-07-10"]);
  assert.equal(readdirSync(directory).length, 2);
  assert.equal(loadActiveDurableRecoveryAuthorization({
    directory,
    latestDate: "2099-07-09",
  }).active.targetDate, "2099-07-10");
});

test("durable queue preflights every checkpoint before writing any authorization", async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "daily-arxiv-queue-preflight-test-")));
  const controlRoot = join(root, "control");
  const directory = join(controlRoot, "recovery-authorizations");
  const stagingDirectory = join(controlRoot, "recovery-authorization-staging");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  mkdirSync(stagingDirectory, { mode: 0o700 });
  const latestDate = "2099-01-02";
  const dates = ["2099-01-07", "2099-01-06", "2099-01-05", latestDate];
  const snapshots = [
    queueSnapshot("2099-01-07", ARXIV_PASTWEEK_LISTING_URLS, 700),
    queueSnapshot("2099-01-06", ARXIV_PASTWEEK_LISTING_URLS, 600),
    queueSnapshot("2099-01-05", ARXIV_PASTWEEK_LISTING_URLS, 500),
    queueSnapshot(latestDate, ARXIV_PASTWEEK_LISTING_URLS, 200, { empty: true }),
  ];
  const pastweekWindow = { announcementDates: dates, snapshots };
  const currentSnapshot = queueSnapshot("2099-01-07", ARXIV_LISTING_URLS, 700);
  const now = new Date("2099-01-07T03:00:00.000Z");
  const selection = selectBackfillSnapshot({
    currentSnapshot,
    pastweekWindow,
    latestDate,
    now,
  });
  const runtimeFingerprint = "8".repeat(64);
  const wrongSnapshot = queueSnapshot("2099-01-04", ARXIV_PASTWEEK_LISTING_URLS, 400);
  const mismatchedFirstJob = openCheckpointJob({
    controlRoot,
    snapshot: wrongSnapshot,
    snapshotFingerprint: fingerprintSnapshot(wrongSnapshot),
    runtimeFingerprint,
    evaluationRunId: RUN_ID,
    now,
  });
  assert.throws(() => ensureDurableContinuationQueue({
    directory,
    stagingDirectory,
    controlRoot,
    records: [],
    selectionMode: "normal",
    expectedLatestDate: latestDate,
    pendingSnapshots: selection.pendingSnapshots,
    automationRuntimeFingerprint: runtimeFingerprint,
    firstJob: mismatchedFirstJob,
    policy: validPolicy(),
    currentSnapshot,
    pastweekWindow,
    attemptId: RUN_ID,
    now,
  }), /Destination checkpoint identity does not match queued target 2099-01-05/);
  assert.equal(readdirSync(directory).length, 0);

  const correctFirstJob = openCheckpointJob({
    controlRoot,
    snapshot: selection.snapshot,
    snapshotFingerprint: fingerprintSnapshot(selection.snapshot),
    runtimeFingerprint,
    evaluationRunId: "run-20990107T030000Z-123456abcdef",
    now,
  });
  let creationCount = 0;
  assert.throws(() => ensureDurableContinuationQueue({
    directory,
    stagingDirectory,
    controlRoot,
    records: [],
    selectionMode: "normal",
    expectedLatestDate: latestDate,
    pendingSnapshots: selection.pendingSnapshots,
    automationRuntimeFingerprint: runtimeFingerprint,
    firstJob: correctFirstJob,
    policy: validPolicy(),
    currentSnapshot,
    pastweekWindow,
    attemptId: "run-20990107T030000Z-123456abcdef",
    now,
    createAuthorization: (options) => {
      creationCount += 1;
      if (creationCount === 2) throw new Error("simulated authorization write failure");
      return createDurableRecoveryAuthorization(options);
    },
  }), /simulated authorization write failure/);
  assert.equal(creationCount, 2);
  assert.equal(readdirSync(directory).length, 0);

  const retriedQueue = ensureDurableContinuationQueue({
    directory,
    stagingDirectory,
    controlRoot,
    records: [],
    selectionMode: "normal",
    expectedLatestDate: latestDate,
    pendingSnapshots: selection.pendingSnapshots,
    automationRuntimeFingerprint: runtimeFingerprint,
    firstJob: correctFirstJob,
    policy: validPolicy(),
    currentSnapshot,
    pastweekWindow,
    attemptId: "run-20990107T040000Z-fedcba654321",
    now: new Date("2099-01-07T04:00:00.000Z"),
  });
  assert.deepEqual(retriedQueue.targets, ["2099-01-05", "2099-01-06", "2099-01-07"]);
  assert.equal(readdirSync(directory).length, 3);
});

test("runtime update barrier covers every scheduled runtime dependency", () => {
  for (const path of [
    "AGENTS.md",
    "docs/SCHEDULED_TASK_PROMPT.md",
    "scripts/extract-arxiv-source.mjs",
    "scripts/preflight-staged-category.mjs",
    "scripts/record-source-incomplete.mjs",
    "scripts/run-local-automation.mjs",
    "scripts/validate-staged-reports.mjs",
    "scripts/lib/local-automation.mjs",
    "scripts/lib/macos-schedule.mjs",
    "scripts/lib/arxiv-source.mjs",
    "scripts/lib/aged-recovery-plan.mjs",
    "scripts/lib/checkpoint.mjs",
    "scripts/lib/pipeline.mjs",
    "scripts/lib/source-blocker.mjs",
    "scripts/validate-staged-category.mjs",
  ]) assert.ok(AUTOMATION_RUNTIME_PATHS.includes(path), path);
  assert.match(fingerprintAutomationRuntime(process.cwd()), /^[a-f0-9]{64}$/u);
  const firstCodexRuntime = fingerprintAutomationRuntime(process.cwd(), {
    sha256: "1".repeat(64),
    version: "codex-cli reviewed-a",
  });
  const secondCodexRuntime = fingerprintAutomationRuntime(process.cwd(), {
    sha256: "2".repeat(64),
    version: "codex-cli reviewed-b",
  });
  assert.notEqual(firstCodexRuntime, secondCodexRuntime);
  assert.throws(() => fingerprintAutomationRuntime(process.cwd(), {
    sha256: "not-a-digest",
    version: "codex-cli reviewed",
  }), /Codex identity/);
});

test("runId generation is stable-format and injectable for tests", () => {
  assert.equal(makeRunId(new Date("2099-01-05T12:34:56.789Z"), "abcdef123456"), RUN_ID);
});

test("full-text readiness defers fresh propagation and transient failures but rejects persistent invalid access", () => {
  assert.equal(classifyFullTextReadiness({ ready: true }, { isLatestAnnouncement: true }), "ready");
  assert.equal(classifyFullTextReadiness({ ready: false, unavailable: { status: 404 } }, { isLatestAnnouncement: true }), "defer");
  assert.equal(classifyFullTextReadiness({ ready: false, unavailable: { status: 404 } }, { isLatestAnnouncement: false }), "fail");
  assert.equal(classifyFullTextReadiness({ ready: false, unavailable: { status: 429 } }, { isLatestAnnouncement: false }), "defer");
  assert.equal(classifyFullTextReadiness({ ready: false, unavailable: { status: null } }, { isLatestAnnouncement: true }), "defer");
  assert.equal(classifyFullTextReadiness({ ready: false, unavailable: { status: 403 } }, { isLatestAnnouncement: true }), "fail");
  assert.equal(classifyFullTextReadiness({
    ready: false,
    checks: [{ kind: "pdf", ready: true }],
    unavailable: { kind: "source", status: null },
  }, { isLatestAnnouncement: false }), "ready_pdf_fallback");
  assert.equal(classifyFullTextReadiness({
    ready: false,
    checks: [],
    unavailable: { kind: "pdf", status: null },
  }, { isLatestAnnouncement: false }), "defer");
});

test("Git network retry recognizes the launchd SSH failure without classifying ordinary Git errors", () => {
  assert.equal(isRetryableGitNetworkFailure("ssh: connect to host github.com port 22: Undefined error: 0\nfatal: Could not read from remote repository."), true);
  assert.equal(isRetryableGitNetworkFailure("fatal: pathspec 'missing' did not match any files"), false);
});

test("Codex invocation fixes Sol, High reasoning, closed permissions, and arxiv-only network", () => {
  const args = buildCodexArgs({ worktree: "/repo-automation", runRoot: "/tmp/run" });
  assert.deepEqual(args.slice(0, 2), ["--strict-config", "--model"]);
  assert.ok(args.includes(MODEL_ID));
  assert.ok(args.includes('model_reasoning_effort="high"'));
  assert.ok(args.includes('default_permissions="daily_arxiv_model"'));
  assert.ok(!args.some((value) => value.startsWith("permissions.daily_arxiv_model.extends=")));
  assert.ok(args.some((value) => value.includes('":root"="deny"') && value.includes('":slash_tmp"="deny"') && value.includes('"~/.codex"="deny"')));
  assert.ok(args.some((value) => value.includes('":workspace_roots"={"."="read"}') && value.includes('"/tmp/run"="write"')));
  assert.ok(!args.some((value) => value.startsWith("permissions.daily_arxiv_model.workspace_roots=")));
  assert.ok(args.includes("allow_login_shell=false"));
  assert.ok(args.includes("features.network_proxy.enabled=true"));
  assert.ok(args.some((value) => value.startsWith("permissions.daily_arxiv_model.network=") && value.includes('"arxiv.org"="allow"')));
  assert.ok(!args.includes("--search"));
  assert.ok(!args.some((value) => value.includes("export.arxiv.org")));
  assert.ok(!args.some((value) => value.startsWith("tools.web_search=")));
  assert.ok(args.includes('projects."/repo-automation".trust_level="trusted"'));
  assert.ok(args.includes('shell_environment_policy.set.HOME="/tmp/run/home"'));
  assert.ok(args.includes('shell_environment_policy.set.TMPDIR="/tmp/run"'));
  assert.ok(args.includes('shell_environment_policy.set.GIT_SSH_COMMAND="/usr/bin/false"'));
  assert.ok(args.some((value) => value.includes("SSH_AUTH_SOCK") && value.includes("*TOKEN*")));
  assert.equal(args.includes("--sandbox"), false);
  assert.equal(args.includes("--add-dir"), false);
  assert.deepEqual(args.slice(args.indexOf("--ask-for-approval"), args.indexOf("--ask-for-approval") + 2), ["--ask-for-approval", "never"]);
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.equal(args.at(-1), "-");
});

test("child environment removes API credentials without removing ChatGPT auth state", () => {
  const result = sanitizedChildEnv({
    HOME: "/Users/test",
    CODEX_HOME: "/Users/test/.codex",
    OPENAI_API_KEY: "secret",
    CODEX_API_KEY: "secret",
    GITHUB_TOKEN: "secret",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
  });
  assert.equal(result.HOME, "/Users/test");
  assert.equal(result.CODEX_HOME, "/Users/test/.codex");
  assert.equal(result.OPENAI_API_KEY, undefined);
  assert.equal(result.CODEX_API_KEY, undefined);
  assert.equal(result.GITHUB_TOKEN, undefined);
  assert.equal(result.SSH_AUTH_SOCK, undefined);
  assert.equal(result.GIT_TERMINAL_PROMPT, "0");
  assert.equal(result.GIT_CONFIG_KEY_0, "remote.origin.pushurl");
  assert.match(result.GIT_CONFIG_VALUE_0, /^disabled:/);
});

test("login preflight accepts ChatGPT login and rejects API-key login", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-login-test-"));
  const chatGpt = join(root, "chatgpt-login");
  const apiKey = join(root, "api-login");
  writeFileSync(chatGpt, "#!/bin/sh\necho 'Logged in using ChatGPT'\n");
  writeFileSync(apiKey, "#!/bin/sh\necho 'Logged in using an API key'\n");
  chmodSync(chatGpt, 0o700);
  chmodSync(apiKey, 0o700);
  assert.doesNotThrow(() => assertChatGptLogin(chatGpt));
  assert.throws(() => assertChatGptLogin(apiKey), /not authenticated with ChatGPT/);
});

test("legacy all-category automation prompt fails closed", () => {
  assert.throws(() => buildAutomationPrompt({
    runId: RUN_ID,
    staging: "/tmp/run/staging",
    snapshot: SNAPSHOT,
  }), /Legacy all-category automation is disabled; use buildCategoryAutomationPrompt/);
});

test("category prompt binds one resumable category and forbids ID/index fallback scoring", () => {
  const staging = "/tmp/daily-arxiv-automation-501/run-20990105T123456Z-abcdef123456/staging/quant-ph";
  const prompt = buildCategoryAutomationPrompt({
    evaluationRunId: RUN_ID,
    staging,
    snapshot: SNAPSHOT,
    slug: "quant-ph",
    categoryMetadata: categoryMetadataFixture(),
  });
  assert.match(prompt, /assigned category: quant-ph/);
  assert.match(prompt, /one resumable category/);
  assert.match(prompt, /2099\.00003/);
  assert.doesNotMatch(prompt, /2099\.00002/);
  assert.match(prompt, /Exact original title 1/);
  assert.match(prompt, /Paper-specific abstract evidence 1/);
  assert.match(prompt, /sole source for original title, ordered complete authors, abstract, comments/);
  assert.match(prompt, /preserve TeX backslashes and punctuation byte-for-byte/);
  assert.match(prompt, /host deterministically rebinds those immutable fields/);
  assert.match(prompt, /Do not use export\.arxiv\.org, any \/api\/query endpoint, Web search/);
  assert.match(prompt, /Do not create a placeholder, marker, scratch file/);
  assert.match(prompt, /provisional top min\(12, totalNew\)/);
  assert.match(prompt, /arXiv ID, input index, rank, hash, random value, cyclic template, or fallback formula/);
  assert.match(prompt, /record-source-incomplete\.mjs quant-ph/);
  assert.match(prompt, new RegExp(MODEL_SOURCE_FAILURE_CLASS, "u"));
  assert.doesNotMatch(prompt, /<failure-class>/u);
  assert.match(prompt, /token-free cooldown and source prefetch/);
  assert.match(prompt, /Every paper, not only the first paper or the fully reviewed papers, must contain the exact schema 1\.4 paper-key set/);
  assert.match(prompt, /url, arxivVersion, and submissionType on every paper/);
  assert.match(prompt, /preflight-staged-category\.mjs 2099-01-05 quant-ph/);
  assert.match(prompt, /quant-ph-structure-audit-1\.json/);
  assert.match(prompt, /quant-ph-structure-audit-4\.json/);
  assert.match(prompt, /one batch repair covering every listed missing\/extra key/);
  assert.match(prompt, /Run at most 4 structural audits and 3 structural repair batches/);
  assert.match(prompt, /If structural audit 4 is nonzero, stop with an error/);
  assert.match(prompt, /audit-staged-language\.mjs 2099-01-05/);
  assert.match(prompt, /quant-ph-language-audit-1\.json/);
  assert.match(prompt, /quant-ph-language-audit-5\.json/);
  assert.match(prompt, /Run at most 5 language audits and 4 whole-field batch repairs/);
  assert.match(prompt, /Stop immediately at the first language audit that reports issues=0/);
  assert.match(prompt, /do not run or create any later numbered audit/);
  assert.match(prompt, /first surfaced diagnostic for that field/);
  assert.match(prompt, /Do not merely replace the quoted trigger/);
  assert.match(prompt, /If language audit 5 is nonzero, stop with an error and do not repair again/);
  assert.doesNotMatch(prompt, /language-issues-(?:before|after)\.json/);
  assert.doesNotMatch(prompt, /structure-issues-(?:before|after)\.json/);
  assert.match(prompt, new RegExp(`quant-ph-language-audit-1\\.json" quant-ph ${RUN_ID}`));
  assert.match(prompt, /validate-staged-category\.mjs 2099-01-05 quant-ph/);
  assert.match(prompt, new RegExp(RUN_ID));
  assert.ok(
    prompt.indexOf("structure-audit-4.json") < prompt.indexOf("language-audit-1.json"),
    "every permitted structural preflight must be listed before every language audit",
  );
});

test("host binds canonical immutable metadata without modifying the model file", async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "daily-arxiv-metadata-binding-test-")));
  const path = join(root, `${DATE}-quant-ph.json`);
  const categoryMetadata = categoryMetadataFixture();
  categoryMetadata.papers[0].title = "Maximal R\\'enyi Relative Entropy for $\\alpha>2$";
  const report = {
    reportDate: DATE,
    slug: "quant-ph",
    papers: [{
      arxivId: "2099.00003",
      arxivVersion: "v1",
      submissionType: "new",
      url: "https://arxiv.org/abs/2099.00003",
      title: "Maximal R'enyi Relative Entropy for $\\alpha>2$",
      authors: ["Author 1"],
      primaryCategory: "quant-ph",
      totalScore: 87,
      assessment: "評価内容は変更しない。",
    }],
  };
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });

  const before = readFileSync(path);
  const binding = bindCategoryReportForCheckpoint({ report, categoryMetadata });
  const stored = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(binding.correctedFields, 1);
  assert.match(binding.sourceValueSha256, /^[0-9a-f]{64}$/);
  assert.match(binding.boundValueSha256, /^[0-9a-f]{64}$/);
  assert.notEqual(binding.sourceValueSha256, binding.boundValueSha256);
  assert.equal(binding.report.papers[0].title, categoryMetadata.papers[0].title);
  assert.equal(binding.report.papers[0].totalScore, 87);
  assert.equal(binding.report.papers[0].assessment, "評価内容は変更しない。");
  assert.equal(stored.papers[0].title, report.papers[0].title);
  assert.deepEqual(readFileSync(path), before, "the untrusted model output remains byte-for-byte evidence");
  assert.equal(statSync(path).mode & 0o777, 0o600);

  const unchanged = bindCategoryReportForCheckpoint({ report: binding.report, categoryMetadata });
  assert.equal(unchanged.correctedFields, 0);
  assert.equal(unchanged.sourceValueSha256, unchanged.boundValueSha256);
});

test("category repair prompt uses the same fixed audit protocol without legacy output names", () => {
  const staging = "/tmp/daily-arxiv-automation-501/run-20990105T123456Z-abcdef123456/staging/quant-ph";
  const prompt = buildCategoryRepairPrompt({
    evaluationRunId: RUN_ID,
    staging,
    snapshot: SNAPSHOT,
    slug: "quant-ph",
    draftSha256: "a".repeat(64),
  });
  assert.match(prompt, /quant-ph-structure-audit-1\.json/);
  assert.match(prompt, /quant-ph-structure-audit-4\.json/);
  assert.match(prompt, /quant-ph-language-audit-1\.json/);
  assert.match(prompt, /quant-ph-language-audit-5\.json/);
  assert.match(prompt, new RegExp(`quant-ph-language-audit-1\\.json" quant-ph ${RUN_ID}`));
  assert.doesNotMatch(prompt, /repair-(?:structure|language)/);
  assert.doesNotMatch(prompt, /structure-issues-(?:before|after)/);
  assert.match(prompt, /scores, ranks, and full-text evidence are not repairable in this mode/);
});

test("recoverable checkpoint helper uses the runtime-specific job and receipts an orphan before model orchestration", async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "daily-arxiv-recoverable-helper-test-")));
  const controlRoot = join(root, "control");
  mkdirSync(controlRoot, { mode: 0o700 });
  const runtimeFingerprint = "a".repeat(64);
  const policy = validPolicy();
  const run = { ...validRun(), runId: RUN_ID };
  const reports = Object.fromEntries(CATEGORIES.map((slug) => [slug, validReport(slug, { count: 1, run })]));
  const snapshot = {
    announcementDate: DATE,
    categories: Object.fromEntries(CATEGORIES.map((slug) => [slug, {
      slug,
      sourceUrl: `https://arxiv.org/list/${slug}/new`,
      newCount: 1,
      crosslistCount: 2,
      newIds: [reports[slug].papers[0].arxivId],
    }])),
  };
  const created = openRecoverableCheckpointJob({
    controlRoot,
    snapshot,
    runtimeFingerprint,
    attemptId: RUN_ID,
    policy,
    now: new Date("2099-01-05T12:00:00.000Z"),
  });
  assert.equal(created.checkpointExisted, false);
  assert.equal(created.job.path.endsWith(`/${runtimeFingerprint}`), true);

  const sourcePath = join(root, `${DATE}-quant-ph.json`);
  writeFileSync(sourcePath, `${JSON.stringify(reports["quant-ph"], null, 2)}\n`, { mode: 0o600 });
  chmodSync(sourcePath, 0o600);
  assert.throws(() => importCheckpointCategoryReport({
    job: created.job,
    category: "quant-ph",
    sourcePath,
    attemptId: RUN_ID,
    now: new Date(Number.NaN),
    validateReport: () => true,
  }), /timestamp is invalid/);

  const retryId = "run-20990105T130000Z-123456abcdef";
  const recovered = openRecoverableCheckpointJob({
    controlRoot,
    snapshot,
    runtimeFingerprint,
    attemptId: retryId,
    policy,
    now: new Date("2099-01-05T13:00:00.000Z"),
  });
  assert.equal(recovered.checkpointExisted, true);
  assert.deepEqual(recovered.recoveredCategories, ["quant-ph"]);
  assert.deepEqual(recovered.job.completeCategories, ["quant-ph"]);
  assert.equal(recovered.job.evaluationRunId, RUN_ID, "the first durable evaluation run ID is reused");
  assert.equal(recovered.job.path, created.job.path, "the same runtime-specific job is resumed");
  assert.deepEqual(
    recovered.job.attempts
      .filter((event) => event.stage === "category_recovery" && event.category === "quant-ph")
      .map((event) => [event.attemptId, event.status]),
    [[retryId, "resumed"], [retryId, "completed"]],
  );
});

test("Codex completion gate accepts only the exact validated response", () => {
  assert.equal(validateCodexCompletionResponse("STAGED_REPORTS_VALID\n"), "STAGED_REPORTS_VALID");
  assert.throws(
    () => validateCodexCompletionResponse("ACTION_REQUIRED: STAGED_LANGUAGE_AUDIT_FAILED"),
    /exact validated-completion response/,
  );
  assert.throws(
    () => validateCodexCompletionResponse("ready\nSTAGED_REPORTS_VALID"),
    /exact validated-completion response/,
  );
});

test("the scheduled specification keeps rubric 3.0 anchors and Japanese quality requirements", () => {
  const specification = readFileSync(join(process.cwd(), "docs", "SCHEDULED_TASK_PROMPT.md"), "utf8");
  for (const key of ["broadImpact", "categoryImpact", "originality", "technicalStrength"]) {
    assert.match(specification, new RegExp(`scoreReasons\\.${key}`));
  }
  for (const band of ["0〜5", "6〜10", "11〜14", "15〜17", "18〜20", "21〜23", "24〜25"]) {
    assert.ok((specification.match(new RegExp(band, "g")) ?? []).length >= 4, band);
  }
  assert.match(specification, /Daily arXiv rubric 3\.0/);
  assert.match(specification, /technicalStrength`の18点以上は全文確認/);
  assert.match(specification, /node scripts\/extract-arxiv-source\.mjs/);
  assert.match(specification, /node scripts\/preflight-staged-category\.mjs YYYY-MM-DD/);
  assert.match(specification, /<category>-structure-audit-1\.json/);
  assert.match(specification, /<category>-structure-audit-4\.json/);
  assert.match(specification, /先頭や上位10件だけでなく\*\*全件それぞれ\*\*/);
  assert.match(specification, /特に`url`、`arxivVersion`、`submissionType`を全論文へ入れ/);
  assert.match(specification, /どれかの構造監査が`issues=0`の場合だけ/);
  assert.match(specification, /監査4が非ゼロなら追加修正せず異常終了/);
  assert.match(specification, /言語監査は文章フィールドだけを対象/);
  assert.match(specification, /<category>-language-audit-5\.json" <category> <evaluation-run-id>/);
  assert.match(specification, /node scripts\/validate-staged-category\.mjs YYYY-MM-DD/);
  assert.match(specification, /manifest、completion marker、status fileを作らず/);
  assert.match(specification, /outboxは空のまま/);
  assert.match(specification, /`STAGED_CATEGORY_VALID`になった場合は、それを最後のコマンドとして直ちに終了/);
  assert.match(specification, /最終応答を正確に`STAGED_CATEGORY_VALID`の1行だけ/);
  assert.match(specification, /失敗または未完了の最初のカテゴリだけから再開/);
  assert.match(specification, /モデル評価を繰り返さず公開だけを再試行/);
  assert.match(specification, /全文未確認論文の各軸が24点未満かつ`technicalStrength`が17点以下/);
  assert.match(specification, /`scope: "category"`/);
  assert.match(specification, /`data\/reports\/`、`public\/data\/`、`scripts\/lib\/pipeline\.mjs`、testsを例として読みません/);
  assert.match(specification, /取得成功、ファイルサイズ、節名の検索だけを全文確認の代用にしてはいけません/);
  assert.match(specification, /暫定候補全件へ一括`HEAD`/);
  assert.match(specification, /同じ全件へ`Range GET`を重ねたりして/);
  assert.match(specification, /他候補の可用性検査を続けず/);
  assert.match(specification, /`titleJa`:[^\n]*日本語として自然に読める表示題名/);
  assert.match(specification, /固有名・数式・標準略語だけを英字で残し/);
  assert.match(specification, /`title`にはarXivの原題を一字一句そのまま保存/);
  assert.match(specification, /画面は`titleJa`、`title`、著者名の順/);
  assert.match(specification, /Kerr black hole[^。\n]{0,40}Kerrブラックホール/);
  assert.match(specification, /一般語を英単語のまま日本語の助詞や「する」へ接続しません/);
  assert.match(specification, /`fit`は「フィット」、`echo`は「エコー」/);
  assert.match(specification, /サ変名詞で活用を打ち切らず/);
  assert.match(specification, /`fullTextReviewStatus`は、固有名・数式・標準略語だけを英字で残し/);
  assert.match(specification, /英字で残すのは固有名・数式・標準略語に限り/);
  assert.match(specification, /別論文へそのまま移せる定型文を禁止/);
  assert.match(specification, /abstractLines\[0\].*言い換えにはしません/);
  assert.match(specification, /`concept`へ`abstractLines\[1\]`.*一文そのままコピーしてはいけません/);
  assert.match(specification, /接続語差分で再利用したりしてはいけません/);
  assert.match(specification, /内容語だけを差し替えた短い共通骨格/);
  assert.match(specification, /全体の35%超へ同じ総合点/);
  assert.match(specification, /`totalScore`、`scores`、`rank`/);
  assert.match(specification, /assessment.*点数や`scoreReasons`の反復/);
});

test("Codex discovery honors an absolute CODEX_BIN", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-codex-test-"));
  const binary = join(root, "codex");
  writeFileSync(binary, "#!/bin/sh\nexit 0\n");
  chmodSync(binary, 0o700);
  assert.equal(discoverCodex({ env: { CODEX_BIN: binary, PATH: "" }, home: root }), realpathSync(binary));
  assert.throws(() => discoverCodex({ env: { CODEX_BIN: "codex", PATH: "" }, home: root }), /absolute/);
});

test("scheduled Codex binary is pinned by realpath, SHA-256, and version", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-codex-pin-test-"));
  const binary = join(root, "codex");
  const executedAfterChange = join(root, "changed-binary-executed");
  writeFileSync(binary, "#!/bin/sh\necho 'codex-cli 1.2.3'\n");
  chmodSync(binary, 0o700);
  const identity = codexBinaryIdentity(binary, { HOME: root, PATH: "/usr/bin:/bin" });
  const env = {
    HOME: root,
    PATH: "/usr/bin:/bin",
    CODEX_BIN: identity.path,
    DAILY_ARXIV_CODEX_SHA256: identity.sha256,
    DAILY_ARXIV_CODEX_VERSION: identity.version,
  };
  assert.deepEqual(assertPinnedCodexIdentity(binary, env), identity);
  writeFileSync(binary, `#!/bin/sh\ntouch ${JSON.stringify(executedAfterChange)}\necho 'codex-cli 9.9.9'\n`);
  assert.throws(() => assertPinnedCodexIdentity(binary, env), /identity changed/);
  assert.equal(existsSync(executedAfterChange), false, "a changed Codex binary must not execute before its digest is rejected");
});

test("Codex discovery finds the newest current VS Code extension", async () => {
  const home = await mkdtemp(join(tmpdir(), "daily-arxiv-vscode-test-"));
  const oldBinary = join(home, ".vscode", "extensions", "openai.chatgpt-26.7.9-darwin-arm64", "bin", "macos-aarch64", "codex");
  const newBinary = join(home, ".vscode", "extensions", "openai.chatgpt-26.10.1-darwin-arm64", "bin", "macos-aarch64", "codex");
  mkdirSync(join(oldBinary, ".."), { recursive: true });
  mkdirSync(join(newBinary, ".."), { recursive: true });
  writeFileSync(oldBinary, "#!/bin/sh\nexit 0\n");
  writeFileSync(newBinary, "#!/bin/sh\nexit 0\n");
  chmodSync(oldBinary, 0o700);
  chmodSync(newBinary, 0o700);
  assert.equal(discoverCodex({ env: { PATH: "" }, home, platform: "darwin", arch: "arm64" }), realpathSync(newBinary));
  assert.equal(discoverCodex({ env: { PATH: "" }, home, platform: "darwin", arch: "x64" }), realpathSync(newBinary));
});

test("worktree path is dedicated and constrained to a sibling", () => {
  assert.equal(resolveAgentWorktreeBase("/project/daily-arxiv-data"), "/project/daily-arxiv-data-agent");
  assert.equal(
    resolvePublicationWorktreeBase("/project/daily-arxiv-data-publisher"),
    "/project/daily-arxiv-data-publication",
  );
  assert.throws(() => resolveAgentWorktreeBase("/project/daily-arxiv-data", "/project/daily-arxiv-data"), /must not/);
  assert.throws(() => resolveAgentWorktreeBase("/project/daily-arxiv-data", "/elsewhere/automation"), /sibling/);
  assert.throws(
    () => resolvePublicationWorktreeBase("/project/daily-arxiv-data-publisher", "/elsewhere/publication"),
    /sibling/,
  );
});

test("publisher control accepts only a remote fast-forward and never resets local-ahead commits", () => {
  const oldHead = "a".repeat(40);
  const remoteHead = "b".repeat(40);
  assert.equal(assertPublisherControlFastForward({
    head: oldHead,
    originMain: oldHead,
    isAncestor: true,
  }), "current");
  assert.equal(assertPublisherControlFastForward({
    head: oldHead,
    originMain: remoteHead,
    isAncestor: true,
  }), "fast_forward");
  assert.throws(() => assertPublisherControlFastForward({
    head: remoteHead,
    originMain: oldHead,
    isAncestor: false,
  }), /local-ahead or divergent commit.*not switched or reset/su);
});

test("publisher control runtime verification leaves its clean ancestor checkout byte-for-byte at the reviewed commit", async () => {
  const parent = realpathSync(await mkdtemp(join(tmpdir(), "daily-arxiv-publisher-control-test-")));
  const repository = join(parent, "repository");
  const control = join(parent, "daily-arxiv-data-publisher");
  mkdirSync(repository);
  runFixtureGit(repository, ["init", "--quiet"]);
  runFixtureGit(repository, ["config", "user.name", "Daily arXiv Test"]);
  runFixtureGit(repository, ["config", "user.email", "daily-arxiv-test@example.invalid"]);
  runFixtureGit(repository, ["remote", "add", "origin", "git@github.com:hiroki-takeda/daily-arxiv-data.git"]);
  writeFileSync(join(repository, "base.txt"), "reviewed runtime\n");
  runFixtureGit(repository, ["add", "base.txt"]);
  runFixtureGit(repository, ["commit", "--quiet", "-m", "reviewed runtime"]);
  const reviewedHead = runFixtureGit(repository, ["rev-parse", "HEAD"]);
  writeFileSync(join(repository, "data-only.txt"), "new published data\n");
  runFixtureGit(repository, ["add", "data-only.txt"]);
  runFixtureGit(repository, ["commit", "--quiet", "-m", "data-only remote advance"]);
  const originMain = runFixtureGit(repository, ["rev-parse", "HEAD"]);
  runFixtureGit(repository, ["update-ref", "refs/remotes/origin/main", originMain]);
  runFixtureGit(repository, ["worktree", "add", "--quiet", "--detach", control, reviewedHead]);

  assert.equal(verifyPublisherControlRuntime(control), originMain);
  assert.equal(runFixtureGit(control, ["rev-parse", "HEAD"]), reviewedHead);
  assert.equal(runFixtureGit(control, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
  assert.equal(readFileSync(join(control, "base.txt"), "utf8"), "reviewed runtime\n");
  assert.equal(existsSync(join(control, "data-only.txt")), false);
});

test("publication worktrees reuse only clean origin/main and preserve interrupted or ahead candidates", async () => {
  const parent = realpathSync(await mkdtemp(join(tmpdir(), "daily-arxiv-publication-worktree-test-")));
  const repository = join(parent, "daily-arxiv-data-publisher");
  mkdirSync(repository);
  runFixtureGit(repository, ["init", "--quiet"]);
  runFixtureGit(repository, ["config", "user.name", "Daily arXiv Test"]);
  runFixtureGit(repository, ["config", "user.email", "daily-arxiv-test@example.invalid"]);
  runFixtureGit(repository, ["remote", "add", "origin", "git@github.com:hiroki-takeda/daily-arxiv-data.git"]);
  writeFileSync(join(repository, "base.txt"), "base\n");
  runFixtureGit(repository, ["add", "base.txt"]);
  runFixtureGit(repository, ["commit", "--quiet", "-m", "base"]);
  const originMain = runFixtureGit(repository, ["rev-parse", "HEAD"]);
  const base = resolvePublicationWorktreeBase(repository);

  const first = preparePublicationWorktree(repository, base, originMain, RUN_ID);
  assert.equal(first.worktree, base);
  assert.equal(first.reused, false);
  const reused = preparePublicationWorktree(
    repository,
    base,
    originMain,
    "run-20990105T130000Z-123456abcdef",
  );
  assert.equal(reused.worktree, base);
  assert.equal(reused.reused, true);

  writeFileSync(join(base, "ahead.txt"), "preserved local commit\n");
  runFixtureGit(base, ["add", "ahead.txt"]);
  runFixtureGit(base, ["commit", "--quiet", "-m", "local ahead evidence"]);
  const aheadHead = runFixtureGit(base, ["rev-parse", "HEAD"]);
  const afterAhead = preparePublicationWorktree(
    repository,
    base,
    originMain,
    "run-20990105T140000Z-123456abcdef",
  );
  assert.notEqual(afterAhead.worktree, base);
  assert.equal(runFixtureGit(base, ["rev-parse", "HEAD"]), aheadHead);
  assert.equal(runFixtureGit(base, ["status", "--porcelain=v1", "--untracked-files=all"]), "");

  writeFileSync(join(afterAhead.worktree, "interrupted.tmp"), "dirty evidence\n");
  const afterDirty = preparePublicationWorktree(
    repository,
    base,
    originMain,
    "run-20990105T150000Z-123456abcdef",
  );
  assert.notEqual(afterDirty.worktree, afterAhead.worktree);
  assert.equal(readFileSync(join(afterAhead.worktree, "interrupted.tmp"), "utf8"), "dirty evidence\n");
  assert.equal(runFixtureGit(afterDirty.worktree, ["rev-parse", "HEAD"]), originMain);
  assert.equal(runFixtureGit(afterDirty.worktree, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
});

test("single-run lock refuses overlap and releases only its own lock", async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "daily-arxiv-lock-test-")));
  const lock = join(root, "active-run.lock");
  const first = {
    schemaVersion: "1.0",
    pid: 4242,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    hostname: hostname(),
    runId: RUN_ID,
    nonce: "a".repeat(32),
    startedAt: "2099-01-05T12:34:56.000Z",
  };
  const release = acquireLock(lock, first);
  assert.throws(() => acquireLock(lock, { ...first, nonce: "b".repeat(32) }, {
    now: new Date("2099-01-05T12:35:00.000Z"),
    processAlive: () => true,
  }), /active/);
  release();
  assert.equal(existsSync(lock), false);
  const releaseAgain = acquireLock(lock, { ...first, nonce: "c".repeat(32) });
  releaseAgain();
});

test("a dead old lock is preserved as stale and does not permanently stop automation", async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "daily-arxiv-stale-lock-test-")));
  const lock = join(root, "active-run.lock");
  const first = {
    schemaVersion: "1.0",
    pid: 4242,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    hostname: hostname(),
    runId: RUN_ID,
    nonce: "d".repeat(32),
    startedAt: "2099-01-05T00:00:00.000Z",
  };
  acquireLock(lock, first);
  const second = {
    ...first,
    pid: 4343,
    runId: "run-20990105T183456Z-fedcba654321",
    nonce: "e".repeat(32),
    startedAt: "2099-01-05T18:34:56.000Z",
  };
  const release = acquireLock(lock, second, {
    now: new Date("2099-01-05T18:34:56.000Z"),
    processAlive: () => false,
  });
  assert.equal(readdirSync(join(root, "stale-locks")).length, 1);
  release();
});

test("a failed new lock write archives only its own incomplete inode", async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "daily-arxiv-incomplete-lock-test-")));
  const lock = join(root, "active-run.lock");
  const owner = {
    schemaVersion: "1.0",
    pid: 4242,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    hostname: hostname(),
    runId: RUN_ID,
    nonce: "f".repeat(32),
    startedAt: "2099-01-05T00:00:00.000Z",
  };
  assert.throws(() => acquireLock(lock, owner, {
    writeOwner: () => { throw new Error("injected lock write failure"); },
  }), /incomplete staged lock preserved/);
  assert.equal(existsSync(lock), false);
  assert.equal(readdirSync(root).filter((name) => name.startsWith("incomplete-")).length, 1);
});

test("active lock publication is atomic across write and exclusive-link failures", async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "daily-arxiv-atomic-lock-test-")));
  const lock = join(root, "active-run.lock");
  const owner = {
    schemaVersion: "1.0",
    pid: 4242,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    hostname: hostname(),
    runId: RUN_ID,
    nonce: "1".repeat(32),
    startedAt: "2099-01-05T00:00:00.000Z",
  };
  assert.throws(() => acquireLock(lock, owner, {
    writeOwner: (descriptor, content) => {
      assert.equal(existsSync(lock), false, "partial staged JSON must never appear at the active path");
      writeFileSync(descriptor, content);
    },
    publishLock: () => {
      assert.equal(existsSync(lock), false, "active path remains absent immediately before exclusive publication");
      const error = new Error("simulated kill before atomic link");
      error.code = "EIO";
      throw error;
    },
  }), /simulated kill before atomic link/);
  assert.equal(existsSync(lock), false);
  assert.equal(readdirSync(root).filter((name) => name.startsWith("incomplete-")).length, 1);

  const release = acquireLock(lock, { ...owner, nonce: "2".repeat(32) });
  assert.deepEqual(JSON.parse(readFileSync(lock, "utf8")), { ...owner, nonce: "2".repeat(32) });
  release();
});

test("an old malformed owned lock is preserved and recovered, while recent or unsafe locks fail closed", async () => {
  const owner = {
    schemaVersion: "1.0",
    pid: 4242,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    hostname: hostname(),
    runId: RUN_ID,
    nonce: "3".repeat(32),
    startedAt: "2099-01-05T12:00:00.000Z",
  };
  const recoverRoot = realpathSync(await mkdtemp(join(tmpdir(), "daily-arxiv-malformed-lock-recover-")));
  const recoverLock = join(recoverRoot, "active-run.lock");
  writeFileSync(recoverLock, "{\"schemaVersion\":\"1.0\",", { mode: 0o600 });
  utimesSync(recoverLock, new Date("2099-01-05T00:00:00.000Z"), new Date("2099-01-05T00:00:00.000Z"));
  const release = acquireLock(recoverLock, owner, {
    now: new Date("2099-01-05T06:00:00.000Z"),
    processAlive: () => false,
  });
  const preserved = readdirSync(join(recoverRoot, "stale-locks"));
  assert.equal(preserved.length, 1);
  assert.match(preserved[0], /^malformed-\d+-\d+-[a-f0-9]{64}\.lock$/u);
  assert.equal(readFileSync(join(recoverRoot, "stale-locks", preserved[0]), "utf8"), "{\"schemaVersion\":\"1.0\",");
  release();

  const recentRoot = realpathSync(await mkdtemp(join(tmpdir(), "daily-arxiv-malformed-lock-recent-")));
  const recentLock = join(recentRoot, "active-run.lock");
  writeFileSync(recentLock, "{", { mode: 0o600 });
  assert.throws(() => acquireLock(recentLock, owner, {
    now: new Date(),
    processAlive: () => false,
  }), /recently interrupted malformed run lock/);
  assert.equal(readFileSync(recentLock, "utf8"), "{");

  const broadRoot = realpathSync(await mkdtemp(join(tmpdir(), "daily-arxiv-malformed-lock-broad-")));
  const broadLock = join(broadRoot, "active-run.lock");
  writeFileSync(broadLock, "{", { mode: 0o600 });
  chmodSync(broadLock, 0o644);
  assert.throws(() => acquireLock(broadLock, owner), /owner-only mode 0600/);
  assert.equal(readFileSync(broadLock, "utf8"), "{");

  const linkedRoot = realpathSync(await mkdtemp(join(tmpdir(), "daily-arxiv-malformed-lock-link-")));
  const target = join(linkedRoot, "target.lock");
  const linkedLock = join(linkedRoot, "active-run.lock");
  writeFileSync(target, "{", { mode: 0o600 });
  symlinkSync(target, linkedLock);
  assert.throws(() => acquireLock(linkedLock, owner), /not a safe real regular file/);
  assert.equal(readFileSync(target, "utf8"), "{");
});

test("lock/control state and host staging stay outside model-writable system temp", () => {
  const paths = runPaths(RUN_ID, { uid: 501, controlRoot: "/Users/test/Library/Application Support/Daily arXiv" });
  assert.equal(paths.lock, "/Users/test/Library/Application Support/Daily arXiv/active-run.lock");
  assert.ok(paths.runRoot.startsWith("/tmp/daily-arxiv-automation-501/"));
  assert.equal(paths.hostStaging, `/Users/test/Library/Application Support/Daily arXiv/host-staging/${RUN_ID}`);
  assert.equal(paths.categoryStaging["quant-ph"], `${paths.runRoot}/staging/quant-ph`);
  assert.equal(paths.codexLogs["quant-ph"], `/Users/test/Library/Application Support/Daily arXiv/logs/${RUN_ID}.quant-ph.codex.log`);
  assert.equal(paths.agedRecoveryPlans, "/Users/test/Library/Application Support/Daily arXiv/aged-recovery-plans");
  assert.equal(paths.agedRecoveryPlanStaging, "/Users/test/Library/Application Support/Daily arXiv/aged-recovery-plan-staging");
  assert.ok(!paths.hostStaging.startsWith("/tmp/"));
  assert.ok(!paths.lock.startsWith("/tmp/"));
});

test("reports are copied into an initially empty host-only staging directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-copy-test-"));
  const source = join(root, "model");
  const host = join(root, "host");
  mkdirSync(source);
  mkdirSync(host);
  for (const [index, category] of CATEGORIES.entries()) {
    writeFileSync(join(source, `${DATE}-${category}.json`), `${JSON.stringify({ slug: category, value: index })}\n`);
  }
  const reports = copyReportsToHostStaging({ sourceDirectory: source, hostDirectory: host, date: DATE });
  assert.deepEqual(Object.keys(reports), CATEGORIES);
  assert.deepEqual(readdirSync(host).sort(), CATEGORIES.map((category) => `${DATE}-${category}.json`).sort());
  assert.throws(
    () => copyReportsToHostStaging({ sourceDirectory: source, hostDirectory: host, date: DATE }),
    /start empty/,
  );
});

test("host output layout requires exact regular reports and an empty outbox", async () => {
  const valid = await fixture();
  for (const category of CATEGORIES) writeFileSync(join(valid.staging, `${DATE}-${category}.json`), "{}\n");
  assert.deepEqual(
    validateModelOutputLayout({
      stagingDirectory: valid.staging,
      outboxDirectory: join(valid.root, "outbox"),
      date: DATE,
    }),
    { date: DATE, files: CATEGORIES.map((category) => `${DATE}-${category}.json`) },
  );

  const nonemptyOutbox = await fixture();
  for (const category of CATEGORIES) writeFileSync(join(nonemptyOutbox.staging, `${DATE}-${category}.json`), "{}\n");
  writeFileSync(nonemptyOutbox.manifest, "");
  assert.throws(
    () => validateModelOutputLayout({
      stagingDirectory: nonemptyOutbox.staging,
      outboxDirectory: join(nonemptyOutbox.root, "outbox"),
      date: DATE,
    }),
    /outbox directory must remain empty/,
  );

  const extra = await fixture();
  for (const category of CATEGORIES) writeFileSync(join(extra.staging, `${DATE}-${category}.json`), "{}\n");
  writeFileSync(join(extra.staging, "extra.json"), "{}\n");
  assert.throws(
    () => validateModelOutputLayout({
      stagingDirectory: extra.staging,
      outboxDirectory: join(extra.root, "outbox"),
      date: DATE,
    }),
    /staging directory must contain exactly/,
  );

  const linked = await fixture();
  for (const category of CATEGORIES.slice(1)) writeFileSync(join(linked.staging, `${DATE}-${category}.json`), "{}\n");
  const target = join(linked.root, "target.json");
  writeFileSync(target, "{}\n");
  symlinkSync(target, join(linked.staging, `${DATE}-${CATEGORIES[0]}.json`));
  assert.throws(
    () => validateModelOutputLayout({
      stagingDirectory: linked.staging,
      outboxDirectory: join(linked.root, "outbox"),
      date: DATE,
    }),
    /symlink/,
  );
});

test("category output layout accepts exactly one assigned regular report", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-category-layout-test-"));
  const staging = join(root, "quant-ph");
  const outbox = join(root, "outbox");
  mkdirSync(staging);
  mkdirSync(outbox);
  const report = join(staging, `${DATE}-quant-ph.json`);
  writeFileSync(report, "{}\n");
  assert.deepEqual(validateCategoryModelOutputLayout({
    stagingDirectory: staging,
    outboxDirectory: outbox,
    date: DATE,
    slug: "quant-ph",
  }), { date: DATE, slug: "quant-ph", path: report });
  writeFileSync(join(staging, "extra.json"), "{}\n");
  assert.throws(() => validateCategoryModelOutputLayout({
    stagingDirectory: staging,
    outboxDirectory: outbox,
    date: DATE,
    slug: "quant-ph",
  }), /exactly/);
});

test("source-incomplete layout accepts only one snapshot-bound receipt and no staged report", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-source-blocker-layout-test-"));
  const blockers = join(root, "blockers");
  const staging = join(root, "staging");
  const outbox = join(root, "outbox");
  mkdirSync(blockers);
  mkdirSync(staging);
  mkdirSync(outbox);
  const blockerPath = join(blockers, "quant-ph.json");
  const receipt = {
    schemaVersion: "1.0",
    status: "source_incomplete",
    arxivId: "2099.00003",
    failureClass: MODEL_SOURCE_FAILURE_CLASS,
    provisionalCandidateIds: ["2099.00003"],
  };
  writeFileSync(blockerPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  assert.deepEqual(validateCategorySourceBlockerLayout({
    blockerDirectory: blockers,
    blockerPath,
    stagingDirectory: staging,
    outboxDirectory: outbox,
    snapshot: SNAPSHOT,
    slug: "quant-ph",
  }), receipt);

  writeFileSync(join(staging, `${DATE}-quant-ph.json`), "{}\n");
  assert.deepEqual(validateCategorySourceBlockerLayout({
    blockerDirectory: blockers,
    blockerPath,
    stagingDirectory: staging,
    outboxDirectory: outbox,
    snapshot: SNAPSHOT,
    slug: "quant-ph",
    allowProvisionalReport: true,
  }), receipt);
  assert.throws(() => validateCategorySourceBlockerLayout({
    blockerDirectory: blockers,
    blockerPath,
    stagingDirectory: staging,
    outboxDirectory: outbox,
    snapshot: SNAPSHOT,
    slug: "quant-ph",
  }), /staging must remain empty/);
  assert.throws(
    () => assertGenericCategoryDraftRescueAllowed(realpathSync(blockerPath)),
    /not eligible for generic draft rescue/,
  );
  assert.equal(
    assertGenericCategoryDraftRescueAllowed(join(root, "absent-source-blocker.json")),
    true,
  );
});

test("elapsed source blocker prefetch checks fixed candidates without model tokens", async () => {
  const runRoot = await mkdtemp(join(tmpdir(), "daily-arxiv-prefetch-test-"));
  const receipt = {
    schemaVersion: "1.0",
    status: "source_incomplete",
    arxivId: "2099.00003",
    failureClass: MODEL_SOURCE_FAILURE_CLASS,
    provisionalCandidateIds: ["2099.00003"],
  };
  const calls = [];
  const ready = await prefetchSourceBlockerCandidates({
    receipt,
    snapshot: SNAPSHOT,
    slug: "quant-ph",
    paths: { runRoot },
    extractor: async (arxivId, options) => {
      calls.push({ arxivId, options });
    },
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.prefetchedCount, 1);
  assert.deepEqual(calls.map(({ arxivId }) => arxivId), ["2099.00003"]);
  assert.equal(calls[0].options.env.TMPDIR, runRoot);
  assert.equal(calls[0].options.maxAttempts, 2);

  const unavailable = await prefetchSourceBlockerCandidates({
    receipt,
    snapshot: SNAPSHOT,
    slug: "quant-ph",
    paths: { runRoot },
    extractor: typedUnavailableSource,
    fallbackProbe: async (arxivId) => ({
      ready: false,
      arxivId,
      url: `https://arxiv.org/pdf/${arxivId}v1`,
      status: null,
      reason: "fetch_error",
    }),
  });
  assert.equal(unavailable.ready, false);
  assert.equal(unavailable.arxivId, "2099.00003");
});

test("source prefetch uses exact-v1 PDF fallback but fails closed for unsafe extractor errors", async () => {
  const runRoot = await mkdtemp(join(tmpdir(), "daily-arxiv-prefetch-fallback-test-"));
  const receipt = {
    schemaVersion: "1.0",
    status: "source_incomplete",
    arxivId: "2099.00003",
    failureClass: MODEL_SOURCE_FAILURE_CLASS,
    provisionalCandidateIds: ["2099.00003"],
  };
  const pdfFallback = async (arxivId) => ({
    ready: true,
    arxivId,
    url: `https://arxiv.org/pdf/${arxivId}v1`,
    status: 200,
    reason: null,
  });

  const networkFallback = await prefetchSourceBlockerCandidates({
    receipt,
    snapshot: SNAPSHOT,
    slug: "quant-ph",
    paths: { runRoot },
    extractor: typedUnavailableSource,
    fallbackProbe: pdfFallback,
  });
  assert.equal(networkFallback.ready, true);
  assert.equal(networkFallback.prefetchedCount, 0);
  assert.equal(networkFallback.unsupported[0].kind, "eprint_unavailable");
  assert.equal(networkFallback.unsupported[0].officialPdfUrl, "https://arxiv.org/pdf/2099.00003v1");

  const formatFallback = await prefetchSourceBlockerCandidates({
    receipt,
    snapshot: SNAPSHOT,
    slug: "quant-ph",
    paths: { runRoot },
    extractor: async () => parseArxivSourceArchive(Buffer.from("%PDF-1.7\n"), "2099.00003"),
    fallbackProbe: pdfFallback,
  });
  assert.equal(formatFallback.ready, true);
  assert.equal(formatFallback.unsupported[0].kind, "source_format_unsupported");

  let fallbackCalled = false;
  await assert.rejects(() => prefetchSourceBlockerCandidates({
    receipt,
    snapshot: SNAPSHOT,
    slug: "quant-ph",
    paths: { runRoot },
    extractor: async () => {
      throw new TypeError("internal extractor invariant broke on unsafe path traversal");
    },
    fallbackProbe: async () => {
      fallbackCalled = true;
      return pdfFallback("2099.00003");
    },
  }), /path traversal/u);
  assert.equal(fallbackCalled, false);

  for (const unsafeError of [
    new Error("Unsafe archive path named network-timeout-HTTP 503.tex escaped extraction root"),
    Object.assign(new Error("Permission denied after network timeout HTTP 503"), {
      code: "EACCES",
      retryable: true,
    }),
    new Error("Source redirect validation failed after HTTP 503"),
    Object.assign(new Error("forged typed source failure"), {
      code: "ARXIV_SOURCE_UNAVAILABLE",
    }),
  ]) {
    let unsafeFallbackCalled = false;
    await assert.rejects(() => prefetchSourceBlockerCandidates({
      receipt,
      snapshot: SNAPSHOT,
      slug: "quant-ph",
      paths: { runRoot },
      extractor: async () => {
        throw unsafeError;
      },
      fallbackProbe: async () => {
        unsafeFallbackCalled = true;
        return pdfFallback("2099.00003");
      },
    }), new RegExp(unsafeError.message.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    assert.equal(unsafeFallbackCalled, false);
  }
});

test("official PDF fallback probe is version-fixed, bounded, and rejects redirects", async () => {
  let request;
  const ready = await probeOfficialVersionFixedPdf("2099.00003", {
    timeoutMs: 100,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        status: 200,
        ok: true,
        url,
        headers: new Headers({ "content-type": "application/pdf" }),
      };
    },
  });
  assert.equal(ready.ready, true);
  assert.equal(request.url, "https://arxiv.org/pdf/2099.00003v1");
  assert.equal(request.options.method, "HEAD");
  assert.equal(request.options.redirect, "manual");
  assert.equal(request.options.credentials, "omit");

  const unavailable = await probeOfficialVersionFixedPdf("2099.00003", {
    timeoutMs: 100,
    fetchImpl: async (url) => ({
      status: 404,
      ok: false,
      url,
      headers: new Headers({ "content-type": "text/html" }),
    }),
  });
  assert.equal(unavailable.ready, false);
  assert.equal(unavailable.reason, "http_status");

  await assert.rejects(() => probeOfficialVersionFixedPdf("2099.00003", {
    timeoutMs: 100,
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      url: "https://example.com/paper.pdf",
      headers: new Headers({ "content-type": "application/pdf" }),
    }),
  }), /unexpected URL/u);
});

test("protected draft repairs bypass generation backoff and source alerts repeat every third source failure", () => {
  const attempts = [{
    at: "2026-07-27T09:00:00.000Z",
    attemptId: "run-failed",
    stage: "category_generation",
    status: "failed",
    category: "quant-ph",
    message: "Generation failed without a draft.",
  }];
  assert.equal(computeCategoryRetryState({
    execution: { mode: "repair" },
    attempts,
    category: "quant-ph",
    now: new Date("2026-07-27T10:00:00.000Z"),
  }), null);
  assert.equal(computeCategoryRetryState({
    execution: { mode: "generation" },
    attempts,
    category: "quant-ph",
    now: new Date("2026-07-27T10:00:00.000Z"),
  }).shouldDefer, true);
  assert.equal(sourceFailureNeedsAttention(0), false);
  assert.equal(sourceFailureNeedsAttention(1), false);
  assert.equal(sourceFailureNeedsAttention(2), true);
  assert.equal(sourceFailureNeedsAttention(3), false);
  assert.equal(sourceFailureNeedsAttention(5), true);
  assert.equal(sourceFailureNeedsAttention(6), false);
});

test("repair exhaustion notification states retained draft and automatic cooldown recovery", () => {
  assert.match(macNotificationBody("repair_fallback"), /retained a protected draft/u);
  assert.match(macNotificationBody("repair_fallback"), /retry automatically after cooldown/u);
  assert.equal(macNotificationBody("unknown"), null);
});

test("a source receipt survives an asynchronous command transport error for host validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-receipt-transport-test-"));
  const blocker = join(root, "quant-ph.json");
  const commandError = new Error("Codex stream terminated after receipt write");
  const result = await invokeCodexCategory({
    codexBin: "/usr/bin/false",
    worktree: root,
    runRoot: root,
    logPath: join(root, "codex.log"),
    prompt: "bounded test",
    sourceBlockerPath: blocker,
    commandRunner: async () => {
      await Promise.resolve();
      writeFileSync(blocker, "{}\n", { mode: 0o600 });
      throw commandError;
    },
  });
  assert.equal(result, "");
  await assert.rejects(() => invokeCodexCategory({
    codexBin: "/usr/bin/false",
    worktree: root,
    runRoot: root,
    logPath: join(root, "codex-2.log"),
    prompt: "bounded test",
    sourceBlockerPath: join(root, "absent.json"),
    commandRunner: async () => {
      await Promise.resolve();
      throw commandError;
    },
  }), /stream terminated/u);
});

test("a successful run removes only its own temporary directories and Codex log", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-success-cleanup-test-"));
  const base = join(root, "temp");
  const controlRoot = join(root, "control");
  const logDirectory = join(controlRoot, "logs");
  const paths = {
    base,
    controlRoot,
    logDirectory,
    runRoot: join(base, RUN_ID),
    hostStaging: join(controlRoot, "host-staging", RUN_ID),
    codexLog: join(logDirectory, `${RUN_ID}.codex.log`),
  };
  mkdirSync(paths.runRoot, { recursive: true });
  mkdirSync(paths.hostStaging, { recursive: true });
  mkdirSync(logDirectory, { recursive: true });
  writeFileSync(join(paths.runRoot, "temporary.pdf"), "temporary");
  writeFileSync(join(paths.hostStaging, "report.json"), "{}\n");
  writeFileSync(paths.codexLog, "completed\n");
  const unrelated = join(root, "keep.txt");
  writeFileSync(unrelated, "keep\n");

  removeSuccessfulRunArtifacts(paths);

  assert.equal(existsSync(paths.runRoot), false);
  assert.equal(existsSync(paths.hostStaging), false);
  assert.equal(existsSync(paths.codexLog), false);
  assert.equal(readFileSync(unrelated, "utf8"), "keep\n");
});

test("successful-run cleanup rejects paths outside the exact run scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-cleanup-guard-test-"));
  const base = join(root, "temp");
  const controlRoot = join(root, "control");
  const logDirectory = join(controlRoot, "logs");
  const outside = join(root, "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "keep.txt"), "keep\n");
  assert.throws(() => removeSuccessfulRunArtifacts({
    base,
    controlRoot,
    logDirectory,
    runRoot: outside,
    hostStaging: join(controlRoot, "host-staging", RUN_ID),
    codexLog: join(logDirectory, `${RUN_ID}.codex.log`),
  }), /Invalid automation runId|outside the exact/);
  assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "keep\n");
});

test("streamed Codex-style output beyond 20 MiB is drained with bounded capture and an audited log", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-log-limit-test-"));
  const log = join(root, "captured.log");
  const stderrBytes = 20 * 1024 * 1024 + 4096;
  const stdout = "STAGED_CATEGORY_VALID\n";
  const result = await runStreamingCommand(process.execPath, [
    "-e",
    `process.stderr.write(Buffer.alloc(${stderrBytes}, 120), () => process.stdout.write(${JSON.stringify(stdout)}))`,
  ], {
    cwd: root,
    outputPath: log,
    maxOutputBytes: 8192,
    maxCapturedStreamBytes: 1024,
    allowFailure: true,
    timeout: 30_000,
    isolatedProcessGroup: true,
  });

  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, stdout);
  assert.equal(result.stdoutTruncated, false);
  assert.equal(result.stderr, "x".repeat(1024));
  assert.equal(result.stderrTruncated, true);
  assert.equal(result.timedOut, false);
  assert.ok(statSync(log).size <= 8192);
  assert.equal(statSync(log).mode & 0o777, 0o600);

  const audit = readHostStreamAudit(log);
  const chunk = Buffer.alloc(64 * 1024, 120);
  const expectedStderrHash = createHash("sha256");
  let remaining = stderrBytes;
  while (remaining > 0) {
    const length = Math.min(remaining, chunk.length);
    expectedStderrHash.update(chunk.subarray(0, length));
    remaining -= length;
  }
  assert.equal(audit.status, 0);
  assert.equal(audit.signal, null);
  assert.equal(audit.timedOut, false);
  assert.equal(audit.stdout.bytes, Buffer.byteLength(stdout));
  assert.equal(audit.stdout.sha256, createHash("sha256").update(stdout).digest("hex"));
  assert.equal(audit.stdout.captureTruncated, false);
  assert.equal(audit.stderr.bytes, stderrBytes);
  assert.equal(audit.stderr.sha256, expectedStderrHash.digest("hex"));
  assert.equal(audit.stderr.captureTruncated, true);
  assert.equal(audit.stderr.logTruncated, true);
});

test("Codex category invocation awaits its asynchronous runner", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-async-runner-test-"));
  let observedOptions;
  const result = await invokeCodexCategory({
    codexBin: "/usr/bin/false",
    worktree: root,
    runRoot: root,
    logPath: join(root, "codex.log"),
    prompt: "bounded prompt",
    sourceBlockerPath: join(root, "absent.json"),
    commandRunner: async (_command, _args, options) => {
      await new Promise((resolvePromise) => globalThis.setTimeout(resolvePromise, 5));
      observedOptions = options;
      return { status: 0, signal: null, stdout: "STAGED_CATEGORY_VALID\n", stderr: "" };
    },
  });
  assert.equal(result, "STAGED_CATEGORY_VALID");
  assert.equal(observedOptions.outputPath, join(root, "codex.log"));
  assert.equal(observedOptions.allowFailure, true);
  assert.equal(observedOptions.isolatedProcessGroup, true);

  await assert.rejects(() => invokeCodexCategory({
    codexBin: "/usr/bin/false",
    worktree: root,
    runRoot: root,
    logPath: join(root, "codex-signal.log"),
    prompt: "bounded prompt",
    sourceBlockerPath: join(root, "absent-signal.json"),
    commandRunner: async () => ({ status: null, signal: "SIGTERM", stdout: "", stderr: "" }),
  }), /failed \(SIGTERM\)/u);
});

test("streaming command preserves nonzero exit and signal results under allowFailure", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-stream-exit-test-"));
  const nonzero = await runStreamingCommand(process.execPath, ["-e", "process.stderr.write('failed'); process.exit(7)"], {
    cwd: root,
    outputPath: join(root, "nonzero.log"),
    allowFailure: true,
    isolatedProcessGroup: true,
  });
  assert.equal(nonzero.status, 7);
  assert.equal(nonzero.signal, null);
  assert.equal(nonzero.stderr, "failed");

  await assert.rejects(() => runStreamingCommand(process.execPath, ["-e", "process.exit(7)"], {
    cwd: root,
    outputPath: join(root, "rejected.log"),
    isolatedProcessGroup: true,
  }), /failed \(7\)/u);

  const signaled = await runStreamingCommand(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"], {
    cwd: root,
    outputPath: join(root, "signal.log"),
    allowFailure: true,
    isolatedProcessGroup: true,
  });
  assert.equal(signaled.status, null);
  assert.equal(signaled.signal, "SIGTERM");
  const signalAudit = readHostStreamAudit(join(root, "signal.log"));
  assert.equal(signalAudit.status, null);
  assert.equal(signalAudit.signal, "SIGTERM");

  await assert.rejects(() => runStreamingCommand(
    process.execPath,
    ["-e", "process.kill(process.pid, 'SIGTERM')"],
    {
      cwd: root,
      outputPath: join(root, "signal-rejected.log"),
      isolatedProcessGroup: true,
    },
  ), /failed \(SIGTERM\)/u);
});

test("streaming command timeout rejects with ETIMEDOUT and records the terminating signal", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-stream-timeout-test-"));
  const log = join(root, "timeout.log");
  await assert.rejects(() => runStreamingCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: root,
    outputPath: log,
    input: Buffer.alloc(2 * 1024 * 1024, 120),
    timeout: 50,
    allowFailure: true,
    isolatedProcessGroup: true,
  }), (error) => error?.code === "ETIMEDOUT");
  const audit = readHostStreamAudit(log);
  assert.equal(audit.timedOut, true);
  assert.equal(audit.streamDrainTimedOut, false);
  assert.equal(audit.errorCode, "ETIMEDOUT");
  assert.equal(audit.status, null);
  assert.equal(audit.signal, "SIGTERM");
});

test("streaming command removes descendants from its isolated process group", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-stream-group-test-"));
  const pidPath = join(root, "grandchild.pid");
  const program = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    "const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });",
    `writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`,
    "child.unref();",
  ].join(" ");
  const result = await runStreamingCommand(process.execPath, ["-e", program], {
    cwd: root,
    outputPath: join(root, "group.log"),
    isolatedProcessGroup: true,
    timeout: 10_000,
  });
  assert.equal(result.status, 0);
  const grandchildPid = Number(readFileSync(pidPath, "utf8"));
  assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0);
  await waitForProcessToDisappear(grandchildPid);
});

test("streaming command fails at its deadline when an escaped grandchild retains stdio", { timeout: 5_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-stream-escaped-stdio-test-"));
  const pidPath = join(root, "escaped-grandchild.pid");
  const log = join(root, "escaped.log");
  let escapedPid;
  t.after(() => {
    if (!Number.isSafeInteger(escapedPid) || escapedPid < 1) return;
    try {
      process.kill(escapedPid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  });
  const grandchildProgram = "setTimeout(() => process.exit(0), 2000)";
  const leaderProgram = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    `const child = spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(grandchildProgram)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });`,
    `writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`,
    "child.unref();",
  ].join(" ");
  const startedAt = Date.now();
  await assert.rejects(() => runStreamingCommand(process.execPath, ["-e", leaderProgram], {
    cwd: root,
    outputPath: log,
    isolatedProcessGroup: true,
    timeout: 500,
  }), (error) => error?.code === "ERR_CHILD_PROCESS_STDIO_TIMEOUT");
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs >= 450 && elapsedMs < 1_500, `escaped stdio returned after ${elapsedMs}ms`);
  escapedPid = Number(readFileSync(pidPath, "utf8"));
  assert.ok(Number.isSafeInteger(escapedPid) && escapedPid > 0);

  const audit = readHostStreamAudit(log);
  assert.equal(audit.status, 0);
  assert.equal(audit.signal, null);
  assert.equal(audit.timedOut, false);
  assert.equal(audit.streamDrainTimedOut, true);
  assert.equal(audit.errorCode, "ERR_CHILD_PROCESS_STDIO_TIMEOUT");
});

test("streaming command refuses to overwrite an existing bounded log", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-stream-exclusive-log-test-"));
  const log = join(root, "existing.log");
  writeFileSync(log, "keep\n", { mode: 0o600 });
  await assert.rejects(() => runStreamingCommand(process.execPath, ["-e", "process.exit(0)"], {
    cwd: root,
    outputPath: log,
  }), /EEXIST/u);
  assert.equal(readFileSync(log, "utf8"), "keep\n");
});

test("streaming command closes stdin and records a spawn failure without losing its audit", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-stream-transport-test-"));
  const input = "bounded prompt input";
  const inputResult = await runStreamingCommand(process.execPath, [
    "-e",
    "let value = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { value += chunk; }); process.stdin.on('end', () => process.stdout.write(String(value.length)));",
  ], {
    cwd: root,
    input,
    outputPath: join(root, "input.log"),
    isolatedProcessGroup: true,
  });
  assert.equal(inputResult.status, 0);
  assert.equal(inputResult.stdout, String(input.length));

  const missingLog = join(root, "missing.log");
  await assert.rejects(() => runStreamingCommand(join(root, "missing-command"), [], {
    cwd: root,
    outputPath: missingLog,
    isolatedProcessGroup: true,
  }), (error) => error?.code === "ENOENT");
  const missingAudit = readHostStreamAudit(missingLog);
  assert.equal(missingAudit.status, null);
  assert.equal(missingAudit.signal, null);
  assert.equal(missingAudit.errorCode, "ENOENT");
});

test("ready manifest requires the exact three regular report files", async () => {
  const paths = await fixture();
  for (const category of CATEGORIES) writeFileSync(join(paths.staging, `${DATE}-${category}.json`), "{}\n");
  writeFileSync(paths.manifest, `${JSON.stringify(manifestObject(paths.staging))}\n`);
  assert.deepEqual(
    validateManifest(paths.manifest, { runId: RUN_ID, stagingPath: paths.staging }),
    { status: "ready", date: DATE, stagingPath: paths.staging, message: "Three complete reports are ready." },
  );
});

test("manifest rejects runId substitution, extra staging files, and symlink reports", async () => {
  const wrongRun = await fixture();
  writeFileSync(wrongRun.manifest, `${JSON.stringify(manifestObject(wrongRun.staging, { runId: "run-20990105T123456Z-deadbeefcafe" }))}\n`);
  assert.throws(() => validateManifest(wrongRun.manifest, { runId: RUN_ID, stagingPath: wrongRun.staging }), /runId/);

  const extra = await fixture();
  for (const category of CATEGORIES) writeFileSync(join(extra.staging, `${DATE}-${category}.json`), "{}\n");
  writeFileSync(join(extra.staging, "extra.json"), "{}\n");
  writeFileSync(extra.manifest, `${JSON.stringify(manifestObject(extra.staging))}\n`);
  assert.throws(() => validateManifest(extra.manifest, { runId: RUN_ID, stagingPath: extra.staging }), /exactly/);

  const linked = await fixture();
  for (const category of CATEGORIES.slice(1)) writeFileSync(join(linked.staging, `${DATE}-${category}.json`), "{}\n");
  const target = join(linked.root, "target.json");
  writeFileSync(target, "{}\n");
  symlinkSync(target, join(linked.staging, `${DATE}-${CATEGORIES[0]}.json`));
  writeFileSync(linked.manifest, `${JSON.stringify(manifestObject(linked.staging))}\n`);
  assert.throws(() => validateManifest(linked.manifest, { runId: RUN_ID, stagingPath: linked.staging }), /symlink/);
});

test("manifest message cannot inject extra log lines or terminal controls", async () => {
  const paths = await fixture();
  for (const category of CATEGORIES) writeFileSync(join(paths.staging, `${DATE}-${category}.json`), "{}\n");
  writeFileSync(paths.manifest, `${JSON.stringify(manifestObject(paths.staging, { message: "ready\nFAKE_SUCCESS" }))}\n`);
  assert.throws(
    () => validateManifest(paths.manifest, { runId: RUN_ID, stagingPath: paths.staging }),
    /single line/,
  );
});

test("no_change manifest is rejected after the host has fixed a new snapshot", async () => {
  const paths = await fixture();
  writeFileSync(paths.manifest, `${JSON.stringify(manifestObject(paths.staging, {
    status: "no_change",
    reportDate: null,
    reportFiles: [],
    message: "No complete new common announcement.",
  }))}\n`);
  assert.throws(
    () => validateManifest(paths.manifest, { runId: RUN_ID, stagingPath: paths.staging }),
    /status must be ready/,
  );
});
