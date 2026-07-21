import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fingerprintSnapshot } from "../scripts/lib/arxiv-source.mjs";
import {
  CHECKPOINT_CATEGORIES,
  appendCheckpointAttempt,
  appendPublicationStatus,
  checkpointJobFamilyPath,
  checkpointJobPath,
  importCheckpointCategoryReport,
  loadCheckpointJob,
  materializeCheckpointReports,
  openCheckpointJob,
  recoverIncompleteCheckpointReports,
} from "../scripts/lib/checkpoint.mjs";

const DATE = "2099-01-05";
const RUNTIME = "a".repeat(64);
const EVALUATION_RUN_ID = "run-20990105T123456Z-abcdef123456";
const ATTEMPT_ID = "run-20990105T123457Z-123456abcdef";
const SNAPSHOT = Object.freeze({
  announcementDate: DATE,
  categories: {
    "quant-ph": {
      slug: "quant-ph",
      sourceUrl: "https://arxiv.org/list/quant-ph/new",
      newCount: 1,
      crosslistCount: 0,
      newIds: ["2099.00003"],
    },
    "gr-qc": {
      slug: "gr-qc",
      sourceUrl: "https://arxiv.org/list/gr-qc/new",
      newCount: 1,
      crosslistCount: 0,
      newIds: ["2099.00002"],
    },
    "hep-th": {
      slug: "hep-th",
      sourceUrl: "https://arxiv.org/list/hep-th/new",
      newCount: 1,
      crosslistCount: 0,
      newIds: ["2099.00001"],
    },
  },
});
const FINGERPRINT = fingerprintSnapshot(SNAPSHOT);

async function fixture() {
  const base = realpathSync(await mkdtemp(join(tmpdir(), "daily-arxiv-checkpoint-test-")));
  const controlRoot = join(base, "control");
  mkdirSync(controlRoot, { mode: 0o700 });
  return { base, controlRoot };
}

function openFresh(controlRoot, overrides = {}) {
  return openCheckpointJob({
    controlRoot,
    snapshot: structuredClone(SNAPSHOT),
    snapshotFingerprint: FINGERPRINT,
    runtimeFingerprint: RUNTIME,
    evaluationRunId: EVALUATION_RUN_ID,
    now: new Date("2099-01-05T12:00:00.000Z"),
    ...overrides,
  });
}

function reportFor(category, suffix = "") {
  return {
    schemaVersion: "test",
    reportDate: DATE,
    slug: category,
    evaluationRun: { runId: EVALUATION_RUN_ID },
    payload: `validated-${category}${suffix}`,
  };
}

