import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { CATEGORIES } from "../scripts/lib/pipeline.mjs";
import { DATE, validReportSet, writeReports } from "./helpers.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const AUDIT_SCRIPT = join(REPOSITORY_ROOT, "scripts", "audit-staged-language.mjs");

async function fixture(reports = validReportSet()) {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-language-audit-test-"));
  const staging = join(root, "staging");
  writeReports(root, reports, staging);
  return { root, staging };
}

function runAudit({ root, staging, output }) {
  return spawnSync(process.execPath, [AUDIT_SCRIPT, DATE, staging, output], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: { ...process.env, TMPDIR: root },
  });
}

function makeCategoryProseDiverse(reports) {
  for (const report of Object.values(reports)) {
    report.papers.forEach((paper, index) => {
      const n = index + 1;
      paper.abstractLines = [
        `固有の背景を示す論文第${n}要約一`,
        `固有の方法を示す論文第${n}要約二`,
        `固有の結果を示す論文第${n}要約三`,
      ];
      paper.curiosity = `固有の未解決課題を問う論文第${n}記述`;
      paper.concept = `固有の方法上の要点を示す論文第${n}項目`;
      paper.conclusion = `固有の主要結論と成立限界を示す論文第${n}記述`;
      paper.assessment = `固有の長所と主要な限界を比較する論文第${n}評価`;
      paper.scoreReasons = {
        broadImpact: `複数領域への波及経路を示す論文第${n}根拠`,
        categoryImpact: `主分野における前進を示す論文第${n}根拠`,
        originality: `既存手法との差分を示す論文第${n}根拠`,
        technicalStrength: `中心手法を支える検証を示す論文第${n}根拠`,
      };
      if (paper.fullTextEvaluated) {
        paper.fullTextReviewStatus = `固有の導出検証限界を確認した論文第${n}記録`;
      }
    });
  }
  return reports;
}

test("language audit exhaustively collects every supported invalid prose field", async () => {
  const reports = validReportSet();
  const quantPaper = reports["quant-ph"].papers[0];
  quantPaper.titleJa = "English only";
  quantPaper.paperType = "English only";
  quantPaper.curiosity = "English only";
  quantPaper.concept = "English only";
  quantPaper.conclusion = "English only";
  quantPaper.assessment = "English only";
  quantPaper.abstractLines = ["English only", "English only", "English only"];
  quantPaper.scoreReasons = {
    broadImpact: "English only",
    categoryImpact: "English only",
    originality: "English only",
    technicalStrength: "English only",
  };
  quantPaper.fullTextReviewStatus = "English only";
  reports["gr-qc"].papers[1].concept = "English only";

  const { root, staging } = await fixture(reports);
  const output = join(root, "language-issues-before.json");
  const result = runAudit({ root, staging, output });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`STAGED_LANGUAGE_AUDIT: ${DATE}; issues=15;`));
  const audit = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(audit.date, DATE);
  assert.equal(audit.count, 15);
  assert.equal(audit.issues.length, 15);

  const expectedPaths = new Set([
    "quant-ph:0:titleJa",
    "quant-ph:0:paperType",
    "quant-ph:0:curiosity",
    "quant-ph:0:concept",
    "quant-ph:0:conclusion",
    "quant-ph:0:assessment",
    "quant-ph:0:abstractLines[0]",
    "quant-ph:0:abstractLines[1]",
    "quant-ph:0:abstractLines[2]",
    "quant-ph:0:scoreReasons.broadImpact",
    "quant-ph:0:scoreReasons.categoryImpact",
    "quant-ph:0:scoreReasons.originality",
    "quant-ph:0:scoreReasons.technicalStrength",
    "quant-ph:0:fullTextReviewStatus",
    "gr-qc:1:concept",
  ]);
  assert.deepEqual(
    new Set(audit.issues.map(({ slug, index, path }) => `${slug}:${index}:${path}`)),
    expectedPaths,
  );
  for (const issue of audit.issues) {
    assert.equal(issue.value, "English only");
    assert.match(issue.message, new RegExp(`^probe\\.papers\\[${issue.index}\\]\\.`));
    assert.equal(issue.rank, reports[issue.slug].papers[issue.index].rank);
    assert.equal(issue.arxivId, reports[issue.slug].papers[issue.index].arxivId);
  }
});

