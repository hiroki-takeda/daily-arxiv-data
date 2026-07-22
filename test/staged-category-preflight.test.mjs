import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  SCORE_KEYS,
  parseJsonFile,
  validateModelPolicy,
  validateProductionReportStructure,
} from "../scripts/lib/pipeline.mjs";
import { DATE, validReport, validRun } from "./helpers.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(ROOT, "scripts", "preflight-staged-category.mjs");
const RUN_ID = "run-20990105T123456Z-abcdef123456";
const POLICY = validateModelPolicy(parseJsonFile(join(ROOT, "data", "model-policy.json")));

async function fixture(report = validReport("quant-ph", {
  run: { ...validRun(), runId: RUN_ID },
})) {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-structure-preflight-test-"));
  const staging = join(root, "staging", report.slug);
  mkdirSync(staging, { recursive: true });
  const reportPath = join(staging, `${report.reportDate}-${report.slug}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return { root, staging, reportPath };
}

function runPreflight({
  root,
  staging,
  outputName = "quant-ph-structure-audit-1.json",
  outputPath,
  date = DATE,
  runId = RUN_ID,
  slug = "quant-ph",
}) {
  const output = outputPath ?? join(root, outputName);
  const result = spawnSync(process.execPath, [SCRIPT, date, slug, staging, runId, output], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, TMPDIR: root },
  });
  return { output, result };
}

function readAudit(output) {
  return JSON.parse(readFileSync(output, "utf8"));
}

test("structure preflight accepts a complete report without running prose validation", async () => {
  const report = validReport("quant-ph", { run: { ...validRun(), runId: RUN_ID } });
  const paper = report.papers[0];
  paper.titleJa = "English only";
  paper.paperType = "English only";
  paper.abstractLines = ["English only", "English only", "English only"];
  paper.curiosity = "English only";
  paper.concept = "English only";
  paper.conclusion = "English only";
  paper.assessment = "English only";
  paper.scoreReasons = Object.fromEntries(SCORE_KEYS.map((key) => [key, "English only"]));
  paper.fullTextReviewStatus = "English only";
  const paths = await fixture(report);
  const before = readFileSync(paths.reportPath, "utf8");
  const { output, result } = runPreflight(paths);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`STAGED_CATEGORY_STRUCTURE_PREFLIGHT: ${DATE}; quant-ph; pass=1; issues=0;`));
  assert.deepEqual(readAudit(output), { date: DATE, slug: "quant-ph", count: 0, issues: [] });
  assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.equal(readFileSync(paths.reportPath, "utf8"), before);
});

test("structure preflight exhaustively reports missing and extra keys across every paper", async () => {
  const report = validReport("quant-ph", { run: { ...validRun(), runId: RUN_ID } });
  delete report.label;
  report.unexpectedTopLevel = true;
  delete report.evaluationRun.modelId;
  report.evaluationRun.unexpectedRuntimeField = true;
  delete report.audit.selectionRule;
  report.audit.unexpectedAuditField = true;
  delete report.audit.sourceCounts.newPrimary;
  report.audit.sourceCounts.unexpectedCount = 1;
  for (const index of [0, 1]) {
    delete report.papers[index].url;
    delete report.papers[index].arxivVersion;
    delete report.papers[index].submissionType;
  }
  report.papers[0].unexpectedPaperField = true;
  delete report.papers[0].scores.broadImpact;
  report.papers[0].scores.unexpectedScore = 1;
  delete report.papers[0].scoreReasons.originality;
  report.papers[0].scoreReasons.unexpectedReason = "English only";

  const paths = await fixture(report);
  const { output, result } = runPreflight(paths);
  assert.equal(result.status, 0, result.stderr);
  const preflight = readAudit(output);
  assert.equal(preflight.count, preflight.issues.length);
  const byPathAndKind = new Set(preflight.issues.map(({ path, kind }) => `${path}:${kind}`));
  assert.deepEqual(byPathAndKind, new Set([
    "report.audit.selectionRule:missing_key",
    "report.audit.sourceCounts.newPrimary:missing_key",
    "report.audit.sourceCounts.unexpectedCount:extra_key",
    "report.audit.unexpectedAuditField:extra_key",
    "report.evaluationRun.modelId:missing_key",
    "report.evaluationRun.unexpectedRuntimeField:extra_key",
    "report.label:missing_key",
    "report.papers[0].arxivVersion:missing_key",
    "report.papers[0].scoreReasons.originality:missing_key",
    "report.papers[0].scoreReasons.unexpectedReason:extra_key",
    "report.papers[0].scores.broadImpact:missing_key",
    "report.papers[0].scores.unexpectedScore:extra_key",
    "report.papers[0].submissionType:missing_key",
    "report.papers[0].unexpectedPaperField:extra_key",
    "report.papers[0].url:missing_key",
    "report.papers[1].arxivVersion:missing_key",
    "report.papers[1].submissionType:missing_key",
    "report.papers[1].url:missing_key",
    "report.unexpectedTopLevel:extra_key",
  ]));
});

test("structure preflight reports every invalid score axis without short-circuiting", async () => {
  const report = validReport("quant-ph", { run: { ...validRun(), runId: RUN_ID } });
  Object.assign(report.papers[0].scores, {
    broadImpact: -1,
    categoryImpact: 26,
    originality: 2.5,
    technicalStrength: "20",
  });
  const paths = await fixture(report);
  const { output, result } = runPreflight(paths);

  assert.equal(result.status, 0, result.stderr);
  const invalidScorePaths = readAudit(output).issues
    .filter(({ message }) => message === "must be an integer from 0 through 25")
    .map(({ path }) => path);
  assert.deepEqual(invalidScorePaths, SCORE_KEYS.map((key) => `report.papers[0].scores.${key}`).sort());
});

test("structure preflight survives multiple null nested values and reports them together", async () => {
  const report = validReport("quant-ph", { run: { ...validRun(), runId: RUN_ID } });
  report.evaluationRun = null;
  report.audit.sourceCounts = null;
  report.papers[0].scores = null;
  report.papers[1].scoreReasons = null;
  report.papers[2].authors = null;
  const paths = await fixture(report);
  const { output, result } = runPreflight(paths);

  assert.equal(result.status, 0, result.stderr);
  const pathsAndKinds = new Set(readAudit(output).issues.map(({ path, kind }) => `${path}:${kind}`));
  for (const expected of [
    "report.evaluationRun:type",
    "report.audit.sourceCounts:type",
    "report.papers[0].scores:type",
    "report.papers[1].scoreReasons:type",
    "report.papers[2].authors:value",
  ]) assert.ok(pathsAndKinds.has(expected), expected);
});

test("structure preflight uses canonical score order for rank and the complete top-ten review tuple", async () => {
  const report = validReport("quant-ph", { run: { ...validRun(), runId: RUN_ID } });
  const promoted = report.papers[10];
  promoted.scores.broadImpact = 23;
  promoted.totalScore = SCORE_KEYS.reduce((sum, key) => sum + promoted.scores[key], 0);
  promoted.rank = null;
  const paths = await fixture(report);
  const { output, result } = runPreflight(paths);

  assert.equal(result.status, 0, result.stderr);
  const issues = readAudit(output).issues;
  const promotedIssues = new Map(
    issues.filter(({ path }) => path.startsWith("report.papers[10]."))
      .map((issue) => [issue.path, issue]),
  );
  assert.ok(issues.some(({ path, message }) => (
    path === "report.papers[10].rank" && /deterministic rank/.test(message)
  )));
  for (const field of ["fullTextEvaluated", "evaluationBasis", "fullTextReviewStatus", "sourceUrls"]) {
    assert.equal(promotedIssues.get(`report.papers[10].${field}`).kind, "dependent_bundle", field);
  }
  assert.ok(issues.some(({ path, kind }) => path === "report.fullTextEvaluatedCount" && kind === "dependent_bundle"));
  assert.ok(issues.some(({ path, kind }) => path === "report.audit.fullTextEvaluatedCount" && kind === "dependent_bundle"));
});

test("canonical top-ten repair never emits the contradictory unreviewed tuple", async () => {
  const report = validReport("quant-ph", { run: { ...validRun(), runId: RUN_ID } });
  const promoted = report.papers[10];
  promoted.scores.broadImpact = 23;
  promoted.totalScore = SCORE_KEYS.reduce((sum, key) => sum + promoted.scores[key], 0);
  promoted.evaluationBasis = "full_text_major_sections";
  promoted.fullTextReviewStatus = "昇格候補の主要節、導出、検証、限界を確認した。";
  promoted.sourceUrls.push(`https://arxiv.org/pdf/${promoted.arxivId}v1`);
  const paths = await fixture(report);
  const { output, result } = runPreflight(paths);

  assert.equal(result.status, 0, result.stderr);
  const issues = readAudit(output).issues;
  assert.ok(issues.some(({ path, kind }) => (
    path === "report.papers[10].fullTextEvaluated" && kind === "dependent_bundle"
  )));
  for (const field of ["evaluationBasis", "fullTextReviewStatus", "sourceUrls"]) {
    assert.equal(
      issues.some(({ path }) => path === `report.papers[10].${field}`),
      false,
      `${field} already matches the required reviewed tuple`,
    );
  }
});

