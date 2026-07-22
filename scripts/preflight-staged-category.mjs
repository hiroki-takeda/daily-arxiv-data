#!/usr/bin/env node

import { lstatSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CATEGORIES,
  CURRENT_QUALITY_GATE_EFFECTIVE_DATE,
  MAX_STRUCTURE_AUDIT_PASSES,
  PRODUCTION_SCHEMA,
  RUBRIC_3_MARKER,
  SCORE_KEYS,
  comparePapers,
  findProductionScoreDistributionIssues,
  normalizeAuthorIdentity,
  parseJsonFile,
  productionExpectedReasoningEffort,
  productionFullTextEvaluationLimit,
  validateDate,
  validateModelPolicy,
  validateProductionReportStructure,
} from "./lib/pipeline.mjs";

const RUN_ID_PATTERN = /^run-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/u;
const ARXIV_ID_PATTERN = /^\d{4}\.\d{4,5}$/u;
const JST_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?\+09:00$/u;
const REPORT_KEYS = Object.freeze([
  "schemaVersion",
  "reportDate",
  "evaluationRun",
  "slug",
  "label",
  "totalNew",
  "crosslistsExcluded",
  "evaluatedCount",
  "fullTextEvaluatedCount",
  "papers",
  "audit",
]);
const EVALUATION_RUN_KEYS = Object.freeze([
  "modelId",
  "modelDisplayName",
  "reasoningEffort",
  "modelSelectionVerified",
  "runId",
]);
const PAPER_KEYS = Object.freeze([
  "rank",
  "arxivId",
  "arxivVersion",
  "submissionType",
  "url",
  "title",
  "titleJa",
  "authors",
  "primaryCategory",
  "paperType",
  "scores",
  "scoreReasons",
  "totalScore",
  "abstractLines",
  "curiosity",
  "concept",
  "conclusion",
  "assessment",
  "evaluationBasis",
  "fullTextEvaluated",
  "sourceUrls",
]);
const AUDIT_KEYS = Object.freeze([
  "listingUrl",
  "announcementDate",
  "selectionRule",
  "sourceCounts",
  "evaluationPolicy",
  "scoreRubric",
  "fullTextPolicy",
  "fullTextEvaluatedCount",
  "authorPolicy",
  "rankingTieBreak",
  "generatedAtJst",
]);
const SOURCE_COUNT_KEYS = Object.freeze([
  "newPrimary",
  "crosslistsExcluded",
  "titleAuthorAbstractEvaluated",
]);
const PAPER_TEXT_KEYS = Object.freeze([
  "title",
  "titleJa",
  "paperType",
  "curiosity",
  "concept",
  "conclusion",
  "assessment",
]);
const AUDIT_TEXT_KEYS = Object.freeze([
  "selectionRule",
  "evaluationPolicy",
  "scoreRubric",
  "fullTextPolicy",
  "authorPolicy",
  "rankingTieBreak",
]);

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return isObject(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function arxivAbsUrl(arxivId) {
  return `https://arxiv.org/abs/${arxivId}`;
}

function arxivVersionedAbsUrl(arxivId) {
  return `${arxivAbsUrl(arxivId)}v1`;
}

function arxivVersionedPdfUrl(arxivId) {
  return `https://arxiv.org/pdf/${arxivId}v1`;
}

function preflightOutputName(slug, pass) {
  return `${slug}-structure-audit-${pass}.json`;
}

function parseAuditPass(outputName, slug) {
  for (let pass = 1; pass <= MAX_STRUCTURE_AUDIT_PASSES; pass += 1) {
    if (outputName === preflightOutputName(slug, pass)) return pass;
  }
  return undefined;
}

function validatePriorPreflight(path, date, slug, pass) {
  const result = parseJsonFile(path);
  if (!isObject(result)) fail(`Structural audit pass ${pass} result must be an object.`);
  const keys = Object.keys(result).sort();
  if (keys.join("\0") !== ["date", "slug", "count", "issues"].sort().join("\0")) {
    fail(`Structural audit pass ${pass} result has an invalid shape.`);
  }
  if (result.date !== date || result.slug !== slug) {
    fail(`Structural audit pass ${pass} result must describe ${date} ${slug}.`);
  }
  if (!Number.isSafeInteger(result.count) || result.count < 0 || !Array.isArray(result.issues)) {
    fail(`Structural audit pass ${pass} result has an invalid issue count.`);
  }
  if (result.count !== result.issues.length) {
    fail(`Structural audit pass ${pass} result count does not match its issue array.`);
  }
  if (result.count === 0) {
    fail(`Structural audit pass ${pass} already reported issues=0; no later audit is allowed.`);
  }
}

function findStructuralIssues(report, { date, slug, evaluationRunId, policy }) {
  const issues = [];
  const issueByKey = new Map();
  const record = (path, kind, message, details = {}) => {
    const key = `${path}\0${kind}\0${message}`;
    const existing = issueByKey.get(key);
    if (existing !== undefined) {
      if (Array.isArray(existing.affectedPapers) && Array.isArray(details.affectedPapers)) {
        const affectedByIndex = new Map(existing.affectedPapers.map((paper) => [paper.index, paper]));
        for (const paper of details.affectedPapers) affectedByIndex.set(paper.index, paper);
        existing.affectedPapers = [...affectedByIndex.values()].sort((left, right) => left.index - right.index);
      }
      return;
    }
    const issue = { path, kind, message, ...details };
    issueByKey.set(key, issue);
    issues.push(issue);
  };
  const exactKeys = (value, required, path, allowed = required) => {
    if (!isObject(value)) {
      record(path, "type", "must be an object");
      return false;
    }
    const allowedSet = new Set(allowed);
    for (const key of required) {
      if (!hasOwn(value, key)) record(`${path}.${key}`, "missing_key", "required key is missing");
    }
    for (const key of Object.keys(value).sort()) {
      if (!allowedSet.has(key)) record(`${path}.${key}`, "extra_key", "unknown key is not allowed");
    }
    return true;
  };
  const requireNonEmptyString = (value, path) => {
    if (!nonEmptyString(value)) record(path, "value", "must be a non-empty string");
  };
  const requireNonNegativeInteger = (value, path) => {
    if (!nonNegativeInteger(value)) record(path, "value", "must be a non-negative integer");
  };
  const requireEqual = (value, expected, path) => {
    if (value !== expected) record(path, "value", `must equal ${JSON.stringify(expected)}`);
  };

  if (!exactKeys(report, REPORT_KEYS, "report")) return issues;

  if (hasOwn(report, "schemaVersion")) requireEqual(report.schemaVersion, PRODUCTION_SCHEMA, "report.schemaVersion");
  if (hasOwn(report, "reportDate")) requireEqual(report.reportDate, date, "report.reportDate");
  if (hasOwn(report, "slug")) requireEqual(report.slug, slug, "report.slug");
  if (hasOwn(report, "label")) requireNonEmptyString(report.label, "report.label");
  for (const key of ["totalNew", "crosslistsExcluded", "fullTextEvaluatedCount"]) {
    if (hasOwn(report, key)) requireNonNegativeInteger(report[key], `report.${key}`);
  }
  if (hasOwn(report, "evaluatedCount")) requireNonNegativeInteger(report.evaluatedCount, "report.evaluatedCount");
  if (hasOwn(report, "evaluatedCount") && hasOwn(report, "totalNew") && report.evaluatedCount !== report.totalNew) {
    record("report.evaluatedCount", "invariant", "must equal report.totalNew");
  }

  if (hasOwn(report, "evaluationRun") && exactKeys(report.evaluationRun, EVALUATION_RUN_KEYS, "report.evaluationRun")) {
    const expectedRun = {
      modelId: policy.requiredModelId,
      modelDisplayName: policy.requiredModelDisplayName,
      reasoningEffort: productionExpectedReasoningEffort({
        policy,
        date,
        runId: report.evaluationRun.runId,
      }),
      modelSelectionVerified: true,
      runId: evaluationRunId,
    };
    for (const [key, expected] of Object.entries(expectedRun)) {
      if (hasOwn(report.evaluationRun, key)) requireEqual(report.evaluationRun[key], expected, `report.evaluationRun.${key}`);
    }
  }

  const papers = report.papers;
  if (hasOwn(report, "papers") && !Array.isArray(papers)) {
    record("report.papers", "type", "must be an array");
  }
  if (Array.isArray(papers) && hasOwn(report, "totalNew") && papers.length !== report.totalNew) {
    record("report.papers", "invariant", `must contain report.totalNew papers (got ${papers.length})`);
  }

  if (Array.isArray(papers)) {
    const ids = new Map();
    const ranks = new Map();
    const sortable = [];
    const validScoreIndices = new Set();
    let canonicalRanked;
    for (const [index, paper] of papers.entries()) {
      const path = `report.papers[${index}]`;
      const requiredPaperKeys = [
        ...PAPER_KEYS,
        ...(paper?.fullTextEvaluated === true ? ["fullTextReviewStatus"] : []),
      ];
      const allowedPaperKeys = [...PAPER_KEYS, "fullTextReviewStatus"];
      if (!exactKeys(paper, requiredPaperKeys, path, allowedPaperKeys)) continue;

      if (hasOwn(paper, "rank") && (!Number.isInteger(paper.rank) || paper.rank < 1)) {
        record(`${path}.rank`, "value", "must be a positive integer");
      } else if (Number.isInteger(paper.rank)) {
        if (paper.rank > papers.length) {
          record(`${path}.rank`, "value", `must be at most the paper count ${papers.length}`);
        }
        const previousRankIndex = ranks.get(paper.rank);
        if (previousRankIndex !== undefined) {
          record(`${path}.rank`, "invariant", `duplicates report.papers[${previousRankIndex}].rank`);
        } else {
          ranks.set(paper.rank, index);
        }
      }
      if (hasOwn(paper, "arxivId")) {
        if (typeof paper.arxivId !== "string" || !ARXIV_ID_PATTERN.test(paper.arxivId)) {
          record(`${path}.arxivId`, "value", "must be an unversioned modern arXiv ID");
        } else {
          const previousIndex = ids.get(paper.arxivId);
          if (previousIndex !== undefined) {
            record(`${path}.arxivId`, "invariant", `duplicates report.papers[${previousIndex}].arxivId`);
          } else {
            ids.set(paper.arxivId, index);
          }
          if (hasOwn(paper, "url")) {
            requireEqual(paper.url, arxivAbsUrl(paper.arxivId), `${path}.url`);
          }
        }
      }
      if (hasOwn(paper, "arxivVersion")) requireEqual(paper.arxivVersion, "v1", `${path}.arxivVersion`);
      if (hasOwn(paper, "submissionType")) requireEqual(paper.submissionType, "new", `${path}.submissionType`);
      if (hasOwn(paper, "primaryCategory")) requireEqual(paper.primaryCategory, slug, `${path}.primaryCategory`);
      for (const key of PAPER_TEXT_KEYS) {
        if (hasOwn(paper, key)) requireNonEmptyString(paper[key], `${path}.${key}`);
      }

      if (hasOwn(paper, "authors")) {
        if (!Array.isArray(paper.authors) || paper.authors.length === 0) {
          record(`${path}.authors`, "value", "must be a non-empty array");
        } else {
          const seenAuthors = new Set();
          paper.authors.forEach((author, authorIndex) => {
            if (!nonEmptyString(author)) {
              record(`${path}.authors[${authorIndex}]`, "value", "must be a non-empty string");
              return;
            }
            const identity = normalizeAuthorIdentity(author);
            if (seenAuthors.has(identity)) {
              record(`${path}.authors`, "invariant", `contains duplicate author ${author}`);
            }
            seenAuthors.add(identity);
          });
        }
      }

      let validScores = false;
      let totalConsistent = false;
      if (hasOwn(paper, "scores") && exactKeys(paper.scores, SCORE_KEYS, `${path}.scores`)) {
        validScores = true;
        for (const key of SCORE_KEYS) {
          if (!hasOwn(paper.scores, key)) {
            validScores = false;
            continue;
          }
          const score = paper.scores[key];
          if (!Number.isInteger(score) || score < 0 || score > 25) {
            record(`${path}.scores.${key}`, "value", "must be an integer from 0 through 25");
            validScores = false;
          }
        }
      }
      if (hasOwn(paper, "scoreReasons") && exactKeys(paper.scoreReasons, SCORE_KEYS, `${path}.scoreReasons`)) {
        for (const key of SCORE_KEYS) {
          if (hasOwn(paper.scoreReasons, key)) requireNonEmptyString(paper.scoreReasons[key], `${path}.scoreReasons.${key}`);
        }
      }
      if (hasOwn(paper, "totalScore")) {
        const validTotal = Number.isInteger(paper.totalScore) && paper.totalScore >= 0 && paper.totalScore <= 100;
        if (!validTotal) {
          record(`${path}.totalScore`, "value", "must be an integer from 0 through 100");
        }
        if (validScores) {
          const expectedTotal = SCORE_KEYS.reduce((sum, key) => sum + paper.scores[key], 0);
          if (paper.totalScore !== expectedTotal) {
            record(`${path}.totalScore`, "invariant", `must equal the four-score sum ${expectedTotal}`);
          } else if (validTotal) {
            totalConsistent = true;
          }
        }
      }
      if (validScores) validScoreIndices.add(index);

      if (hasOwn(paper, "abstractLines")) {
        if (!Array.isArray(paper.abstractLines) || paper.abstractLines.length !== 3) {
          record(`${path}.abstractLines`, "value", "must contain exactly three lines");
        } else {
          paper.abstractLines.forEach((line, lineIndex) => {
            if (!nonEmptyString(line)) record(`${path}.abstractLines[${lineIndex}]`, "value", "must be a non-empty string");
          });
        }
      }

      if (hasOwn(paper, "fullTextEvaluated") && typeof paper.fullTextEvaluated !== "boolean") {
        record(`${path}.fullTextEvaluated`, "type", "must be a boolean");
      }
      if (hasOwn(paper, "sourceUrls") && !Array.isArray(paper.sourceUrls)) {
        record(`${path}.sourceUrls`, "type", "must be an array");
      }

      if (
        typeof paper.arxivId === "string"
        && ARXIV_ID_PATTERN.test(paper.arxivId)
        && validScores
        && totalConsistent
      ) {
        sortable.push({ paper, index });
      }
    }

    if (sortable.length === papers.length) {
      canonicalRanked = [...sortable].sort((left, right) => comparePapers(left.paper, right.paper));
      canonicalRanked.forEach(({ paper, index }, rankIndex) => {
        if (paper.rank !== rankIndex + 1) {
          record(`report.papers[${index}].rank`, "invariant", `must be deterministic rank ${rankIndex + 1}`);
        }
      });
      for (const distributionIssue of date >= CURRENT_QUALITY_GATE_EFFECTIVE_DATE
        ? findProductionScoreDistributionIssues(report)
        : []) {
        record(
          `report.papers.${distributionIssue.path}`,
          "distribution",
          distributionIssue.message,
          {
            affectedPapers: distributionIssue.paperIndices.map((paperIndex) => ({
              index: paperIndex,
              rank: papers[paperIndex].rank,
              arxivId: papers[paperIndex].arxivId,
            })),
          },
        );
      }
    }

    const fullTextCount = papers.filter((paper) => paper?.fullTextEvaluated === true).length;
    if (hasOwn(report, "fullTextEvaluatedCount") && report.fullTextEvaluatedCount !== fullTextCount) {
      record("report.fullTextEvaluatedCount", "invariant", `must equal the ${fullTextCount} papers marked fullTextEvaluated=true`);
    }
    const topCount = Math.min(10, papers.length);
    const fullTextLimit = nonNegativeInteger(report.totalNew)
      ? productionFullTextEvaluationLimit({
        policy,
        date,
        slug,
        runId: report.evaluationRun?.runId,
        totalNew: report.totalNew,
      })
      : undefined;
    if (fullTextLimit !== undefined && fullTextCount > fullTextLimit) {
      record(
        "report.fullTextEvaluatedCount",
        "resource_budget",
        `must not exceed the canonical resource-budget limit ${fullTextLimit}`,
      );
    }
    let fullTextCountRecomputeRequired = false;
    const canonicalTopIndices = new Set((canonicalRanked ?? []).slice(0, topCount).map(({ index }) => index));
    const canonicalRankByIndex = new Map(
      (canonicalRanked ?? []).map(({ index }, rankIndex) => [index, rankIndex + 1]),
    );
    if (fullTextLimit !== undefined && canonicalRanked !== undefined) {
      const projectedFullTextIndices = new Set([
        ...papers.map((paper, index) => paper?.fullTextEvaluated === true ? index : undefined)
          .filter((index) => index !== undefined),
        ...canonicalTopIndices,
      ]);
      if (projectedFullTextIndices.size > fullTextLimit) {
        record(
          "report.fullTextEvaluatedCount",
          "dependent_bundle",
          `canonical top-ten repair would mark ${projectedFullTextIndices.size} papers, above the resource-budget limit ${fullTextLimit}; preserve truthful provenance and re-evaluate or stop`,
          {
            affectedPapers: [...projectedFullTextIndices].sort((left, right) => left - right).map((paperIndex) => ({
              index: paperIndex,
              rank: papers[paperIndex].rank,
              arxivId: papers[paperIndex].arxivId,
            })),
          },
        );
      }
    }
    for (const [index, paper] of papers.entries()) {
      const path = `report.papers[${index}]`;
      const canonicalTop = canonicalTopIndices.has(index);
      const targetFullText = canonicalTop ? true : paper?.fullTextEvaluated;
      const bundleKind = canonicalTop ? "dependent_bundle" : "invariant";
      if (canonicalTop && paper?.fullTextEvaluated !== true) {
        fullTextCountRecomputeRequired = true;
        record(`${path}.fullTextEvaluated`, bundleKind, `canonical rank ${canonicalRankByIndex.get(index)} must set the complete full-text review tuple`);
      }
      if (targetFullText !== true && targetFullText !== false) {
        fullTextCountRecomputeRequired = true;
        if (!canonicalTop) {
          record(
            `${path}.fullTextEvaluated`,
            "dependent_bundle",
            "must choose and apply one complete legal tuple: full-text true with status and PDF URL, or false without status and with only the abstract URL",
          );
        }
        continue;
      }
      const expectedBasis = targetFullText ? "full_text_major_sections" : "title_authors_abstract";
      if (paper.evaluationBasis !== expectedBasis) {
        record(
          `${path}.evaluationBasis`,
          bundleKind,
          canonicalTop
            ? "canonical top-ten paper must use full_text_major_sections"
            : `must equal ${expectedBasis} for the selected full-text state`,
        );
      }
      if (targetFullText && !nonEmptyString(paper.fullTextReviewStatus)) {
        record(
          `${path}.fullTextReviewStatus`,
          bundleKind,
          canonicalTop
            ? "canonical top-ten paper must contain a non-empty full-text review status"
            : "must contain a non-empty full-text review status after full-text review",
        );
      } else if (!targetFullText && hasOwn(paper, "fullTextReviewStatus")) {
        record(`${path}.fullTextReviewStatus`, "extra_key", "must be omitted when fullTextEvaluated is false");
      }
      if (!targetFullText && validScoreIndices.has(index)) {
        for (const key of SCORE_KEYS) {
          if (paper.scores[key] >= 24) {
            record(`${path}.scores.${key}`, "invariant", "must be below 24 without full-text review");
          }
        }
        if (paper.scores.technicalStrength > 17) {
          record(`${path}.scores.technicalStrength`, "invariant", "must be at most 17 without full-text review");
        }
      }
      if (typeof paper.arxivId === "string" && ARXIV_ID_PATTERN.test(paper.arxivId)) {
        const expectedUrls = [
          arxivVersionedAbsUrl(paper.arxivId),
          ...(targetFullText ? [arxivVersionedPdfUrl(paper.arxivId)] : []),
        ];
        if (
          !Array.isArray(paper.sourceUrls)
          || paper.sourceUrls.length !== expectedUrls.length
          || expectedUrls.some((url) => !paper.sourceUrls.includes(url))
        ) {
          record(
            `${path}.sourceUrls`,
            bundleKind,
            canonicalTop
              ? `canonical top-ten paper must contain exactly ${expectedUrls.join(" and ")}`
              : `must contain exactly ${expectedUrls.join(" and ")}`,
          );
        }
      }
    }
    if (fullTextCountRecomputeRequired) {
      record("report.fullTextEvaluatedCount", "dependent_bundle", "must be recomputed after repairing every dependent full-text tuple");
      record("report.audit.fullTextEvaluatedCount", "dependent_bundle", "must match the recomputed report full-text count");
    }
  }

  if (hasOwn(report, "audit") && exactKeys(report.audit, AUDIT_KEYS, "report.audit")) {
    const audit = report.audit;
    if (hasOwn(audit, "listingUrl")) {
      const allowed = new Set([
        `https://arxiv.org/list/${slug}/new`,
        `https://arxiv.org/list/${slug}/pastweek`,
      ]);
      if (!allowed.has(audit.listingUrl)) record("report.audit.listingUrl", "value", `must be an official ${slug} listing URL`);
    }
    if (hasOwn(audit, "announcementDate")) requireEqual(audit.announcementDate, date, "report.audit.announcementDate");
    for (const key of AUDIT_TEXT_KEYS) {
      if (hasOwn(audit, key)) requireNonEmptyString(audit[key], `report.audit.${key}`);
    }
    if (hasOwn(audit, "scoreRubric") && nonEmptyString(audit.scoreRubric) && !audit.scoreRubric.startsWith(RUBRIC_3_MARKER)) {
      record("report.audit.scoreRubric", "value", `must start with ${JSON.stringify(RUBRIC_3_MARKER)}`);
    }
    if (hasOwn(audit, "generatedAtJst")) {
      if (
        typeof audit.generatedAtJst !== "string"
        || !JST_TIMESTAMP_PATTERN.test(audit.generatedAtJst)
        || Number.isNaN(Date.parse(audit.generatedAtJst))
      ) {
        record("report.audit.generatedAtJst", "value", "must be a valid ISO timestamp with the +09:00 offset");
      }
    }
    if (hasOwn(audit, "fullTextEvaluatedCount") && hasOwn(report, "fullTextEvaluatedCount")
      && audit.fullTextEvaluatedCount !== report.fullTextEvaluatedCount) {
      record("report.audit.fullTextEvaluatedCount", "invariant", "must equal report.fullTextEvaluatedCount");
    }
    if (hasOwn(audit, "fullTextEvaluatedCount")) {
      requireNonNegativeInteger(audit.fullTextEvaluatedCount, "report.audit.fullTextEvaluatedCount");
    }
    if (hasOwn(audit, "sourceCounts") && exactKeys(audit.sourceCounts, SOURCE_COUNT_KEYS, "report.audit.sourceCounts")) {
      for (const key of SOURCE_COUNT_KEYS) {
        if (hasOwn(audit.sourceCounts, key)) {
          requireNonNegativeInteger(audit.sourceCounts[key], `report.audit.sourceCounts.${key}`);
        }
      }
      if (hasOwn(audit.sourceCounts, "newPrimary") && hasOwn(report, "totalNew")) {
        requireEqual(audit.sourceCounts.newPrimary, report.totalNew, "report.audit.sourceCounts.newPrimary");
      }
      if (hasOwn(audit.sourceCounts, "crosslistsExcluded") && hasOwn(report, "crosslistsExcluded")) {
        requireEqual(audit.sourceCounts.crosslistsExcluded, report.crosslistsExcluded, "report.audit.sourceCounts.crosslistsExcluded");
      }
      if (hasOwn(audit.sourceCounts, "titleAuthorAbstractEvaluated") && hasOwn(report, "totalNew")) {
        requireEqual(audit.sourceCounts.titleAuthorAbstractEvaluated, report.totalNew, "report.audit.sourceCounts.titleAuthorAbstractEvaluated");
      }
    }
  }

  if (issues.length === 0) {
    try {
      validateProductionReportStructure(report, { date, slug, policy, path: "report" });
    } catch (error) {
      const message = String(error?.message ?? error);
      const separator = message.indexOf(":");
      const path = separator > 0 ? message.slice(0, separator) : "report";
      record(path, "canonical_validation", message);
    }
  }

  return issues.sort((left, right) => (
    left.path.localeCompare(right.path)
    || left.kind.localeCompare(right.kind)
    || left.message.localeCompare(right.message)
  ));
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

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

try {
  if (process.argv.length !== 7) {
    fail("Usage: node scripts/preflight-staged-category.mjs <YYYY-MM-DD> <category> <fixed-staging-directory> <evaluation-run-id> <fixed-output-file>");
  }
  const date = validateDate(process.argv[2]);
  const slug = process.argv[3];
  if (!CATEGORIES.includes(slug)) fail(`Unsupported category ${slug}.`);
  const staging = resolve(process.argv[4]);
  const evaluationRunId = process.argv[5];
  if (!RUN_ID_PATTERN.test(evaluationRunId)) fail("Evaluation runId is invalid.");
  const output = resolve(process.argv[6]);
  const runRoot = resolve(process.env.TMPDIR ?? "");
  const stagingEntry = lstatSync(staging);
  if (stagingEntry.isSymbolicLink() || !stagingEntry.isDirectory()) fail("Staging directory must be a real directory.");
  const canonicalRunRoot = realpathSync(runRoot);
  const expectedStaging = resolve(canonicalRunRoot, "staging", slug);
  if (realpathSync(staging) !== expectedStaging) {
    fail(`Staging directory must be the fixed category path ${expectedStaging}.`);
  }
  const outputName = basename(output);
  const auditPass = parseAuditPass(outputName, slug);
  if (realpathSync(dirname(output)) !== canonicalRunRoot || auditPass === undefined) {
    fail(`Output must be ${slug}-structure-audit-1.json through ${slug}-structure-audit-${MAX_STRUCTURE_AUDIT_PASSES}.json directly under ${runRoot}.`);
  }
  for (let priorPass = 1; priorPass < auditPass; priorPass += 1) {
    validatePriorPreflight(
      resolve(canonicalRunRoot, preflightOutputName(slug, priorPass)),
      date,
      slug,
      priorPass,
    );
  }
  const reportPath = exactCategoryReport(staging, date, slug);
  const policy = validateModelPolicy(parseJsonFile(resolve(root, "data/model-policy.json")));
  const report = parseJsonFile(reportPath);
  const issues = findStructuralIssues(report, { date, slug, evaluationRunId, policy });
  writeFileSync(output, `${JSON.stringify({ date, slug, count: issues.length, issues }, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  console.log(`STAGED_CATEGORY_STRUCTURE_PREFLIGHT: ${date}; ${slug}; pass=${auditPass}; issues=${issues.length}; output=${output}`);
} catch (error) {
  console.error(`ACTION_REQUIRED: STAGED_CATEGORY_STRUCTURE_PREFLIGHT_FAILED: ${error.stack ?? error.message}`);
  process.exitCode = 1;
}
