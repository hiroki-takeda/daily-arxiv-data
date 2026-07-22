import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fingerprintSnapshot } from "../scripts/lib/arxiv-source.mjs";
import {
  appendCheckpointAttempt,
  importCheckpointCategoryReport,
  loadCheckpointJob,
  openCheckpointJob,
  preserveCheckpointCategoryDraft,
} from "../scripts/lib/checkpoint.mjs";
import {
  MAX_UNCHANGED_DRAFT_REPAIR_FAILURES,
  prepareCategoryExecution,
  validateCategoryDraftAssociation,
  validateCategoryRepairMutation,
} from "../scripts/lib/local-automation.mjs";
import { validPolicy, validReport } from "./helpers.mjs";

const DATE = "2099-01-05";
const RUN_ID = "run-20990105T123456Z-abcdef123456";
const CATEGORY = "quant-ph";
const RUNTIME = "a".repeat(64);

function fixtureReport() {
  const report = validReport(CATEGORY, {
    count: 1,
    run: {
      modelId: "gpt-5.6-sol",
      modelDisplayName: "GPT-5.6-Sol",
      reasoningEffort: "high",
      modelSelectionVerified: true,
      runId: RUN_ID,
    },
  });
  delete report.papers[0].arxivVersion;
  delete report.papers[0].submissionType;
  delete report.papers[0].url;
  return report;
}

function fixtureSnapshot(report = fixtureReport()) {
  return {
    announcementDate: DATE,
    categories: {
      "quant-ph": {
        slug: "quant-ph",
        sourceUrl: "https://arxiv.org/list/quant-ph/new",
        newCount: 1,
        crosslistCount: 2,
        newIds: [report.papers[0].arxivId],
      },
      "gr-qc": {
        slug: "gr-qc",
        sourceUrl: "https://arxiv.org/list/gr-qc/new",
        newCount: 0,
        crosslistCount: 0,
        newIds: [],
      },
      "hep-th": {
        slug: "hep-th",
        sourceUrl: "https://arxiv.org/list/hep-th/new",
        newCount: 0,
        crosslistCount: 0,
        newIds: [],
      },
    },
  };
}

async function fixtureJob() {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "daily-arxiv-draft-test-")));
  const controlRoot = join(root, "control");
  mkdirSync(controlRoot, { mode: 0o700 });
  const report = fixtureReport();
  const snapshot = fixtureSnapshot(report);
  const job = openCheckpointJob({
    controlRoot,
    snapshot,
    snapshotFingerprint: fingerprintSnapshot(snapshot),
    runtimeFingerprint: RUNTIME,
    evaluationRunId: RUN_ID,
    now: new Date("2099-01-05T12:00:00.000Z"),
  });
  return { root, controlRoot, report, snapshot, job, policy: validPolicy() };
}

function validateFixtureDraft(policy) {
  return (candidate, context) => validateCategoryDraftAssociation({
    report: candidate,
    date: context.reportDate,
    slug: context.category,
    policy,
    evaluationRunId: context.evaluationRunId,
    snapshot: context.snapshot,
  });
}

function writeSource(root, name, content) {
  const source = join(root, name);
  writeFileSync(source, content, { mode: 0o600 });
  chmodSync(source, 0o600);
  return realpathSync(source);
}

function startCategoryAttempt(job, attemptId, stage = "category_generation", message = `Started ${stage}.`) {
  appendCheckpointAttempt({
    job,
    attemptId,
    stage,
    status: "started",
    category: CATEGORY,
    message,
  });
}

