#!/usr/bin/env node

import { existsSync, lstatSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CATEGORIES,
  MAX_LANGUAGE_AUDIT_PASSES,
  MAX_STRUCTURE_AUDIT_PASSES,
  SCORE_KEYS,
  findCategoryProseDiversityIndices,
  findCategoryStructuralDiversityIndices,
  parseJsonFile,
  validateDate,
  validateModelPolicy,
  validateProductionPaperProse,
  validateProductionReportStructure,
  validateProductionReportProseDiversity,
} from "./lib/pipeline.mjs";

function fail(message) {
  throw new Error(message);
}

const FIELD_PATTERN = /^probe\.papers\[(\d+)\]\.(titleJa|paperType|curiosity|concept|conclusion|assessment|fullTextReviewStatus|abstractLines\[(\d+)\]|scoreReasons\.(broadImpact|categoryImpact|originality|technicalStrength)):/u;
const SCORE_REASON_GROUP_PATTERN = /^probe\.papers\[(\d+)\]\.scoreReasons:/u;
const CATEGORY_FIELD_PATTERN = /^probe\.papers\.(curiosity|concept|conclusion|assessment|fullTextReviewStatus|abstractLines\[(\d+)\]|scoreReasons\.(broadImpact|categoryImpact|originality|technicalStrength)):/u;
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function auditOutputName(category, pass) {
  return `${category}-language-audit-${pass}.json`;
}

function parseAuditPass(outputName, category) {
  for (let pass = 1; pass <= MAX_LANGUAGE_AUDIT_PASSES; pass += 1) {
    if (outputName === auditOutputName(category, pass)) return pass;
  }
  return undefined;
}

function validatePriorAudit(path, date, pass) {
  const audit = parseJsonFile(path);
  const keys = Object.keys(audit ?? {}).sort();
  if (keys.join("\0") !== ["count", "date", "issues"].sort().join("\0")) {
    fail(`Language audit pass ${pass} has an invalid result shape.`);
  }
  if (audit.date !== date) fail(`Language audit pass ${pass} is for ${audit.date}, not ${date}.`);
  if (!Number.isSafeInteger(audit.count) || audit.count < 0 || !Array.isArray(audit.issues)) {
    fail(`Language audit pass ${pass} has an invalid issue count.`);
  }
  if (audit.count !== audit.issues.length) {
    fail(`Language audit pass ${pass} count does not match its issue array.`);
  }
  if (audit.count === 0) {
    fail(`Language audit pass ${pass} already reported issues=0; no later audit is allowed.`);
  }
}

function validateAuditSequence({ runRoot, category, date, pass }) {
  for (let priorPass = 1; priorPass < pass; priorPass += 1) {
    validatePriorAudit(resolve(runRoot, auditOutputName(category, priorPass)), date, priorPass);
  }
}

function validateStructureGate(runRoot, date, category) {
  for (let pass = 1; pass <= MAX_STRUCTURE_AUDIT_PASSES; pass += 1) {
    const path = resolve(runRoot, `${category}-structure-audit-${pass}.json`);
    if (!existsSync(path)) {
      fail(`Structural audit pass ${pass} is missing; a zero result is required before a language audit.`);
    }
    const result = parseJsonFile(path);
    const keys = Object.keys(result ?? {}).sort();
    if (keys.join("\0") !== ["date", "slug", "count", "issues"].sort().join("\0")) {
      fail(`Structural audit pass ${pass} result has an invalid shape.`);
    }
    if (result.date !== date || result.slug !== category) {
      fail(`Structural audit pass ${pass} result must describe ${date} ${category}.`);
    }
    if (!Number.isSafeInteger(result.count) || result.count < 0 || !Array.isArray(result.issues)
      || result.count !== result.issues.length) {
      fail(`Structural audit pass ${pass} result has an invalid issue count.`);
    }
    if (result.count === 0) return;
  }
  fail(`Structural audit pass ${MAX_STRUCTURE_AUDIT_PASSES} is nonzero; no language audit is allowed.`);
}

function exactCategoryReport(staging, date, slug) {
  const expectedName = `${date}-${slug}.json`;
  const names = readdirSync(staging).sort();
  if (names.length !== 1 || names[0] !== expectedName) {
    fail(`Category staging must contain exactly ${expectedName}.`);
  }
  const path = resolve(staging, expectedName);
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isFile()) fail("Category report must be a regular file.");
  return path;
}

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
  if (process.argv.length !== 7) {
    fail("Usage: node scripts/audit-staged-language.mjs <YYYY-MM-DD> <fixed-category-staging-directory> <fixed-output-file> <category> <evaluation-run-id>");
  }
  const date = validateDate(process.argv[2]);
  const runRoot = resolve(process.env.TMPDIR ?? "");
  const staging = resolve(process.argv[3]);
  const output = resolve(process.argv[4]);
  const requestedCategory = process.argv[5];
  const expectedEvaluationRunId = process.argv[6];
  if (!CATEGORIES.includes(requestedCategory)) {
    fail(`Unsupported category ${requestedCategory}.`);
  }
  if (typeof expectedEvaluationRunId !== "string" || expectedEvaluationRunId.trim() === "") {
    fail("A category language audit requires the host evaluation runId.");
  }
  const stagingEntry = lstatSync(staging);
  if (stagingEntry.isSymbolicLink() || !stagingEntry.isDirectory()) fail("Staging must be a real directory.");
  const canonicalRunRoot = realpathSync(runRoot);
  const expectedStaging = resolve(canonicalRunRoot, "staging", requestedCategory);
  if (realpathSync(staging) !== expectedStaging) {
    fail(`Staging directory must be ${expectedStaging}.`);
  }
  const auditPass = parseAuditPass(basename(output), requestedCategory);
  if (realpathSync(dirname(output)) !== canonicalRunRoot || auditPass === undefined) {
    fail(`Output must be ${requestedCategory}-language-audit-1.json through ${requestedCategory}-language-audit-${MAX_LANGUAGE_AUDIT_PASSES}.json directly under ${runRoot}.`);
  }
  validateStructureGate(canonicalRunRoot, date, requestedCategory);
  validateAuditSequence({
    runRoot: canonicalRunRoot,
    category: requestedCategory,
    date,
    pass: auditPass,
  });
  const paths = { [requestedCategory]: exactCategoryReport(staging, date, requestedCategory) };
  const issues = [];
  const categoryIssues = new Map();
  const policy = validateModelPolicy(parseJsonFile(resolve(root, "data/model-policy.json")));

  for (const slug of [requestedCategory]) {
    const original = parseJsonFile(paths[slug]);
    validateProductionReportStructure(original, { date, slug, policy, path: "report" });
    if (original.evaluationRun.runId !== expectedEvaluationRunId) {
      fail(`report.evaluationRun.runId must equal the host value ${expectedEvaluationRunId}.`);
    }
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
