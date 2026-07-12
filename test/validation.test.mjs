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
});

test("invalid score shape, range, and total are rejected", () => {
  rejectsMutation((reports) => { reports["hep-th"].papers[0].scores.citations = 25; }, /exactly/);
  rejectsMutation((reports) => { reports["hep-th"].papers[0].scores.broadImpact = 26; }, /0 through 25/);
  rejectsMutation((reports) => { reports["hep-th"].papers[0].totalScore -= 1; }, /four-score sum/);
});

test("every final top-ten paper must be full-text reviewed", () => {
  rejectsMutation((reports) => {
    const paper = reports["quant-ph"].papers[9];
    paper.fullTextEvaluated = false;
    paper.evaluationBasis = "title_authors_abstract";
    delete paper.fullTextReviewStatus;
    paper.sourceUrls = [`${paper.url}v1`];
    reports["quant-ph"].fullTextEvaluatedCount -= 1;
    reports["quant-ph"].audit.fullTextEvaluatedCount -= 1;
  }, /final top-10/);
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