test("canonical top-ten repair exposes a projected full-text budget conflict in the same pass", async () => {
  const report = validReport("quant-ph", { count: 13, run: { ...validRun(), runId: RUN_ID } });
  for (const paper of report.papers.slice(10, 12)) {
    paper.fullTextEvaluated = true;
    paper.evaluationBasis = "full_text_major_sections";
    paper.fullTextReviewStatus = `論文${paper.rank}の主要節、導出、検証、限界を確認した。`;
    paper.sourceUrls.push(`https://arxiv.org/pdf/${paper.arxivId}v1`);
  }
  report.fullTextEvaluatedCount = 12;
  report.audit.fullTextEvaluatedCount = 12;
  const promoted = report.papers[12];
  promoted.scores.broadImpact = 23;
  promoted.totalScore = SCORE_KEYS.reduce((sum, key) => sum + promoted.scores[key], 0);
  const paths = await fixture(report);
  const { output, result } = runPreflight(paths);

  assert.equal(result.status, 0, result.stderr);
  const budget = readAudit(output).issues.find(({ path, kind, message }) => (
    path === "report.fullTextEvaluatedCount"
    && kind === "dependent_bundle"
    && /above the resource-budget limit 12/.test(message)
  ));
  assert.equal(budget.affectedPapers.length, 13);
});