function writeSource(base, category, suffix = "") {
  const path = resolve(base, `${category}${suffix || ""}.json`);
  writeFileSync(path, `${JSON.stringify(reportFor(category, suffix), null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function importReport(job, base, category, suffix = "") {
  const sourcePath = writeSource(base, category, suffix);
  let validated = false;
  const result = importCheckpointCategoryReport({
    job,
    category,
    sourcePath,
    attemptId: ATTEMPT_ID,
    now: new Date("2099-01-05T12:10:00.000Z"),
    validateReport(report, context) {
      assert.equal(report.payload, `validated-${category}${suffix}`);
      assert.equal(context.category, category);
      assert.equal(context.evaluationRunId, EVALUATION_RUN_ID);
      validated = true;
    },
  });
  assert.equal(validated, true);
  return { result, sourcePath };
}

test("checkpoint job uses date-fingerprint path and reuses its immutable evaluationRunId", async () => {
  const { controlRoot } = await fixture();
  const created = openFresh(controlRoot);
  assert.equal(created.familyPath, checkpointJobFamilyPath({ controlRoot, reportDate: DATE, snapshotFingerprint: FINGERPRINT }));
  assert.equal(created.path, checkpointJobPath({
    controlRoot,
    reportDate: DATE,
    snapshotFingerprint: FINGERPRINT,
    runtimeFingerprint: RUNTIME,
  }));
  assert.equal(created.evaluationRunId, EVALUATION_RUN_ID);
  assert.equal(created.isComplete, false);
  assert.deepEqual(created.completeCategories, []);
  assert.equal(statSync(created.path).mode & 0o777, 0o700);
  assert.equal(statSync(created.paths.snapshot).mode & 0o777, 0o400);
  assert.equal(statSync(created.paths.manifest).mode & 0o777, 0o400);

  const reopened = openCheckpointJob({
    controlRoot,
    snapshot: structuredClone(SNAPSHOT),
    snapshotFingerprint: FINGERPRINT,
    runtimeFingerprint: RUNTIME,
    evaluationRunId: "run-20990105T130000Z-bbbbbbbbbbbb",
  });
  assert.equal(reopened.evaluationRunId, EVALUATION_RUN_ID);
  assert.equal(reopened.manifest.createdAt, "2099-01-05T12:00:00.000Z");
  assert.ok(readdirSync(reopened.paths.writes).length >= 2, "atomic write blobs are retained, not deleted");
});

test("a snapshot-only interrupted creation completes safely with the next supplied evaluationRunId", async () => {
  const { controlRoot } = await fixture();
  assert.throws(() => openFresh(controlRoot, { now: new Date(Number.NaN) }), /timestamp is invalid/);
  const path = checkpointJobPath({
    controlRoot,
    reportDate: DATE,
    snapshotFingerprint: FINGERPRINT,
    runtimeFingerprint: RUNTIME,
  });
  assert.equal(existsSync(join(path, "snapshot.json")), true);
  assert.equal(existsSync(join(path, "job.json")), false);

  const recoveredId = "run-20990105T130000Z-cccccccccccc";
  const recovered = openFresh(controlRoot, {
    evaluationRunId: recoveredId,
    now: new Date("2099-01-05T13:00:00.000Z"),
  });
  assert.equal(recovered.evaluationRunId, recoveredId);
  assert.equal(recovered.manifest.createdAt, "2099-01-05T13:00:00.000Z");
  assert.equal(recovered.completeCategories.length, 0);
});

test("a runtime change creates a separate resumable job without deleting the older runtime", async () => {
  const { controlRoot } = await fixture();
  const oldJob = openFresh(controlRoot);
  const nextRuntime = "b".repeat(64);
  const nextId = "run-20990105T140000Z-dddddddddddd";
  const newJob = openFresh(controlRoot, {
    runtimeFingerprint: nextRuntime,
    evaluationRunId: nextId,
    now: new Date("2099-01-05T14:00:00.000Z"),
  });
  assert.equal(newJob.familyPath, oldJob.familyPath);
  assert.notEqual(newJob.path, oldJob.path);
  assert.equal(newJob.path, join(oldJob.familyPath, nextRuntime));
  assert.equal(newJob.evaluationRunId, nextId);
  assert.equal(existsSync(oldJob.paths.manifest), true);
  assert.deepEqual(readdirSync(oldJob.familyPath).sort(), [RUNTIME, nextRuntime].sort());
});

test("load verifies runtime, evaluation identity, snapshot fingerprint, and immutable digest", async () => {
  const { controlRoot } = await fixture();
  const job = openFresh(controlRoot);
  assert.throws(() => loadCheckpointJob({
    controlRoot,
    reportDate: DATE,
    snapshotFingerprint: FINGERPRINT,
    runtimeFingerprint: "b".repeat(64),
  }), /job directory does not exist/);
  assert.throws(() => loadCheckpointJob({
    controlRoot,
    reportDate: DATE,
    snapshotFingerprint: FINGERPRINT,
    runtimeFingerprint: RUNTIME,
    evaluationRunId: "different-evaluation-run",
  }), /evaluationRunId changed/);
  assert.throws(() => openCheckpointJob({
    controlRoot,
    snapshot: structuredClone(SNAPSHOT),
    snapshotFingerprint: "c".repeat(64),
    runtimeFingerprint: RUNTIME,
    evaluationRunId: EVALUATION_RUN_ID,
  }), /does not match the official snapshot/);

  chmodSync(job.paths.snapshot, 0o600);
  writeFileSync(job.paths.snapshot, `${readFileSync(job.paths.snapshot, "utf8")} `);
  chmodSync(job.paths.snapshot, 0o400);
  assert.throws(() => loadCheckpointJob({
    controlRoot,
    reportDate: DATE,
    snapshotFingerprint: FINGERPRINT,
    runtimeFingerprint: RUNTIME,
  }), /digest/);
});

test("category import validates before an immutable digest-recorded copy and is idempotent only for identical bytes", async () => {
  const { base, controlRoot } = await fixture();
  const job = openFresh(controlRoot);
  const source = writeSource(base, "quant-ph");
  assert.throws(() => importCheckpointCategoryReport({
    job,
    category: "quant-ph",
    sourcePath: source,
    attemptId: ATTEMPT_ID,
    validateReport: () => false,
  }), /failed validation/);
  assert.equal(readdirSync(job.paths.reports).length, 0, "failed validation must not import an artifact");

  const first = importCheckpointCategoryReport({
    job,
    category: "quant-ph",
    sourcePath: source,
    attemptId: ATTEMPT_ID,
    now: new Date("2099-01-05T12:10:00.000Z"),
    validateReport: () => true,
  });
  assert.match(first.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(statSync(first.path).mode & 0o777, 0o400);
  assert.equal(statSync(first.receiptPath).mode & 0o777, 0o400);
  assert.equal(first.receipt.sha256, first.sha256);

  const again = importCheckpointCategoryReport({
    job: loadCheckpointJob({ controlRoot, reportDate: DATE, snapshotFingerprint: FINGERPRINT, runtimeFingerprint: RUNTIME }),
    category: "quant-ph",
    sourcePath: source,
    attemptId: ATTEMPT_ID,
    validateReport: () => true,
  });
  assert.equal(again.sha256, first.sha256);
  const different = writeSource(base, "quant-ph", "-different");
  assert.throws(() => importCheckpointCategoryReport({
    job,
    category: "quant-ph",
    sourcePath: different,
    attemptId: ATTEMPT_ID,
    validateReport: () => true,
  }), /Refusing to replace a different checkpoint report/);
  assert.equal(readFileSync(first.path, "utf8"), readFileSync(source, "utf8"));
});

test("a report-link interruption is revalidated and receipted without regenerating the category", async () => {
  const { base, controlRoot } = await fixture();
  const job = openFresh(controlRoot);
  const source = writeSource(base, "quant-ph");
  let initialValidations = 0;
  assert.throws(() => importCheckpointCategoryReport({
    job,
    category: "quant-ph",
    sourcePath: source,
    attemptId: ATTEMPT_ID,
    now: new Date(Number.NaN),
    validateReport: () => { initialValidations += 1; },
  }), /timestamp is invalid/);
  assert.equal(initialValidations, 1);

  const interrupted = loadCheckpointJob({
    controlRoot,
    reportDate: DATE,
    snapshotFingerprint: FINGERPRINT,
    runtimeFingerprint: RUNTIME,
  });
  assert.deepEqual(interrupted.incompleteReports, ["quant-ph"]);
  assert.deepEqual(interrupted.completeCategories, []);
  assert.equal(existsSync(join(interrupted.paths.reports, "quant-ph.json")), true);
  assert.equal(existsSync(join(interrupted.paths.reports, "quant-ph.receipt.json")), false);

  assert.throws(() => recoverIncompleteCheckpointReports({
    job: interrupted,
    attemptId: "run-20990105T125900Z-ffffffffffff",
    validateReport: () => false,
  }), /failed validation/);
  const stillInterrupted = loadCheckpointJob({
    controlRoot,
    reportDate: DATE,
    snapshotFingerprint: FINGERPRINT,
    runtimeFingerprint: RUNTIME,
  });
  assert.deepEqual(stillInterrupted.incompleteReports, ["quant-ph"]);

  let recoveryValidations = 0;
  const recovered = recoverIncompleteCheckpointReports({
    job: stillInterrupted,
    attemptId: "run-20990105T130000Z-eeeeeeeeeeee",
    now: new Date("2099-01-05T13:00:00.000Z"),
    validateReport(report, context) {
      recoveryValidations += 1;
      assert.equal(report.payload, "validated-quant-ph");
      assert.equal(context.category, "quant-ph");
      return true;
    },
  });
  assert.equal(recoveryValidations, 1);
  assert.deepEqual(recovered.incompleteReports, []);
  assert.deepEqual(recovered.completeCategories, ["quant-ph"]);
  assert.equal(readFileSync(recovered.reports["quant-ph"].path, "utf8"), readFileSync(source, "utf8"));
  assert.match(recovered.reports["quant-ph"].receipt.sha256, /^[a-f0-9]{64}$/u);
});

test("report import rejects symlinks, broad modes, wrong identities, and report tampering", async () => {
  const { base, controlRoot } = await fixture();
  const job = openFresh(controlRoot);
  const source = writeSource(base, "gr-qc");
  const alias = resolve(base, "alias.json");
  symlinkSync(source, alias);
  assert.throws(() => importCheckpointCategoryReport({
    job,
    category: "gr-qc",
    sourcePath: alias,
    attemptId: ATTEMPT_ID,
    validateReport: () => true,
  }), /symlink/);
  chmodSync(source, 0o644);
  assert.throws(() => importCheckpointCategoryReport({
    job,
    category: "gr-qc",
    sourcePath: source,
    attemptId: ATTEMPT_ID,
    validateReport: () => true,
  }), /mode 0600/);
  chmodSync(source, 0o600);
  const wrong = resolve(base, "wrong.json");
  writeFileSync(wrong, `${JSON.stringify({ ...reportFor("gr-qc"), evaluationRun: { runId: "wrong-run" } })}\n`, { mode: 0o600 });
  assert.throws(() => importCheckpointCategoryReport({
    job,
    category: "gr-qc",
    sourcePath: wrong,
    attemptId: ATTEMPT_ID,
    validateReport: () => true,
  }), /evaluationRun\.runId/);

  const imported = importReport(job, base, "gr-qc").result;
  chmodSync(imported.path, 0o600);
  writeFileSync(imported.path, `${readFileSync(imported.path, "utf8")} `);
  chmodSync(imported.path, 0o400);
  assert.throws(() => loadCheckpointJob({
    controlRoot,
    reportDate: DATE,
    snapshotFingerprint: FINGERPRINT,
    runtimeFingerprint: RUNTIME,
  }), /digest/);
});

test("attempt and publication history is append-only and published status is terminal", async () => {
  const { controlRoot } = await fixture();
  const job = openFresh(controlRoot);
  appendCheckpointAttempt({
    job,
    attemptId: ATTEMPT_ID,
    stage: "abstract-screen",
    category: "quant-ph",
    status: "started",
    message: "screening started",
    at: new Date("2099-01-05T12:20:00.000Z"),
    eventId: "1".repeat(32),
  });
  appendCheckpointAttempt({
    job,
    attemptId: ATTEMPT_ID,
    stage: "abstract-screen",
    category: "quant-ph",
    status: "failed",
    message: "transient failure retained",
    at: new Date("2099-01-05T12:21:00.000Z"),
    eventId: "2".repeat(32),
  });
  appendPublicationStatus({
    job,
    attemptId: ATTEMPT_ID,
    status: "failed",
    message: "push unavailable",
    at: new Date("2099-01-05T12:22:00.000Z"),
    eventId: "3".repeat(32),
  });
  appendPublicationStatus({
    job,
    attemptId: ATTEMPT_ID,
    status: "published",
    commit: "d".repeat(40),
    message: "published after retry",
    at: new Date("2099-01-05T12:23:00.000Z"),
    eventId: "4".repeat(32),
  });
  const loaded = loadCheckpointJob({ controlRoot, reportDate: DATE, snapshotFingerprint: FINGERPRINT, runtimeFingerprint: RUNTIME });
  assert.deepEqual(loaded.attempts.map((event) => event.status), ["started", "failed"]);
  assert.deepEqual(loaded.publicationEvents.map((event) => event.status), ["failed", "published"]);
  assert.equal(loaded.publicationStatus, "published");
  assert.equal(loaded.publishedCommit, "d".repeat(40));
  assert.throws(() => appendPublicationStatus({
    job: loaded,
    attemptId: ATTEMPT_ID,
    status: "failed",
    eventId: "5".repeat(32),
  }), /already published/);
  assert.throws(() => appendCheckpointAttempt({
    job: loaded,
    attemptId: ATTEMPT_ID,
    stage: "abstract-screen",
    status: "completed",
    at: new Date("2099-01-05T12:20:00.000Z"),
    eventId: "1".repeat(32),
  }), /exclusively publish|overwrite/);
});

test("all three digest-verified reports materialize exclusively into an empty secure staging directory", async () => {
  const { base, controlRoot } = await fixture();
  let job = openFresh(controlRoot);
  for (const category of CHECKPOINT_CATEGORIES) {
    importReport(job, base, category);
    job = loadCheckpointJob({ controlRoot, reportDate: DATE, snapshotFingerprint: FINGERPRINT, runtimeFingerprint: RUNTIME });
  }
  assert.equal(job.isComplete, true);
  assert.deepEqual(job.completeCategories, CHECKPOINT_CATEGORIES);
  const destination = resolve(base, "host-staging");
  mkdirSync(destination, { mode: 0o700 });
  const materialized = materializeCheckpointReports({ job, destination });
  for (const category of CHECKPOINT_CATEGORIES) {
    assert.equal(statSync(materialized[category].path).mode & 0o777, 0o600);
    assert.equal(readFileSync(materialized[category].path, "utf8"), readFileSync(job.reports[category].path, "utf8"));
    assert.equal(materialized[category].sha256, job.reports[category].sha256);
  }
  assert.deepEqual(readdirSync(destination).sort(), CHECKPOINT_CATEGORIES.map((category) => `${DATE}-${category}.json`).sort());
  assert.throws(() => materializeCheckpointReports({ job, destination }), /must start empty/);
});

test("secure path checks reject a symlinked control root and an incomplete report set", async () => {
  const { base, controlRoot } = await fixture();
  const job = openFresh(controlRoot);
  const destination = resolve(base, "empty-staging");
  mkdirSync(destination, { mode: 0o700 });
  assert.throws(() => materializeCheckpointReports({ job, destination }), /incomplete/);

  const alias = resolve(base, "control-alias");
  symlinkSync(controlRoot, alias, "dir");
  assert.throws(() => loadCheckpointJob({
    controlRoot: alias,
    reportDate: DATE,
    snapshotFingerprint: FINGERPRINT,
    runtimeFingerprint: RUNTIME,
  }), /symlink/);
  assert.equal(existsSync(job.paths.snapshot), true);
});
