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
  preserveCheckpointCategorySourceDraft,
} from "../scripts/lib/checkpoint.mjs";
import {
  MAX_UNCHANGED_DRAFT_REPAIR_FAILURES,
  computeCategoryRetryState,
  prepareCategoryExecution,
  validateCategoryDraftAssociation,
  validateCategoryRepairMutation,
  validateCategorySourceResumeDraft,
  validateCategorySourceResumeMutation,
} from "../scripts/lib/local-automation.mjs";
import {
  MODEL_SOURCE_FAILURE_CLASS,
  decodeSourceBlockerEventMessage,
  encodeSourceBlockerEventMessage,
} from "../scripts/lib/source-blocker.mjs";
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

function provisionalFixtureReport() {
  const report = fixtureReport();
  const paper = report.papers[0];
  paper.scores = {
    broadImpact: 18,
    categoryImpact: 18,
    originality: 18,
    technicalStrength: 17,
  };
  paper.totalScore = Object.values(paper.scores).reduce((sum, value) => sum + value, 0);
  paper.fullTextEvaluated = false;
  paper.evaluationBasis = "title_authors_abstract";
  paper.sourceUrls = [`https://arxiv.org/abs/${paper.arxivId}v1`];
  delete paper.fullTextReviewStatus;
  report.fullTextEvaluatedCount = 0;
  report.audit.fullTextEvaluatedCount = 0;
  return report;
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

test("a source interruption resumes from the protected screening draft and fixed candidates", async () => {
  const { root, controlRoot, snapshot, job, policy } = await fixtureJob();
  const provisional = provisionalFixtureReport();
  const receipt = {
    schemaVersion: "1.0",
    status: "source_incomplete",
    arxivId: provisional.papers[0].arxivId,
    failureClass: MODEL_SOURCE_FAILURE_CLASS,
    provisionalCandidateIds: [provisional.papers[0].arxivId],
  };
  startCategoryAttempt(job, RUN_ID);
  const draft = preserveCheckpointCategorySourceDraft({
    job,
    category: CATEGORY,
    sourcePath: writeSource(root, "source-incomplete.json", `${JSON.stringify(provisional)}\n`),
    sourceReceipt: receipt,
    attemptId: RUN_ID,
    validateDraft: (candidate, context) => validateCategorySourceResumeDraft({
      report: candidate,
      receipt,
      date: context.reportDate,
      slug: context.category,
      policy,
      evaluationRunId: context.evaluationRunId,
      snapshot: context.snapshot,
      candidateOrderRequired: true,
    }),
  });
  appendCheckpointAttempt({
    job,
    attemptId: RUN_ID,
    stage: "category_generation",
    status: "failed",
    category: CATEGORY,
    message: encodeSourceBlockerEventMessage(receipt, {
      observedAt: new Date("2099-01-05T12:30:00.000Z"),
    }),
  });
  const loaded = loadCheckpointJob({
    controlRoot,
    reportDate: DATE,
    snapshotFingerprint: fingerprintSnapshot(snapshot),
    runtimeFingerprint: RUNTIME,
    evaluationRunId: RUN_ID,
  });
  const staging = join(root, "source-resume-staging");
  mkdirSync(staging, { mode: 0o700 });
  const execution = prepareCategoryExecution({
    job: loaded,
    slug: CATEGORY,
    staging,
    snapshot,
    policy,
  });
  assert.equal(execution.mode, "source_resume");
  assert.equal(execution.stage, "category_source_resume");
  assert.equal(execution.draft.sha256, draft.sha256);
  assert.deepEqual(execution.sourceReceipt.provisionalCandidateIds, receipt.provisionalCandidateIds);
  assert.match(execution.prompt, /Do not restart abstract screening/);
  assert.match(execution.prompt, new RegExp(draft.sha256));
  assert.match(execution.prompt, new RegExp(receipt.provisionalCandidateIds[0].replace(".", "\\.")));
  assert.doesNotMatch(execution.prompt, /Screen every assigned abstract/);
  assert.deepEqual(
    JSON.parse(readFileSync(join(staging, `${DATE}-${CATEGORY}.json`), "utf8")),
    provisional,
  );

  const completed = fixtureReport();
  assert.equal(validateCategorySourceResumeMutation({
    source: provisional,
    resumed: completed,
    receipt,
    requireComplete: true,
  }), true);
  const changedMetadata = structuredClone(completed);
  changedMetadata.papers[0].title = "Unreviewed changed title";
  assert.throws(() => validateCategorySourceResumeMutation({
    source: provisional,
    resumed: changedMetadata,
    receipt,
    requireComplete: true,
  }), /changed immutable metadata/);
  const incomplete = structuredClone(provisional);
  assert.throws(() => validateCategorySourceResumeMutation({
    source: provisional,
    resumed: incomplete,
    receipt,
    requireComplete: true,
  }), /complete full-text review/);

  const compactSource = {
    papers: [
      {
        arxivId: "2099.10001",
        title: "Candidate",
        authors: ["A"],
        primaryCategory: CATEGORY,
        scores: { broadImpact: 10 },
        totalScore: 10,
        evaluationBasis: "title_authors_abstract",
        fullTextEvaluated: false,
        sourceUrls: ["https://arxiv.org/abs/2099.10001v1"],
        assessment: "候補の暫定評定。",
      },
      {
        arxivId: "2099.10002",
        title: "Noncandidate",
        authors: ["B"],
        primaryCategory: CATEGORY,
        scores: { broadImpact: 9 },
        totalScore: 9,
        evaluationBasis: "title_authors_abstract",
        fullTextEvaluated: false,
        sourceUrls: ["https://arxiv.org/abs/2099.10002v1"],
        assessment: "候補外の暫定評定。",
      },
    ],
  };
  const proseOnly = structuredClone(compactSource);
  proseOnly.papers[1].assessment = "意味を保って自然な日本語へ整えた評定。";
  assert.equal(validateCategorySourceResumeMutation({
    source: compactSource,
    resumed: proseOnly,
    receipt: { provisionalCandidateIds: ["2099.10001"] },
    requireComplete: false,
  }), true);
  const changedNoncandidateScore = structuredClone(proseOnly);
  changedNoncandidateScore.papers[1].scores.broadImpact = 8;
  changedNoncandidateScore.papers[1].totalScore = 8;
  assert.throws(() => validateCategorySourceResumeMutation({
    source: compactSource,
    resumed: changedNoncandidateScore,
    receipt: { provisionalCandidateIds: ["2099.10001"] },
    requireComplete: false,
  }), /changed protected abstract-screening content/);
});

test("a source draft atomically preserves its receipt association across a host crash", async () => {
  const { root, controlRoot, snapshot, job, policy } = await fixtureJob();
  const provisional = provisionalFixtureReport();
  const receipt = {
    schemaVersion: "1.0",
    status: "source_incomplete",
    arxivId: provisional.papers[0].arxivId,
    failureClass: MODEL_SOURCE_FAILURE_CLASS,
    provisionalCandidateIds: [provisional.papers[0].arxivId],
  };
  startCategoryAttempt(job, RUN_ID);
  const draft = preserveCheckpointCategorySourceDraft({
    job,
    category: CATEGORY,
    sourcePath: writeSource(root, "source-crash.json", `${JSON.stringify(provisional)}\n`),
    sourceReceipt: receipt,
    attemptId: RUN_ID,
    now: new Date("2099-01-05T12:30:00.000Z"),
    validateDraft: (candidate, context) => validateCategorySourceResumeDraft({
      report: candidate,
      receipt,
      date: context.reportDate,
      slug: context.category,
      policy,
      evaluationRunId: context.evaluationRunId,
      snapshot: context.snapshot,
      candidateOrderRequired: true,
    }),
  });
  // Simulate loss after the one-file source envelope was published but before
  // the separate retry/audit event was appended.
  let loaded = loadCheckpointJob({
    controlRoot,
    reportDate: DATE,
    snapshotFingerprint: fingerprintSnapshot(snapshot),
    runtimeFingerprint: RUNTIME,
    evaluationRunId: RUN_ID,
  });
  assert.equal(loaded.incompleteDrafts.length, 0);
  assert.equal(loaded.drafts[CATEGORY].length, 1);
  assert.equal(loaded.drafts[CATEGORY][0].storageKind, "source_envelope");
  assert.deepEqual(loaded.drafts[CATEGORY][0].sourceReceipt, receipt);
  assert.equal(readdirSync(loaded.paths.drafts).length, 1);
  assert.match(readdirSync(loaded.paths.drafts)[0], /\.source-draft\.json$/u);

  const staging = join(root, "source-crash-retry-staging");
  mkdirSync(staging, { mode: 0o700 });
  const execution = prepareCategoryExecution({
    job: loaded,
    slug: CATEGORY,
    staging,
    snapshot,
    policy,
  });
  assert.equal(execution.mode, "source_resume", "a source draft must never become a generic repair");
  assert.equal(execution.draft.sha256, draft.sha256);
  loaded = loadCheckpointJob({
    controlRoot,
    reportDate: DATE,
    snapshotFingerprint: fingerprintSnapshot(snapshot),
    runtimeFingerprint: RUNTIME,
    evaluationRunId: RUN_ID,
  });
  const recoveredEvents = loaded.attempts.filter((event) => (
    event.attemptId === RUN_ID
    && decodeSourceBlockerEventMessage(event.message) !== null
  ));
  assert.equal(recoveredEvents.length, 1, "the retry/backoff event is recoverable from the atomic envelope");
  assert.deepEqual(decodeSourceBlockerEventMessage(recoveredEvents[0].message).receipt, receipt);
});

test("a crash cannot turn an unfinished fixed candidate 11 or 12 into a publishable generic draft", async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "daily-arxiv-source-tail-crash-test-")));
  const controlRoot = join(root, "control");
  mkdirSync(controlRoot, { mode: 0o700 });
  const report = validReport(CATEGORY, {
    count: 12,
    run: {
      modelId: "gpt-5.6-sol",
      modelDisplayName: "GPT-5.6-Sol",
      reasoningEffort: "high",
      modelSelectionVerified: true,
      runId: RUN_ID,
    },
  });
  const snapshot = fixtureSnapshot(report);
  snapshot.categories[CATEGORY].newCount = report.papers.length;
  snapshot.categories[CATEGORY].newIds = report.papers.map(({ arxivId }) => arxivId);
  const receipt = {
    schemaVersion: "1.0",
    status: "source_incomplete",
    arxivId: report.papers[11].arxivId,
    failureClass: MODEL_SOURCE_FAILURE_CLASS,
    provisionalCandidateIds: report.papers.map(({ arxivId }) => arxivId),
  };
  const job = openCheckpointJob({
    controlRoot,
    snapshot,
    snapshotFingerprint: fingerprintSnapshot(snapshot),
    runtimeFingerprint: RUNTIME,
    evaluationRunId: RUN_ID,
  });
  startCategoryAttempt(job, RUN_ID);
  preserveCheckpointCategorySourceDraft({
    job,
    category: CATEGORY,
    sourcePath: writeSource(root, "source-tail-crash.json", `${JSON.stringify(report)}\n`),
    sourceReceipt: receipt,
    attemptId: RUN_ID,
    validateDraft: (candidate, context) => validateCategorySourceResumeDraft({
      report: candidate,
      receipt,
      date: context.reportDate,
      slug: context.category,
      policy: validPolicy(),
      evaluationRunId: context.evaluationRunId,
      snapshot: context.snapshot,
      candidateOrderRequired: true,
    }),
  });

  const staging = join(root, "source-tail-crash-staging");
  mkdirSync(staging, { mode: 0o700 });
  const execution = prepareCategoryExecution({
    job,
    slug: CATEGORY,
    staging,
    snapshot,
    policy: validPolicy(),
  });
  assert.equal(execution.mode, "source_resume");
  assert.throws(() => validateCategorySourceResumeMutation({
    source: execution.draft.report,
    resumed: execution.draft.report,
    receipt: execution.sourceReceipt,
    requireComplete: true,
  }), /complete full-text review for the exact fixed candidate set/u);
});

