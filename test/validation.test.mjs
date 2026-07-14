import assert from "node:assert/strict";
import test from "node:test";
import {
  CATEGORIES,
  validateDate,
  validateModelPolicy,
  validateProductionReportSet,
} from "../scripts/lib/pipeline.mjs";
import { DATE, validPolicy, validReportSet } from "./helpers.mjs";

function rejectsMutation(mutator, pattern) {
  const reports = validReportSet();
  mutator(reports);
  assert.throws(() => validateProductionReportSet(reports, { date: DATE, policy: validPolicy() }), pattern);
}

test("a complete production report set passes", () => {
  assert.doesNotThrow(() => validateProductionReportSet(validReportSet(), { date: DATE, policy: validPolicy() }));
});

test("a backfill report set accepts only consistent official pastweek listing URLs", () => {
  const reports = validReportSet();
  for (const slug of CATEGORIES) reports[slug].audit.listingUrl = `https://arxiv.org/list/${slug}/pastweek`;
  assert.doesNotThrow(() => validateProductionReportSet(reports, { date: DATE, policy: validPolicy() }));

  reports["hep-th"].audit.listingUrl = "https://arxiv.org/list/hep-th/new";
  assert.throws(
    () => validateProductionReportSet(reports, { date: DATE, policy: validPolicy() }),
    /same official listing kind/,
  );
});

test("model policy is enforceable without claiming benchmark qualification", () => {
  assert.doesNotThrow(() => validateModelPolicy(validPolicy()));
  const policy = validPolicy();
  policy.qualificationStatus = "qualified";
  assert.throws(() => validateModelPolicy(policy), /not_benchmarked/);
});

test("invalid schema is rejected", () => {
  rejectsMutation((reports) => { reports["hep-th"].schemaVersion = "1.2"; }, /schemaVersion/);
});

test("invalid and mismatched dates are rejected", () => {
  assert.throws(() => validateDate("2099-02-30"), /real calendar date/);
  rejectsMutation((reports) => { reports["gr-qc"].reportDate = "2099-01-06"; }, /reportDate/);
  rejectsMutation((reports) => { reports["quant-ph"].audit.announcementDate = "2099-01-06"; }, /announcementDate/);
});

test("incomplete audit is rejected", () => {
  rejectsMutation((reports) => { reports["hep-th"].audit.listingUrl = "https://example.test/new"; }, /listingUrl/);
  rejectsMutation((reports) => { reports["hep-th"].audit.sourceCounts.newPrimary -= 1; }, /newPrimary/);
});

test("invalid IDs and URLs are rejected", () => {
  rejectsMutation((reports) => { reports["hep-th"].papers[0].arxivId += "v1"; }, /arxivId/);
  rejectsMutation((reports) => { reports["gr-qc"].papers[0].url = "http://arxiv.org/abs/9901.00101"; }, /\.url/);
  rejectsMutation((reports) => { reports["quant-ph"].papers[0].arxivVersion = "v2"; }, /arxivVersion/);
  rejectsMutation((reports) => { reports["quant-ph"].papers[0].submissionType = "cross"; }, /submissionType/);
  rejectsMutation((reports) => { reports["hep-th"].papers[0].sourceUrls.push("https://example.com/untrusted"); }, /exactly the version-fixed arXiv/);
});

test("invalid score shape, range, and total are rejected", () => {
  rejectsMutation((reports) => { reports["hep-th"].papers[0].scores.citations = 25; }, /exactly/);
  rejectsMutation((reports) => { reports["hep-th"].papers[0].scores.broadImpact = 26; }, /0 through 25/);
  rejectsMutation((reports) => { reports["hep-th"].papers[0].totalScore -= 1; }, /four-score sum/);
});

test("schema 1.4 requires exact Japanese score reasons and the stable rubric marker", () => {
  rejectsMutation((reports) => { delete reports["hep-th"].papers[0].scoreReasons.originality; }, /scoreReasons.*exactly/);
  rejectsMutation((reports) => { reports["hep-th"].papers[0].scoreReasons.originality = "English only"; }, /natural Japanese/);
  rejectsMutation((reports) => {
    reports["hep-th"].papers[0].scoreReasons.broadImpact = "主題の分野横断的な射程を評価。";
  }, /generic rationale phrase/);
  rejectsMutation((reports) => { reports["hep-th"].audit.scoreRubric = "四つの軸を採点する。"; }, /Daily arXiv rubric 3\.0/);
});

