import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = mkdtempSync(resolve(tmpdir(), "daily-arxiv-v2-"));
mkdirSync(resolve(root, "data/reports"), { recursive: true });
mkdirSync(resolve(root, "public/data"), { recursive: true });
cpSync(resolve("data/distinguished-authors.json"), resolve(root, "data/distinguished-authors.json"));

const date = "2099-01-05";
const categories = ["hep-th", "gr-qc", "quant-ph"];
for (const [index, slug] of categories.entries()) {
  const authors = slug === "hep-th" ? ["Marc Henneaux"] : [`Test Author ${index}`];
  const paper = {
    rank: 0,
    arxivId: `9901.0000${index + 1}`,
    url: `https://arxiv.org/abs/9901.0000${index + 1}`,
    title: `Fixture ${slug}`,
    titleJa: `テスト ${slug}`,
    authors,
    primaryCategory: slug,
    paperType: "理論",
    scores: { broadImpact: 20, categoryImpact: 21, originality: 22, technicalStrength: 23 },
    totalScore: 86,
    abstractLines: ["一行目。", "二行目。", "三行目。"],
    curiosity: "背景。",
    concept: "方法。",
    conclusion: "結論。",
    assessment: "四項目を評価。",
    evaluationBasis: "full_text_major_sections",
    fullTextEvaluated: true,
    fullTextReviewStatus: "Fixture PDFの全主要節を確認。"
  };
  const report = {
    schemaVersion: "1.2",
    slug,
    label: slug,
    totalNew: 1,
    crosslistsExcluded: 0,
    evaluatedCount: 1,
    papers: [paper],
    audit: { announcementDate: date }
  };
  writeFileSync(resolve(root, `data/reports/${date}-${slug}.json`), JSON.stringify(report));
}

const mergeScript = resolve("scripts/merge_category_reports.mjs");
const result = spawnSync(process.execPath, [mergeScript, date], { cwd: root, encoding: "utf8" });
assert.equal(result.status, 0, result.stderr);
const dashboard = JSON.parse(readFileSync(resolve(root, `public/data/${date}.json`), "utf8"));
assert.equal(dashboard.schemaVersion, "1.2");
assert.equal(dashboard.categories["hep-th"].topPapers[0].totalScore, 86);
assert.equal(dashboard.categories["hep-th"].topPapers[0].eminentAuthors[0].authorName, "Marc Henneaux");
assert.equal(dashboard.categories["gr-qc"].topPapers[0].eminentAuthors.length, 0);
assert.equal(dashboard.pipeline.scoreMaximum, 100);
console.log("rubric-v2 merge tests passed");