test("structure preflight moves score-distribution defects before the language stage", async () => {
  const report = validReport("quant-ph", { count: 20, run: { ...validRun(), runId: RUN_ID } });
  for (let index = 0; index < 8; index += 1) {
    report.papers[index].scores = { broadImpact: 22, categoryImpact: 13, originality: 12, technicalStrength: 11 };
    report.papers[index].totalScore = 58;
  }
  for (let index = 8; index < 16; index += 1) {
    report.papers[index].scores = { broadImpact: 21, categoryImpact: 14, originality: 13, technicalStrength: 12 };
    report.papers[index].totalScore = 60;
  }
  const paths = await fixture(report);
  const { output, result } = runPreflight(paths);

  assert.equal(result.status, 0, result.stderr);
  const distribution = readAudit(output).issues.filter(({ kind }) => kind === "distribution");
  assert.deepEqual(new Set(distribution.map(({ path }) => path)), new Set([
    "report.papers.scores",
    "report.papers.totalScore",
  ]));
  assert.equal(distribution.every(({ affectedPapers }) => affectedPapers.length === 16), true);
});

test("structure preflight uses the canonical author normalizer, including punctuation and accents", async () => {
  for (const authors of [["A. B.", "A B"], ["José Álvarez", "Jose Alvarez"]]) {
    const report = validReport("quant-ph", { run: { ...validRun(), runId: RUN_ID } });
    report.papers[0].authors = authors;
    const paths = await fixture(report);
    const { output, result } = runPreflight(paths);
    assert.equal(result.status, 0, result.stderr);
    const duplicate = readAudit(output).issues.find(({ path, message }) => (
      path === "report.papers[0].authors" && /contains duplicate author/.test(message)
    ));
    assert.ok(duplicate);
  }
});

