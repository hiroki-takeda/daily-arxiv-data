import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

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