test("schema 1.4 rejects repeated reasons within a paper or across a category", () => {
  rejectsMutation((reports) => {
    const paper = reports["hep-th"].papers[0];
    paper.scoreReasons.originality = paper.scoreReasons.broadImpact;
  }, /four distinct per-axis reasons/);
  rejectsMutation((reports) => {
    const papers = reports["hep-th"].papers;
    for (let index = 1; index < 3; index += 1) {
      papers[index].scoreReasons.broadImpact = papers[0].scoreReasons.broadImpact;
    }
  }, /scoreReasons\.broadImpact.*maximum 25%/);
  rejectsMutation((reports) => {
    const papers = reports["hep-th"].papers;
    for (let index = 1; index < 3; index += 1) papers[index].assessment = papers[0].assessment;
  }, /assessment.*maximum 25%/);
  rejectsMutation((reports) => {
    const papers = reports["hep-th"].papers;
    for (let index = 1; index < 3; index += 1) papers[index].fullTextReviewStatus = papers[0].fullTextReviewStatus;
  }, /fullTextReviewStatus.*maximum 25%/);
});

test("schema 1.4 diversity limit is strictly greater than 25 percent", () => {
  const reports = validReportSet({ count: 12 });
  const papers = reports["hep-th"].papers;
  for (let index = 1; index < 3; index += 1) {
    papers[index].scoreReasons.broadImpact = papers[0].scoreReasons.broadImpact;
    papers[index].assessment = papers[0].assessment;
  }
  assert.doesNotThrow(() => validateProductionReportSet(reports, { date: DATE, policy: validPolicy() }));
});

test("schema 1.4 requires Japanese prose in every reader-facing evaluation field", () => {
  for (const field of ["titleJa", "curiosity", "concept", "conclusion", "assessment"]) {
    rejectsMutation((reports) => { reports["hep-th"].papers[0][field] = "English only"; }, /natural Japanese/);
  }
  rejectsMutation((reports) => { reports["hep-th"].papers[0].abstractLines[1] = "English only"; }, /natural Japanese/);
  rejectsMutation((reports) => { reports["hep-th"].papers[0].titleJa = "量 English title"; }, /at least 2/);
  rejectsMutation((reports) => { reports["hep-th"].papers[0].curiosity = "問いです。"; }, /at least 6/);
  rejectsMutation((reports) => { reports["hep-th"].papers[0].abstractLines[1] = "方法です。"; }, /at least 6/);
  rejectsMutation((reports) => { reports["hep-th"].papers[0].scoreReasons.originality = "根拠です。"; }, /at least 12/);
  rejectsMutation((reports) => { reports["hep-th"].papers[0].assessment = "評価です。"; }, /at least 12/);
  rejectsMutation((reports) => { reports["hep-th"].papers[0].fullTextReviewStatus = "English only"; }, /natural Japanese/);
});

test("schema 1.4 rejects duplicated summary sections, copied conclusions, and generic assessments", () => {
  rejectsMutation((reports) => {
    const paper = reports["hep-th"].papers[0];
    paper.abstractLines[0] = paper.curiosity;
  }, /must not exactly duplicate/);
  rejectsMutation((reports) => {
    const paper = reports["hep-th"].papers[0];
    paper.assessment = `証拠を総合した。${paper.conclusion}`;
  }, /must not copy the conclusion/);
  rejectsMutation((reports) => {
    reports["hep-th"].papers[0].assessment = "物理的内容を確認し、分野内での重要度を評価した。";
  }, /generic rationale phrase/);
});