test("structure preflight reports more than four canonical-only defects in one bounded pass", async () => {
  const report = validReport("quant-ph", {
    run: { ...validRun(), runId: RUN_ID, reasoningEffort: "ultra" },
  });
  for (let index = 0; index < 6; index += 1) {
    report.papers[index].authors = ["A. B.", "A B"];
  }
  const paths = await fixture(report);
  const { output, result } = runPreflight(paths);

  assert.equal(result.status, 0, result.stderr);
  const issues = readAudit(output).issues;
  assert.ok(issues.some(({ path, message }) => (
    path === "report.evaluationRun.reasoningEffort" && /must equal "high"/.test(message)
  )));
  assert.deepEqual(
    issues.filter(({ path, message }) => (
      path.endsWith(".authors") && /contains duplicate author/.test(message)
    )).map(({ path }) => path),
    Array.from({ length: 6 }, (_, index) => `report.papers[${index}].authors`),
  );
  assert.equal(issues.some(({ kind }) => kind === "canonical_validation"), false);
});

test("a zero preflight result is equivalent to canonical production structure validation", async () => {
  const cases = [
    ["valid", () => {}],
    ["extra key", (report) => { report.papers[2].unexpected = true; }],
    ["null scores", (report) => { report.papers[1].scores = null; }],
    ["normalized duplicate author", (report) => { report.papers[0].authors = ["A. B.", "A B"]; }],
    ["invalid source-count object", (report) => { report.audit.sourceCounts = null; }],
    ["unreviewed canonical top paper", (report) => {
      report.papers[10].scores.broadImpact = 23;
      report.papers[10].totalScore = SCORE_KEYS.reduce((sum, key) => sum + report.papers[10].scores[key], 0);
    }],
  ];

  for (const [label, mutate] of cases) {
    const report = validReport("quant-ph", { run: { ...validRun(), runId: RUN_ID } });
    mutate(report);
    let canonicalPasses = true;
    try {
      validateProductionReportStructure(report, { date: DATE, slug: "quant-ph", policy: POLICY });
    } catch {
      canonicalPasses = false;
    }
    const paths = await fixture(report);
    const { output, result } = runPreflight(paths);
    assert.equal(result.status, 0, `${label}: ${result.stderr}`);
    assert.equal(readAudit(output).count === 0, canonicalPasses, label);
  }
});

test("structure preflight honors the canonical historical reasoning and full-text exception", async () => {
  const date = "2026-07-14";
  const runId = "run-20260714T074541Z-5510c1dfd1c6";
  const report = validReport("quant-ph", {
    date,
    count: 20,
    run: { ...validRun(), runId, reasoningEffort: "ultra" },
  });
  for (const paper of report.papers) {
    paper.scores = { broadImpact: 20, categoryImpact: 20, originality: 20, technicalStrength: 20 };
    paper.totalScore = 80;
    paper.fullTextEvaluated = true;
    paper.evaluationBasis = "full_text_major_sections";
    paper.fullTextReviewStatus ??= `論文${paper.rank}の主要節、結論、限界、付録を確認した。`;
    const pdfUrl = `https://arxiv.org/pdf/${paper.arxivId}v1`;
    if (!paper.sourceUrls.includes(pdfUrl)) paper.sourceUrls.push(pdfUrl);
  }
  report.fullTextEvaluatedCount = 20;
  report.audit.fullTextEvaluatedCount = 20;
  report.audit.generatedAtJst = `${date}T12:00:00+09:00`;
  const paths = await fixture(report);
  const { output, result } = runPreflight({ ...paths, date, runId });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readAudit(output).count, 0);
});

test("numbered structural audits require every prior nonzero result and stop after zero", async () => {
  const report = validReport("quant-ph", { run: { ...validRun(), runId: RUN_ID } });
  report.papers[0].url = "https://arxiv.org/abs/wrong";
  const paths = await fixture(report);
  const premature = runPreflight({ ...paths, outputName: "quant-ph-structure-audit-2.json" });
  assert.equal(premature.result.status, 1);
  assert.match(premature.result.stderr, /quant-ph-structure-audit-1\.json.*cannot be inspected/s);
  assert.equal(existsSync(premature.output), false);

  const first = runPreflight(paths);
  assert.equal(first.result.status, 0, first.result.stderr);
  assert.ok(readAudit(first.output).count > 0);
  const corrected = validReport("quant-ph", { run: { ...validRun(), runId: RUN_ID } });
  writeFileSync(paths.reportPath, `${JSON.stringify(corrected, null, 2)}\n`);
  const second = runPreflight({ ...paths, outputName: "quant-ph-structure-audit-2.json" });
  assert.equal(second.result.status, 0, second.result.stderr);
  assert.equal(readAudit(second.output).count, 0);

  const forbidden = runPreflight({ ...paths, outputName: "quant-ph-structure-audit-3.json" });
  assert.equal(forbidden.result.status, 1);
  assert.match(forbidden.result.stderr, /pass 2 already reported issues=0; no later audit is allowed/);
  assert.equal(existsSync(forbidden.output), false);
});

