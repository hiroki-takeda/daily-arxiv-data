import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = mkdtempSync(resolve(tmpdir(), "daily-arxiv-model-policy-"));
mkdirSync(resolve(root, "data/reports"), { recursive: true });
mkdirSync(resolve(root, "public/data"), { recursive: true });
cpSync(resolve("data/distinguished-authors.json"), resolve(root, "data/distinguished-authors.json"));
writeFileSync(resolve(root, "data/model-policy.json"), JSON.stringify({
  qualificationStatus: "qualified",
}));

const date = "2099-02-03";
const categories = ["hep-th", "gr-qc", "quant-ph"];
const evaluationRun = {
  modelId: "gpt-5.6-sol",
  modelDisplayName: "5.6 Sol Ultra",
  reasoningEffort: "ultra",
  modelSelectionVerified: true,
  runId: "fixture-sol-ultra-run",
};

for (const [index, slug] of categories.entries()) {
  const paper = {
    rank: 1,
    arxivId: `9902.0000${index + 1}`,
    url: `https://arxiv.org/abs/9902.0000${index + 1}`,
    title: `Qualified fixture ${slug}`,
    titleJa: `適格テスト ${slug}`,
    authors: [`Test Author ${index}`],
    primaryCategory: slug,
    paperType: "理論",
    scores: { broadImpact: 20, categoryImpact: 21, originality: 22, technicalStrength: 23 },
    totalScore: 86,
    abstractLines: ["一行目。", "二行目。", "三行目。"],
    curiosity: "背景。",
    concept: "方法。",
    conclusion: "結論。",
    assessment: "四項目を全文から評価。",
    evaluationBasis: "full_text_major_sections",
    fullTextEvaluated: true,
    fullTextReviewStatus: "PDFの主要節と付録を確認。",
  };
  writeFileSync(resolve(root, `data/reports/${date}-${slug}.json`), JSON.stringify({
    schemaVersion: "1.3",
    evaluationRun,
    slug,
    label: slug,
    totalNew: 1,
    crosslistsExcluded: 0,
    evaluatedCount: 1,
    fullTextEvaluatedCount: 1,
    papers: [paper],
    audit: { announcementDate: date },
  }));
}

const mergeScript = resolve("scripts/merge_category_reports.mjs");
const valid = spawnSync(process.execPath, [mergeScript, date, "--require-model-policy"], {
  cwd: root,
  encoding: "utf8",
});
assert.equal(valid.status, 0, valid.stderr);
const dashboard = JSON.parse(readFileSync(resolve(root, `public/data/${date}.json`), "utf8"));
assert.equal(dashboard.schemaVersion, "1.3");
assert.deepEqual(dashboard.pipeline.evaluationRun, evaluationRun);

const invalidPath = resolve(root, `data/reports/${date}-quant-ph.json`);
const invalidReport = JSON.parse(readFileSync(invalidPath, "utf8"));
invalidReport.evaluationRun.modelId = "gpt-5.6-terra";
writeFileSync(invalidPath, JSON.stringify(invalidReport));
const invalid = spawnSync(process.execPath, [mergeScript, date, "--require-model-policy"], {
  cwd: root,
  encoding: "utf8",
});
assert.notEqual(invalid.status, 0, "a non-Sol run must be rejected");

console.log("Sol Ultra model-policy tests passed");