test("language audit reports leaf and category prose issues without being blocked by score validation", async () => {
  const reports = makeCategoryProseDiverse(validReportSet({ count: 20 }));
  const quantPapers = reports["quant-ph"].papers;
  quantPapers[12].scores.technicalStrength = 18;
  quantPapers[12].totalScore = Object.values(quantPapers[12].scores).reduce((sum, value) => sum + value, 0);
  quantPapers[11].conclusion = "都市網で安全鍵率2.64 kbpsを報告した。";
  for (let index = 0; index < 6; index += 1) {
    quantPapers[index].concept = `論文${index + 1}の固有問題では到達しない量は何か、提案機構によって観測可能域をどこまで拡張できるか。`;
  }

  const { root, staging } = await fixture(reports);
  const before = new Map(
    CATEGORIES.map((slug) => [slug, readFileSync(join(staging, `${DATE}-${slug}.json`), "utf8")]),
  );
  const output = join(root, "language-issues-before.json");
  const result = runAudit({ root, staging, output });

  assert.equal(result.status, 0, result.stderr);
  const audit = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(audit.count, 2);
  const leaf = audit.issues.find((issue) => issue.scope === undefined);
  assert.deepEqual(
    { slug: leaf.slug, index: leaf.index, path: leaf.path, value: leaf.value },
    { slug: "quant-ph", index: 11, path: "conclusion", value: quantPapers[11].conclusion },
  );
  assert.match(leaf.message, /lowercase English token "kbps"/);
  const category = audit.issues.find((issue) => issue.scope === "category");
  assert.equal(category.slug, "quant-ph");
  assert.equal(category.path, "concept");
  assert.match(category.message, /sentence skeleton for 6 of 20 papers/);
  assert.deepEqual(category.affectedPapers.map(({ index }) => index), [0, 1, 2, 3, 4, 5]);
  for (const slug of CATEGORIES) {
    assert.equal(readFileSync(join(staging, `${DATE}-${slug}.json`), "utf8"), before.get(slug));
  }
});

test("language audit reports severe total-score and four-axis plateaus for batch rescoring", async () => {
  const reports = makeCategoryProseDiverse(validReportSet({ count: 20 }));
  const papers = reports["quant-ph"].papers;
  for (let index = 0; index < 8; index += 1) {
    papers[index].scores = {
      broadImpact: 22,
      categoryImpact: 13,
      originality: 12,
      technicalStrength: 11,
    };
    papers[index].totalScore = 58;
  }
  for (let index = 8; index < 16; index += 1) {
    papers[index].scores = {
      broadImpact: 21,
      categoryImpact: 14,
      originality: 13,
      technicalStrength: 12,
    };
    papers[index].totalScore = 60;
  }

  const { root, staging } = await fixture(reports);
  const output = join(root, "language-issues-before.json");
  const result = runAudit({ root, staging, output });

  assert.equal(result.status, 0, result.stderr);
  const audit = JSON.parse(readFileSync(output, "utf8"));
  const scoreIssues = audit.issues.filter((issue) => (
    issue.scope === "category" && ["totalScore", "scores"].includes(issue.path)
  ));
  assert.equal(scoreIssues.length, 2);
  assert.deepEqual(new Set(scoreIssues.map(({ path }) => path)), new Set(["totalScore", "scores"]));
  for (const issue of scoreIssues) {
    assert.equal(issue.slug, "quant-ph");
    assert.deepEqual(
      issue.affectedPapers.map(({ index }) => index),
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    );
  }
});