test("historical schema 1.3 remains valid but cannot bypass new-publication checks", () => {
  const reports = validReportSet();
  for (const report of Object.values(reports)) {
    report.schemaVersion = "1.3";
    report.audit.scoreRubric = "Historical four-axis rubric.";
    for (const paper of report.papers) delete paper.scoreReasons;
  }
  const historical = reports["hep-th"].papers[0];
  historical.titleJa = "Historical English title";
  historical.abstractLines[0] = historical.curiosity;
  historical.assessment = `${historical.conclusion} 主題の分野横断的な射程を評価。`;
  assert.doesNotThrow(() => validateProductionReportSet(reports, {
    date: DATE,
    policy: validPolicy(),
    requiredSchema: "1.3",
  }));
  assert.throws(
    () => validateProductionReportSet(reports, { date: DATE, policy: validPolicy() }),
    /schemaVersion: must be 1\.4/,
  );
});

test("every final top-ten paper must be full-text reviewed", () => {
  rejectsMutation((reports) => {
    const paper = reports["quant-ph"].papers[9];
    paper.fullTextEvaluated = false;
    paper.evaluationBasis = "title_authors_abstract";
    delete paper.fullTextReviewStatus;
    paper.sourceUrls = [`${paper.url}v1`];
    paper.scores.technicalStrength = 17;
    paper.totalScore = Object.values(paper.scores).reduce((sum, value) => sum + value, 0);
    reports["quant-ph"].fullTextEvaluatedCount -= 1;
    reports["quant-ph"].audit.fullTextEvaluatedCount -= 1;
  }, /final top-10/);
});

test("rubric 3.0 caps scores that lack full-text evidence", () => {
  rejectsMutation((reports) => {
    const paper = reports["hep-th"].papers[10];
    paper.scores.broadImpact = 24;
    paper.totalScore = Object.values(paper.scores).reduce((sum, value) => sum + value, 0);
  }, /below 24 without full-text review/);
  rejectsMutation((reports) => {
    const paper = reports["hep-th"].papers[10];
    paper.scores.technicalStrength = 18;
    paper.totalScore = Object.values(paper.scores).reduce((sum, value) => sum + value, 0);
  }, /at most 17 without full-text review/);
});

test("model identity and reasoning effort are exact", () => {
  rejectsMutation((reports) => { reports["hep-th"].evaluationRun.modelId = "gpt-5.6-other"; }, /modelId/);
  rejectsMutation((reports) => { reports["hep-th"].evaluationRun.reasoningEffort = "high"; }, /reasoningEffort/);
  rejectsMutation((reports) => { reports["hep-th"].evaluationRun.modelSelectionVerified = false; }, /modelSelectionVerified/);
});

test("all categories share one exact run and a run cannot be reused", () => {
  rejectsMutation((reports) => { reports["gr-qc"].evaluationRun.runId = "run-2099-01-05-other"; }, /identical evaluationRun/);
  assert.throws(() => validateProductionReportSet(validReportSet(), {
    date: DATE,
    policy: validPolicy(),
    existingRunIds: new Set(["run-2099-01-05-fixture"]),
  }), /already used/);
});

test("equivalent run metadata is independent of JSON property order", () => {
  const reports = validReportSet();
  const run = reports["gr-qc"].evaluationRun;
  reports["gr-qc"].evaluationRun = {
    runId: run.runId,
    modelSelectionVerified: run.modelSelectionVerified,
    reasoningEffort: run.reasoningEffort,
    modelDisplayName: run.modelDisplayName,
    modelId: run.modelId,
  };
  assert.doesNotThrow(() => validateProductionReportSet(reports, { date: DATE, policy: validPolicy() }));
});

test("paper IDs cannot be duplicated within or across categories", () => {
  rejectsMutation((reports) => { reports["hep-th"].papers[1] = structuredClone(reports["hep-th"].papers[0]); }, /duplicated in this report/);
  rejectsMutation((reports) => {
    const source = reports["hep-th"].papers[0];
    const target = reports["gr-qc"].papers[0];
    target.arxivId = source.arxivId;
    target.url = source.url;
    target.sourceUrls = source.sourceUrls;
  }, /across categories/);
});

test("the report set has exactly the three configured categories", () => {
  const reports = validReportSet();
  reports.extra = reports[CATEGORIES[0]];
  assert.throws(() => validateProductionReportSet(reports, { date: DATE, policy: validPolicy() }), /exactly/);
});