test("a retry restores an immutable same-runtime draft and uses repair instead of full research", async () => {
  const { root, controlRoot, report, snapshot, job, policy } = await fixtureJob();
  startCategoryAttempt(job, RUN_ID);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const sourcePath = writeSource(root, "failed.json", serialized);
  const draft = preserveCheckpointCategoryDraft({
    job,
    category: CATEGORY,
    sourcePath,
    validateDraft: validateFixtureDraft(policy),
    attemptId: RUN_ID,
    now: new Date("2099-01-05T12:30:00.000Z"),
  });
  assert.throws(() => preserveCheckpointCategoryDraft({
    job,
    category: CATEGORY,
    sourcePath,
    validateDraft: validateFixtureDraft(policy),
    attemptId: RUN_ID,
  }), /Refusing to overwrite an existing category draft/);
  const loaded = loadCheckpointJob({
    controlRoot,
    reportDate: DATE,
    snapshotFingerprint: fingerprintSnapshot(snapshot),
    runtimeFingerprint: RUNTIME,
    evaluationRunId: RUN_ID,
  });
  assert.equal(loaded.completeCategories.includes(CATEGORY), false, "a draft must never enter checkpoint reports");
  assert.equal(loaded.drafts[CATEGORY].length, 1);
  assert.equal(statSync(draft.path).mode & 0o777, 0o400);
  assert.equal(draft.path.startsWith(`${loaded.paths.drafts}/`), true);
  assert.equal(draft.path.startsWith(`${loaded.paths.reports}/`), false);
  assert.equal(draft.receipt.runtimeFingerprint, RUNTIME);
  assert.equal(draft.receipt.snapshotFingerprint, fingerprintSnapshot(snapshot));
  assert.equal(draft.receipt.evaluationRunId, RUN_ID);

  const staging = join(root, "retry-staging");
  mkdirSync(staging, { mode: 0o700 });
  const execution = prepareCategoryExecution({ job: loaded, slug: CATEGORY, staging, snapshot, policy });
  assert.equal(execution.mode, "repair");
  assert.equal(execution.stage, "category_repair");
  assert.equal(execution.draft.sha256, draft.sha256);
  assert.equal(readFileSync(join(staging, `${DATE}-${CATEGORY}.json`), "utf8"), serialized);
  assert.match(execution.prompt, /This is not a new research or evaluation run/);
  assert.match(execution.prompt, /Do not conduct new research/);
  assert.match(execution.prompt, /refetch arXiv metadata or full text/);
  assert.match(execution.prompt, /rescore any axis/);
  assert.match(execution.prompt, new RegExp(draft.sha256));
  assert.doesNotMatch(execution.prompt, /Screen every assigned abstract|provisional top|min\(12, totalNew\)/);

  const otherRuntimeJob = openCheckpointJob({
    controlRoot,
    snapshot,
    snapshotFingerprint: fingerprintSnapshot(snapshot),
    runtimeFingerprint: "b".repeat(64),
    evaluationRunId: "run-20990105T130000Z-123456abcdef",
  });
  const otherStaging = join(root, "other-runtime-staging");
  mkdirSync(otherStaging, { mode: 0o700 });
  const otherExecution = prepareCategoryExecution({
    job: otherRuntimeJob,
    slug: CATEGORY,
    staging: otherStaging,
    snapshot,
    policy,
  });
  assert.equal(otherExecution.mode, "generation", "drafts from another runtime must not be selected");
});

test("a retry strictly revalidates an interrupted draft write and appends its missing receipt", async () => {
  const { root, controlRoot, report, snapshot, job, policy } = await fixtureJob();
  startCategoryAttempt(job, RUN_ID);
  const draft = preserveCheckpointCategoryDraft({
    job,
    category: CATEGORY,
    sourcePath: writeSource(root, "interrupted.json", `${JSON.stringify(report)}\n`),
    validateDraft: validateFixtureDraft(policy),
    attemptId: RUN_ID,
  });

  // Simulate power loss after the immutable report link was published but before
  // its receipt link was published. This only removes a file in the temp fixture.
  unlinkSync(draft.receiptPath);
  const interrupted = loadCheckpointJob({
    controlRoot,
    reportDate: DATE,
    snapshotFingerprint: fingerprintSnapshot(snapshot),
    runtimeFingerprint: RUNTIME,
    evaluationRunId: RUN_ID,
  });
  assert.equal(interrupted.drafts[CATEGORY].length, 0);
  assert.deepEqual(
    interrupted.incompleteDrafts.map(({ attemptId, category }) => ({ attemptId, category })),
    [{ attemptId: RUN_ID, category: CATEGORY }],
  );

  const staging = join(root, "interrupted-retry-staging");
  mkdirSync(staging, { mode: 0o700 });
  const execution = prepareCategoryExecution({
    job: interrupted,
    slug: CATEGORY,
    staging,
    snapshot,
    policy,
  });
  assert.equal(execution.mode, "repair");
  assert.equal(execution.draft.sha256, draft.sha256);
  assert.equal(existsSync(draft.receiptPath), true, "the missing receipt is appended after strict revalidation");
  assert.equal(statSync(draft.receiptPath).mode & 0o777, 0o400);
});