test("language audit sentinels do not create false structural-diversity failures", async () => {
  const reports = makeCategoryProseDiverse(validReportSet({ count: 20 }));
  for (let index = 0; index < 16; index += 1) {
    reports["quant-ph"].papers[index].concept = "English only";
  }
  const { root, staging } = await fixture(reports);
  const output = join(root, "language-issues-before.json");
  const result = runAudit({ root, staging, output });

  assert.equal(result.status, 0, result.stderr);
  const audit = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(audit.count, 16);
  assert.equal(audit.issues.every((issue) => issue.scope === undefined && issue.path === "concept"), true);
});

test("leaf prose failures do not hide an overlapping category diversity failure", async () => {
  const reports = makeCategoryProseDiverse(validReportSet({ count: 20 }));
  const papers = reports["quant-ph"].papers;
  for (let index = 0; index < 6; index += 1) {
    papers[index].concept = `論文${index + 1}の固有問題では到達しない量は何か、提案機構によって観測可能域をどこまで拡張できるか。`;
  }
  papers[0].concept += "安全率2.64 kbpsを指標とする。";

  const { root, staging } = await fixture(reports);
  const output = join(root, "language-issues-before.json");
  const result = runAudit({ root, staging, output });

  assert.equal(result.status, 0, result.stderr);
  const audit = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(audit.count, 2);
  const leaf = audit.issues.find((issue) => issue.scope === undefined);
  assert.deepEqual({ slug: leaf.slug, index: leaf.index, path: leaf.path }, {
    slug: "quant-ph",
    index: 0,
    path: "concept",
  });
  assert.match(leaf.message, /lowercase English token "kbps"/);
  const category = audit.issues.find((issue) => issue.scope === "category");
  assert.equal(category.path, "concept");
  assert.deepEqual(category.affectedPapers.map(({ index }) => index), [0, 1, 2, 3, 4, 5]);
});

test("language audit writes an empty private result without modifying staged reports", async () => {
  const { root, staging } = await fixture();
  const output = join(root, "language-issues-after.json");
  const reportPath = join(staging, `${DATE}-quant-ph.json`);
  const before = readFileSync(reportPath, "utf8");
  const result = runAudit({ root, staging, output });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`STAGED_LANGUAGE_AUDIT: ${DATE}; issues=0;`));
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), {
    date: DATE,
    count: 0,
    issues: [],
  });
  assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.equal(readFileSync(reportPath, "utf8"), before);
});

test("language audit treats equivalent real and symlinked run-root spellings as the same directory", async () => {
  const { root, staging } = await fixture();
  const aliasRoot = `${root}-alias`;
  symlinkSync(root, aliasRoot, "dir");
  const output = join(root, "language-issues-before.json");
  const result = runAudit({ root: aliasRoot, staging, output });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`STAGED_LANGUAGE_AUDIT: ${DATE}; issues=0;`));
});

test("language audit rejects non-fixed output paths and never overwrites an existing result", async () => {
  const { root, staging } = await fixture();
  const invalidOutput = join(root, "unexpected-language-issues.json");
  const invalidResult = runAudit({ root, staging, output: invalidOutput });
  assert.equal(invalidResult.status, 1);
  assert.match(invalidResult.stderr, /Output must be language-issues-before\.json or language-issues-after\.json/);
  assert.equal(existsSync(invalidOutput), false);

  const output = join(root, "language-issues-before.json");
  writeFileSync(output, "preserve this result\n", { mode: 0o600 });
  const overwriteResult = runAudit({ root, staging, output });
  assert.equal(overwriteResult.status, 1);
  assert.match(overwriteResult.stderr, /EEXIST/);
  assert.equal(readFileSync(output, "utf8"), "preserve this result\n");
});

test("language audit rejects a staging-directory symbolic link", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-language-audit-symlink-test-"));
  const realStaging = join(root, "real-staging");
  writeReports(root, validReportSet(), realStaging);
  const staging = join(root, "staging");
  symlinkSync(realStaging, staging, "dir");
  const output = join(root, "language-issues-before.json");
  const result = runAudit({ root, staging, output });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Staging must be a real directory/);
  assert.equal(existsSync(output), false);
  assert.equal(dirname(output), root);
});
