#!/usr/bin/env node

import { lstatSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import {
  CATEGORIES,
  SCORE_KEYS,
  assertExactStagingReports,
  findCategoryProseDiversityIndices,
  findCategoryStructuralDiversityIndices,
  findProductionScoreDistributionIssues,
  parseJsonFile,
  validateDate,
  validateProductionPaperProse,
  validateProductionReportProseDiversity,
} from "./lib/pipeline.mjs";

function fail(message) {
  throw new Error(message);
}

const FIELD_PATTERN = /^probe\.papers\[(\d+)\]\.(titleJa|paperType|curiosity|concept|conclusion|assessment|fullTextReviewStatus|abstractLines\[(\d+)\]|scoreReasons\.(broadImpact|categoryImpact|originality|technicalStrength)):/u;
const SCORE_REASON_GROUP_PATTERN = /^probe\.papers\[(\d+)\]\.scoreReasons:/u;
const CATEGORY_FIELD_PATTERN = /^probe\.papers\.(curiosity|concept|conclusion|assessment|fullTextReviewStatus|abstractLines\[(\d+)\]|scoreReasons\.(broadImpact|categoryImpact|originality|technicalStrength)):/u;
const OUTPUT_NAMES = new Set(["language-issues-before.json", "language-issues-after.json"]);

function parseFieldPath(path) {
  const line = /^abstractLines\[(\d+)\]$/u.exec(path);
  if (line) return { field: path, lineIndex: Number(line[1]) };
  const score = /^scoreReasons\.(broadImpact|categoryImpact|originality|technicalStrength)$/u.exec(path);
  if (score) return { field: path, scoreKey: score[1] };
  return { field: path };
}

function getField(paper, path) {
  const { field, lineIndex, scoreKey } = parseFieldPath(path);
  if (lineIndex !== undefined) return paper.abstractLines[lineIndex];
  if (scoreKey !== undefined) return paper.scoreReasons[scoreKey];
  return paper[field];
}

function setSentinel(paper, path, paperIndex) {
  const { field, lineIndex, scoreKey } = parseFieldPath(path);
  const n = paperIndex + 1;
  if (lineIndex !== undefined) {
    paper.abstractLines[lineIndex] = `固有の課題方法結果を示す論文第${n}要約${lineIndex + 1}`;
    return;
  }
  if (scoreKey !== undefined) {
    const labels = {
      broadImpact: "複数領域への波及経路",
      categoryImpact: "主分野における前進",
      originality: "既存手法との差分",
      technicalStrength: "中心手法を支える検証",
    };
    paper.scoreReasons[scoreKey] = `${labels[scoreKey]}を示す論文第${n}根拠`;
    return;
  }
  const sentinels = {
    titleJa: `中心課題を示す論文第${n}日本語題名`,
    paperType: "理論および方法",
    curiosity: `固有の未解決課題を問う論文第${n}記述`,
    concept: `固有の方法上の要点を示す論文第${n}項目`,
    conclusion: `固有の主要結論と成立限界を示す論文第${n}記述`,
    assessment: `固有の長所と主要な限界を比較する論文第${n}評価`,
    fullTextReviewStatus: `固有の導出検証限界を確認した論文第${n}記録`,
  };
  paper[field] = sentinels[field];
}

function recordPaperIssue({ issues, seen, slug, original, paperIndex, path, message }) {
  const key = `${slug}:paper:${paperIndex}:${path}`;
  if (seen.has(key)) return;
  seen.add(key);
  issues.push({
    slug,
    index: paperIndex,
    rank: original.papers[paperIndex].rank,
    arxivId: original.papers[paperIndex].arxivId,
    path,
    message,
    value: getField(original.papers[paperIndex], path),
  });
}

function categoryEntries(report, path) {
  const papers = path === "fullTextReviewStatus"
    ? report.papers.map((paper, index) => ({ paper, index })).filter(({ paper }) => paper.fullTextEvaluated)
    : report.papers.map((paper, index) => ({ paper, index }));
  return papers.map(({ paper, index }) => ({ index, value: getField(paper, path) }));
}

function recordCategoryIssue({ issues, categoryIssues, slug, original, path, message, paperIndices }) {
  const key = `${slug}:category:${path}`;
  let issue = categoryIssues.get(key);
  if (issue === undefined) {
    issue = {
      scope: "category",
      slug,
      path,
      message,
      affectedPapers: [],
    };
    categoryIssues.set(key, issue);
    issues.push(issue);
  }
  const existing = new Set(issue.affectedPapers.map(({ index }) => index));
  for (const paperIndex of paperIndices) {
    if (existing.has(paperIndex)) continue;
    existing.add(paperIndex);
    issue.affectedPapers.push({
      index: paperIndex,
      rank: original.papers[paperIndex].rank,
      arxivId: original.papers[paperIndex].arxivId,
    });
  }
  issue.affectedPapers.sort((left, right) => left.index - right.index);
}

try {
  if (process.argv.length !== 5) {
    fail("Usage: node scripts/audit-staged-language.mjs <YYYY-MM-DD> <fixed-staging-directory> <fixed-output-file>");
  }
  const date = validateDate(process.argv[2]);
  const runRoot = resolve(process.env.TMPDIR ?? "");
  const staging = resolve(process.argv[3]);
  const output = resolve(process.argv[4]);
  const stagingEntry = lstatSync(staging);
  if (stagingEntry.isSymbolicLink() || !stagingEntry.isDirectory()) fail("Staging must be a real directory.");
  const canonicalRunRoot = realpathSync(runRoot);
  if (realpathSync(staging) !== resolve(canonicalRunRoot, "staging")) {
    fail(`Staging directory must be ${resolve(runRoot, "staging")}.`);
  }
  if (realpathSync(dirname(output)) !== canonicalRunRoot || !OUTPUT_NAMES.has(basename(output))) {
    fail(`Output must be language-issues-before.json or language-issues-after.json directly under ${runRoot}.`);
  }
  const paths = assertExactStagingReports(staging, date);
  const issues = [];
  const categoryIssues = new Map();

  for (const slug of CATEGORIES) {
    const original = parseJsonFile(paths[slug]);
    const paperProbe = structuredClone(original);
    const categoryProbe = structuredClone(original);
    const seen = new Set();
    for (const [paperIndex, paper] of paperProbe.papers.entries()) {
      let completed = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          validateProductionPaperProse(paper, `probe.papers[${paperIndex}]`);
          completed = true;
          break;
        } catch (error) {
          const match = FIELD_PATTERN.exec(error.message);
          if (match) {
            const [, paperIndexText, path] = match;
            const matchedPaperIndex = Number(paperIndexText);
            if (matchedPaperIndex !== paperIndex) fail(`Unexpected paper index in prose validation: ${error.message}`);
            const key = `${slug}:paper:${paperIndex}:${path}`;
            if (seen.has(key)) fail(`Repeated validation failure at ${key}: ${error.message}`);
            recordPaperIssue({ issues, seen, slug, original, paperIndex, path, message: error.message });
            setSentinel(paper, path, paperIndex);
            continue;
          }
          const scoreGroup = SCORE_REASON_GROUP_PATTERN.exec(error.message);
          if (!scoreGroup || Number(scoreGroup[1]) !== paperIndex) throw error;
          for (const scoreKey of SCORE_KEYS) {
            const path = `scoreReasons.${scoreKey}`;
            recordPaperIssue({ issues, seen, slug, original, paperIndex, path, message: error.message });
            setSentinel(paper, path, paperIndex);
          }
        }
      }
      if (!completed) fail(`Language audit exceeded its bounded per-paper iteration limit for ${slug} paper ${paperIndex}.`);
    }

    let categoryCompleted = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        validateProductionReportProseDiversity(categoryProbe, "probe");
        categoryCompleted = true;
        break;
      } catch (error) {
        const match = CATEGORY_FIELD_PATTERN.exec(error.message);
        if (!match) throw error;
        const [, path] = match;
        const entries = categoryEntries(categoryProbe, path);
        const values = entries.map(({ value }) => value);
        const repeatedEntryIndices = error.message.includes("must not reuse identical text")
          ? findCategoryProseDiversityIndices(values)
          : error.message.includes("must not reuse a punctuation-anchored sentence skeleton")
            ? findCategoryStructuralDiversityIndices(values)
            : undefined;
        if (repeatedEntryIndices === undefined) {
          fail(`Could not resolve category diversity failure: ${error.message}`);
        }
        const paperIndices = repeatedEntryIndices.map((entryIndex) => entries[entryIndex].index);
        recordCategoryIssue({
          issues,
          categoryIssues,
          slug,
          original,
          path,
          message: error.message,
          paperIndices,
        });
        for (const paperIndex of paperIndices) setSentinel(categoryProbe.papers[paperIndex], path, paperIndex);
      }
    }
    if (!categoryCompleted) fail(`Language audit exceeded its bounded category iteration limit for ${slug}.`);

    for (const scoreIssue of findProductionScoreDistributionIssues(original)) {
      recordCategoryIssue({
        issues,
        categoryIssues,
        slug,
        original,
        path: scoreIssue.path,
        message: `probe.papers.${scoreIssue.path}: ${scoreIssue.message}`,
        paperIndices: scoreIssue.paperIndices,
      });
    }
  }

  writeFileSync(output, `${JSON.stringify({ date, count: issues.length, issues }, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  console.log(`STAGED_LANGUAGE_AUDIT: ${date}; issues=${issues.length}; output=${output}`);
} catch (error) {
  console.error(`ACTION_REQUIRED: STAGED_LANGUAGE_AUDIT_FAILED: ${error.stack ?? error.message}`);
  process.exitCode = 1;
}