test("repair may change prose and deterministic identity keys but cannot change protected research judgments", () => {
  const source = fixtureReport();
  const repaired = structuredClone(source);
  repaired.papers[0].arxivVersion = "v1";
  repaired.papers[0].submissionType = "new";
  repaired.papers[0].url = `https://arxiv.org/abs/${repaired.papers[0].arxivId}`;
  repaired.papers[0].titleJa = "自然な日本語に整えた表示題名";
  repaired.papers[0].paperType = "数理物理の理論研究";
  repaired.papers[0].abstractLines[0] = "既存の証拠を保ったまま自然な日本語へ直した。";
  repaired.papers[0].scoreReasons.broadImpact = "既存の評価根拠を保ち、自然な日本語へ直した。";
  repaired.papers[0].assessment = "既存の総合判断を保ち、読みやすい日本語へ直した。";
  repaired.papers[0].fullTextReviewStatus = "既存の確認範囲を保ち、自然な日本語へ直した。";
  assert.equal(validateCategoryRepairMutation({ source, repaired }), true);

  for (const [label, mutate] of [
    ["score", (candidate) => { candidate.papers[0].scores.broadImpact -= 1; }],
    ["rank", (candidate) => { candidate.papers[0].rank = 2; }],
    ["original title", (candidate) => { candidate.papers[0].title = "Changed title"; }],
    ["authors", (candidate) => { candidate.papers[0].authors = ["Different Author"]; }],
    ["full-text flag", (candidate) => { candidate.papers[0].fullTextEvaluated = false; }],
    ["source URL", (candidate) => { candidate.papers[0].sourceUrls = []; }],
    ["audit provenance", (candidate) => { candidate.audit.generatedAtJst = "2099-01-05T13:00:00+09:00"; }],
  ]) {
    const candidate = structuredClone(repaired);
    mutate(candidate);
    assert.throws(
      () => validateCategoryRepairMutation({ source, repaired: candidate }),
      /changed protected research fields/,
      label,
    );
  }
});

test("checkpoint import invokes the repair mutation guard before publishing repaired bytes", async () => {
  const { root, controlRoot, report, snapshot, job } = await fixtureJob();
  const repaired = structuredClone(report);
  repaired.papers[0].arxivVersion = "v1";
  repaired.papers[0].submissionType = "new";
  repaired.papers[0].url = `https://arxiv.org/abs/${repaired.papers[0].arxivId}`;
  repaired.papers[0].assessment = "既存の根拠と数値判断を保った読みやすい総合評定。";
  const validateRepair = (candidate) => validateCategoryRepairMutation({
    source: report,
    repaired: candidate,
    path: "checkpointRepair.quant-ph",
  });

  const changedScore = structuredClone(repaired);
  changedScore.papers[0].scores.broadImpact -= 1;
  changedScore.papers[0].totalScore -= 1;
  assert.throws(() => importCheckpointCategoryReport({
    job,
    category: CATEGORY,
    sourcePath: writeSource(root, "changed-score.json", `${JSON.stringify(changedScore)}\n`),
    validateReport: validateRepair,
    attemptId: RUN_ID,
  }), /changed protected research fields/);
  let loaded = loadCheckpointJob({
    controlRoot,
    reportDate: DATE,
    snapshotFingerprint: fingerprintSnapshot(snapshot),
    runtimeFingerprint: RUNTIME,
    evaluationRunId: RUN_ID,
  });
  assert.deepEqual(loaded.completeCategories, [], "rejected repair bytes must not enter reports");

  const imported = importCheckpointCategoryReport({
    job,
    category: CATEGORY,
    sourcePath: writeSource(root, "allowed-repair.json", `${JSON.stringify(repaired)}\n`),
    validateReport: validateRepair,
    attemptId: RUN_ID,
  });
  assert.equal(imported.report.papers[0].assessment, repaired.papers[0].assessment);
  loaded = loadCheckpointJob({
    controlRoot,
    reportDate: DATE,
    snapshotFingerprint: fingerprintSnapshot(snapshot),
    runtimeFingerprint: RUNTIME,
    evaluationRunId: RUN_ID,
  });
  assert.deepEqual(loaded.completeCategories, [CATEGORY]);
});