test("partial full-text rescoring may move a fixed candidate below provisional top N", () => {
  const report = validReport(CATEGORY, { count: 13 });
  const initialCandidateIds = report.papers.slice(0, 12).map(({ arxivId }) => arxivId);
  report.papers[0].scores = {
    broadImpact: 0,
    categoryImpact: 0,
    originality: 0,
    technicalStrength: 0,
  };
  report.papers[0].totalScore = 0;
  const ranked = [...report.papers].sort((left, right) => (
    right.totalScore - left.totalScore
    || right.scores.broadImpact - left.scores.broadImpact
    || right.scores.originality - left.scores.originality
    || right.scores.technicalStrength - left.scores.technicalStrength
    || right.scores.categoryImpact - left.scores.categoryImpact
    || left.arxivId.localeCompare(right.arxivId)
  ));
  ranked.forEach((paper, index) => {
    paper.rank = index + 1;
  });
  const snapshot = fixtureSnapshot(report);
  snapshot.categories[CATEGORY].newCount = report.papers.length;
  snapshot.categories[CATEGORY].newIds = report.papers.map(({ arxivId }) => arxivId);
  const receipt = {
    schemaVersion: "1.0",
    status: "source_incomplete",
    arxivId: initialCandidateIds[1],
    failureClass: MODEL_SOURCE_FAILURE_CLASS,
    provisionalCandidateIds: initialCandidateIds,
  };
  assert.equal(report.papers[0].rank, 13);
  assert.equal(validateCategorySourceResumeDraft({
    report,
    receipt,
    date: DATE,
    slug: CATEGORY,
    policy: validPolicy(),
    evaluationRunId: report.evaluationRun.runId,
    snapshot,
    candidateOrderRequired: false,
  }), true);
  assert.throws(() => validateCategorySourceResumeDraft({
    report,
    receipt,
    date: DATE,
    slug: CATEGORY,
    policy: validPolicy(),
    evaluationRunId: report.evaluationRun.runId,
    snapshot,
    candidateOrderRequired: true,
  }), /initial deterministic provisional top-12 candidate order/u);
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

test("four terminally failed repairs retain the draft and fall back through capped generation backoff", async () => {
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
  const execution = prepareCategoryExecution({ job, slug: CATEGORY, staging, snapshot, policy });
  assert.equal(execution.mode, "generation");
  assert.equal(execution.stage, "category_generation");
  assert.equal(execution.draft, null);
  assert.equal(execution.regenerationFallback.repairFailureCount, MAX_UNCHANGED_DRAFT_REPAIR_FAILURES);
  assert.equal(execution.regenerationFallback.protectedDraft.sha256, draft.sha256);
  assert.equal(execution.regenerationFallback.announcementNeeded, true);
  assert.match(execution.prompt, /one resumable category stage/u);
  assert.deepEqual(
    readdirSync(staging),
    [],
    "full-regeneration fallback must not overwrite or materialize the protected draft",
  );
  assert.equal(existsSync(draft.path), true, "the previous protected draft remains immutable checkpoint evidence");

  const retry = computeCategoryRetryState({
    execution,
    attempts: loadCheckpointJob({
      controlRoot: job.controlRoot,
      reportDate: DATE,
      snapshotFingerprint: fingerprintSnapshot(snapshot),
      runtimeFingerprint: RUNTIME,
      evaluationRunId: RUN_ID,
    }).attempts,
    category: CATEGORY,
    now: new Date(),
  });
  assert.equal(retry.active, true);
  assert.equal(retry.shouldDefer, true);
  assert.equal(retry.failureCount, MAX_UNCHANGED_DRAFT_REPAIR_FAILURES);
  assert.equal(retry.delayHours, 72);

  appendCheckpointAttempt({
    job,
    attemptId: "run-20990105T180000Z-123456abcdef",
    stage: "category_regeneration_fallback",
    status: "deferred",
    category: CATEGORY,
    message: `REPAIR_REGENERATION_FALLBACK_DRAFT_SHA256=${draft.sha256}; Protected draft retained; bounded regeneration backoff remains active.`,
  });
  const secondStaging = join(root, "bounded-retry-second-staging");
  mkdirSync(secondStaging, { mode: 0o700 });
  const announced = prepareCategoryExecution({
    job,
    slug: CATEGORY,
    staging: secondStaging,
    snapshot,
    policy,
  });
  assert.equal(announced.regenerationFallback.announcementNeeded, false);
  assert.equal(existsSync(draft.path), true);
});

test("repair exhaustion follows the checkpoint lineage even when every failed repair preserves a new draft digest", async () => {
  const { root, report, snapshot, job, policy } = await fixtureJob();
  appendCheckpointAttempt({
    job,
    attemptId: RUN_ID,
    stage: "category_generation",
    status: "started",
    category: CATEGORY,
    message: "Started initial generation.",
    at: new Date("2099-01-05T12:01:00.000Z"),
  });
  let latestReport = report;
  let latestDraft = preserveCheckpointCategoryDraft({
    job,
    category: CATEGORY,
    sourcePath: writeSource(root, "lineage-initial.json", `${JSON.stringify(latestReport)}\n`),
    validateDraft: validateFixtureDraft(policy),
    attemptId: RUN_ID,
    now: new Date("2099-01-05T12:02:00.000Z"),
  });
  const draftDigests = new Set([latestDraft.sha256]);

  for (let index = 0; index < MAX_UNCHANGED_DRAFT_REPAIR_FAILURES; index += 1) {
    const hour = 13 + index;
    const attemptId = `run-20990105T${String(hour).padStart(2, "0")}0000Z-123456abcde${index}`;
    appendCheckpointAttempt({
      job,
      attemptId,
      stage: "category_repair",
      status: "started",
      category: CATEGORY,
      message: `REPAIR_SOURCE_DRAFT_SHA256=${latestDraft.sha256}; Started bounded repair.`,
      at: new Date(`2099-01-05T${String(hour).padStart(2, "0")}:00:00.000Z`),
    });
    const successor = structuredClone(latestReport);
    successor.papers[0].assessment = `既存判断を変えずに日本語表現だけを整えた修復稿 ${index + 1}。`;
    assert.equal(validateCategoryRepairMutation({ source: latestReport, repaired: successor }), true);
    latestDraft = preserveCheckpointCategoryDraft({
      job,
      category: CATEGORY,
      sourcePath: writeSource(root, `lineage-successor-${index}.json`, `${JSON.stringify(successor)}\n`),
      validateDraft: (candidate, context) => {
        validateFixtureDraft(policy)(candidate, context);
        return validateCategoryRepairMutation({ source: latestReport, repaired: candidate });
      },
      attemptId,
      now: new Date(`2099-01-05T${String(hour).padStart(2, "0")}:10:00.000Z`),
    });
    draftDigests.add(latestDraft.sha256);
    appendCheckpointAttempt({
      job,
      attemptId,
      stage: "category_repair",
      status: "failed",
      category: CATEGORY,
      message: `REPAIR_SOURCE_DRAFT_SHA256=${latestDraft.sha256}; repaired draft was preserved before a terminal transport failure.`,
      at: new Date(`2099-01-05T${String(hour).padStart(2, "0")}:20:00.000Z`),
    });
    latestReport = successor;
  }
  assert.equal(
    draftDigests.size,
    MAX_UNCHANGED_DRAFT_REPAIR_FAILURES + 1,
    "each repair must exercise a distinct protected successor digest",
  );

  const staging = join(root, "lineage-retry-staging");
  mkdirSync(staging, { mode: 0o700 });
  const exhausted = prepareCategoryExecution({ job, slug: CATEGORY, staging, snapshot, policy });
  assert.equal(exhausted.mode, "generation");
  assert.equal(exhausted.regenerationFallback.repairFailureCount, MAX_UNCHANGED_DRAFT_REPAIR_FAILURES);
  assert.equal(exhausted.regenerationFallback.protectedDraft.sha256, latestDraft.sha256);
  assert.equal(exhausted.regenerationFallback.announcementNeeded, true);

  appendCheckpointAttempt({
    job,
    attemptId: "run-20990105T180000Z-123456abcdef",
    stage: "category_regeneration_fallback",
    status: "deferred",
    category: CATEGORY,
    message: `REPAIR_REGENERATION_FALLBACK_DRAFT_SHA256=${latestDraft.sha256}; Protected draft retained.`,
    at: new Date("2099-01-05T18:00:00.000Z"),
  });
  const generationAttempt = "run-20990105T190000Z-123456abcdef";
  appendCheckpointAttempt({
    job,
    attemptId: generationAttempt,
    stage: "category_generation",
    status: "started",
    category: CATEGORY,
    message: "Started bounded regeneration after cooldown.",
    at: new Date("2099-01-05T19:00:00.000Z"),
  });
  const regenerated = structuredClone(latestReport);
  regenerated.papers[0].assessment = "再生成中に保護された新しい有効ドラフト。";
  const regeneratedDraft = preserveCheckpointCategoryDraft({
    job,
    category: CATEGORY,
    sourcePath: writeSource(root, "lineage-regenerated.json", `${JSON.stringify(regenerated)}\n`),
    validateDraft: validateFixtureDraft(policy),
    attemptId: generationAttempt,
    now: new Date("2099-01-05T19:10:00.000Z"),
  });
  appendCheckpointAttempt({
    job,
    attemptId: generationAttempt,
    stage: "category_generation",
    status: "failed",
    category: CATEGORY,
    message: "Regeneration transport failed after preserving its valid draft.",
    at: new Date("2099-01-05T19:20:00.000Z"),
  });

  const secondStaging = join(root, "lineage-retry-second-staging");
  mkdirSync(secondStaging, { mode: 0o700 });
  const continued = prepareCategoryExecution({
    job,
    slug: CATEGORY,
    staging: secondStaging,
    snapshot,
    policy,
  });
  assert.equal(continued.mode, "generation");
  assert.equal(continued.regenerationFallback.repairFailureCount, MAX_UNCHANGED_DRAFT_REPAIR_FAILURES);
  assert.equal(continued.regenerationFallback.protectedDraft.sha256, regeneratedDraft.sha256);
  assert.equal(
    continued.regenerationFallback.announcementNeeded,
    false,
    "a changed successor digest must not repeat the one-shot fallback notification",
  );
});

test("repair starts without terminal failures do not exhaust the unchanged-draft retry budget", async () => {
  const { root, report, snapshot, job, policy } = await fixtureJob();
  startCategoryAttempt(job, RUN_ID);
  const draft = preserveCheckpointCategoryDraft({
    job,
    category: CATEGORY,
    sourcePath: writeSource(root, "started-only.json", `${JSON.stringify(report)}\n`),
    validateDraft: validateFixtureDraft(policy),
    attemptId: RUN_ID,
  });
  for (let index = 0; index < MAX_UNCHANGED_DRAFT_REPAIR_FAILURES + 2; index += 1) {
    startCategoryAttempt(
      job,
      `run-20990105T${String(17 + index).padStart(2, "0")}0000Z-123456abcde${index}`,
      "category_repair",
      `REPAIR_SOURCE_DRAFT_SHA256=${draft.sha256}; Started bounded repair.`,
    );
  }
  const staging = join(root, "started-only-staging");
  mkdirSync(staging, { mode: 0o700 });
  const execution = prepareCategoryExecution({ job, slug: CATEGORY, staging, snapshot, policy });
  assert.equal(execution.mode, "repair");
  assert.equal(execution.unchangedFailures, 0);
});