test("structure preflight constrains paths, rejects symlinks, and never overwrites", async () => {
  const paths = await fixture();
  const invalid = runPreflight({ ...paths, outputName: "unexpected-structure.json" });
  assert.equal(invalid.result.status, 1);
  assert.match(invalid.result.stderr, /Output must be quant-ph-structure-audit-1\.json through quant-ph-structure-audit-4\.json/);
  assert.equal(existsSync(invalid.output), false);

  const fifth = runPreflight({ ...paths, outputName: "quant-ph-structure-audit-5.json" });
  assert.equal(fifth.result.status, 1);
  assert.match(fifth.result.stderr, /structure-audit-1\.json through quant-ph-structure-audit-4\.json/);

  const escaped = join(paths.root, "..", "quant-ph-structure-audit-1.json");
  const traversal = runPreflight({ ...paths, outputPath: escaped });
  assert.equal(traversal.result.status, 1);
  assert.match(traversal.result.stderr, /directly under/);

  const output = join(paths.root, "quant-ph-structure-audit-1.json");
  writeFileSync(output, "preserve this result\n", { mode: 0o600 });
  const existing = runPreflight(paths);
  assert.equal(existing.result.status, 1);
  assert.match(existing.result.stderr, /EEXIST/);
  assert.equal(readFileSync(output, "utf8"), "preserve this result\n");

  const symlinkRoot = await mkdtemp(join(tmpdir(), "daily-arxiv-structure-output-symlink-test-"));
  const symlinkStaging = join(symlinkRoot, "staging", "quant-ph");
  mkdirSync(symlinkStaging, { recursive: true });
  writeFileSync(join(symlinkStaging, `${DATE}-quant-ph.json`), `${JSON.stringify(validReport("quant-ph", {
    run: { ...validRun(), runId: RUN_ID },
  }), null, 2)}\n`);
  const target = join(symlinkRoot, "protected-target");
  writeFileSync(target, "protected\n");
  const outputSymlink = join(symlinkRoot, "quant-ph-structure-audit-1.json");
  symlinkSync(target, outputSymlink);
  const symlinkResult = runPreflight({ root: symlinkRoot, staging: symlinkStaging });
  assert.equal(symlinkResult.result.status, 1);
  assert.match(symlinkResult.result.stderr, /EEXIST/);
  assert.equal(readFileSync(target, "utf8"), "protected\n");
});

test("structure preflight rejects symlinked staging directories and report files", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-structure-symlink-test-"));
  const realStaging = join(root, "real-staging");
  mkdirSync(realStaging, { recursive: true });
  writeFileSync(join(realStaging, `${DATE}-quant-ph.json`), `${JSON.stringify(validReport("quant-ph", {
    run: { ...validRun(), runId: RUN_ID },
  }), null, 2)}\n`);
  const staging = join(root, "staging", "quant-ph");
  mkdirSync(join(root, "staging"), { recursive: true });
  symlinkSync(realStaging, staging, "dir");
  const stagingResult = runPreflight({ root, staging });
  assert.equal(stagingResult.result.status, 1);
  assert.match(stagingResult.result.stderr, /Staging directory must be a real directory/);

  const reportRoot = await mkdtemp(join(tmpdir(), "daily-arxiv-structure-report-symlink-test-"));
  const reportStaging = join(reportRoot, "staging", "quant-ph");
  mkdirSync(reportStaging, { recursive: true });
  const target = join(reportRoot, "report-target.json");
  writeFileSync(target, `${JSON.stringify(validReport("quant-ph", {
    run: { ...validRun(), runId: RUN_ID },
  }), null, 2)}\n`);
  symlinkSync(target, join(reportStaging, `${DATE}-quant-ph.json`));
  const reportResult = runPreflight({ root: reportRoot, staging: reportStaging });
  assert.equal(reportResult.result.status, 1);
  assert.match(reportResult.result.stderr, /Category report must be a regular file/);
});