test("truncated, wrong-run, wrong-snapshot, and out-of-bounds drafts are rejected before preservation", async () => {
  const { root, report, job, policy } = await fixtureJob();
  const validateDraft = validateFixtureDraft(policy);
  const cases = [
    {
      attemptId: RUN_ID,
      name: "truncated.json",
      content: '{"schemaVersion":"1.4"',
      pattern: /not valid JSON/,
    },
    {
      attemptId: "run-20990105T130000Z-123456abcdef",
      name: "wrong-run.json",
      content: `${JSON.stringify({
        ...report,
        evaluationRun: { ...report.evaluationRun, runId: "run-20990105T130001Z-fedcba654321" },
      })}\n`,
      pattern: /runId does not match/,
    },
    {
      attemptId: "run-20990105T140000Z-123456abcdef",
      name: "wrong-snapshot.json",
      content: (() => {
        const candidate = structuredClone(report);
        candidate.papers[0].arxivId = "9901.99999";
        candidate.papers[0].sourceUrls = ["https://arxiv.org/abs/9901.99999v1", "https://arxiv.org/pdf/9901.99999v1"];
        return `${JSON.stringify(candidate)}\n`;
      })(),
      pattern: /official snapshot ID set/,
    },
    {
      attemptId: "run-20990105T150000Z-123456abcdef",
      name: "out-of-bounds.json",
      content: (() => {
        const candidate = structuredClone(report);
        candidate.papers[0].scores.broadImpact = 26;
        candidate.papers[0].totalScore += 1;
        return `${JSON.stringify(candidate)}\n`;
      })(),
      pattern: /integer from 0 through 25/,
    },
  ];
  for (const candidate of cases) {
    startCategoryAttempt(job, candidate.attemptId);
    const sourcePath = writeSource(root, candidate.name, candidate.content);
    assert.throws(() => preserveCheckpointCategoryDraft({
      job,
      category: CATEGORY,
      sourcePath,
      validateDraft,
      attemptId: candidate.attemptId,
    }), candidate.pattern);
  }
  assert.deepEqual(readdirSync(job.paths.drafts), [], "rejected input must not create a protected draft artifact");

  const oversizedAttempt = "run-20990105T160000Z-123456abcdef";
  startCategoryAttempt(job, oversizedAttempt);
  const oversized = writeSource(root, "oversized.json", Buffer.alloc(10 * 1024 * 1024 + 1, 0x20));
  assert.throws(() => preserveCheckpointCategoryDraft({
    job,
    category: CATEGORY,
    sourcePath: oversized,
    validateDraft,
    attemptId: oversizedAttempt,
  }), /unexpectedly large/);
  assert.deepEqual(readdirSync(job.paths.drafts), []);
});

test("two failed repairs from one unchanged protected digest stop before a third model attempt", async () => {
  const { root, report, snapshot, job, policy } = await fixtureJob();
  startCategoryAttempt(job, RUN_ID);
  const draft = preserveCheckpointCategoryDraft({
    job,
    category: CATEGORY,
    sourcePath: writeSource(root, "failed.json", `${JSON.stringify(report)}\n`),
    validateDraft: validateFixtureDraft(policy),
    attemptId: RUN_ID,
  });
  for (let index = 0; index < MAX_UNCHANGED_DRAFT_REPAIR_FAILURES; index += 1) {
    const attemptId = `run-20990105T${String(13 + index).padStart(2, "0")}0000Z-123456abcde${index}`;
    startCategoryAttempt(
      job,
      attemptId,
      "category_repair",
      `REPAIR_SOURCE_DRAFT_SHA256=${draft.sha256}; Started bounded repair.`,
    );
    appendCheckpointAttempt({
      job,
      attemptId,
      stage: "category_repair",
      status: "failed",
      category: CATEGORY,
      message: `REPAIR_SOURCE_DRAFT_SHA256=${draft.sha256}; repair did not produce a reusable successor`,
    });
  }
  const staging = join(root, "bounded-retry-staging");
  mkdirSync(staging, { mode: 0o700 });
  assert.throws(() => prepareCategoryExecution({ job, slug: CATEGORY, staging, snapshot, policy }), /stopped after 2 unchanged attempts/);
  assert.deepEqual(readdirSync(staging), [], "the protected draft is not materialized after the retry bound");
});
