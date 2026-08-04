#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  CATEGORIES,
  PRODUCTION_SCHEMA,
  SCORE_KEYS,
  parseJsonFile,
  pathIsWithin,
  restoreFileSnapshot,
  serializeJson,
  snapshotFiles,
  transactionalWriteFiles,
  validateDate,
  validateProductionPaperProse,
  validateProductionReportSet,
  validateProductionReportProseDiversity,
  validatePublicEdition,
  validateRepository,
} from "./lib/pipeline.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const PUBLISHED_PROSE_CORRECTION_CONFIRMATION = "--confirm-published-prose-only";
const SIMPLE_PROSE_FIELDS = Object.freeze([
  "titleJa",
  "curiosity",
  "concept",
  "conclusion",
  "assessment",
  "fullTextReviewStatus",
]);

function fail(message) {
  throw new Error(message);
}

function securePathIdentity(path, label, { directory = false, repositoryRoot } = {}) {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || (directory ? !entry.isDirectory() : !entry.isFile())) {
    fail(`${label} must be a real ${directory ? "directory" : "regular file"}.`);
  }
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && entry.uid !== currentUid) {
    fail(`${label} must be owned by uid ${currentUid}.`);
  }
  if ((entry.mode & 0o022) !== 0) fail(`${label} must not be group- or world-writable.`);
  if (!directory && entry.nlink !== 1) fail(`${label} must have exactly one hard link.`);
  const realPath = realpathSync(path);
  if (repositoryRoot !== undefined && !pathIsWithin(repositoryRoot, realPath)) {
    fail(`${label} must remain inside the fixed repository root.`);
  }
  return {
    path,
    realPath,
    dev: entry.dev,
    ino: entry.ino,
    uid: entry.uid,
    mode: entry.mode,
    nlink: entry.nlink,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    directory,
    label,
  };
}

function assertSecurePathUnchanged(expected) {
  const actual = securePathIdentity(expected.path, expected.label, {
    directory: expected.directory,
  });
  const keys = ["realPath", "dev", "ino", "uid", "mode", "nlink"];
  if (!expected.directory) keys.push("size", "mtimeMs");
  for (const key of keys) {
    if (actual[key] !== expected[key]) fail(`${expected.label} changed after validation (${key}).`);
  }
}

function assertSnapshotUnchanged(snapshot, label) {
  for (const [path, previous] of snapshot) {
    if (previous === null || !existsSync(path) || !readFileSync(path).equals(previous.content)) {
      fail(`${label} changed after validation: ${path}`);
    }
  }
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function firstDifference(left, right, path = "report") {
  if (isDeepStrictEqual(left, right)) return undefined;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return path;
    if (left.length !== right.length) return `${path}.length`;
    for (let index = 0; index < left.length; index += 1) {
      const difference = firstDifference(left[index], right[index], `${path}[${index}]`);
      if (difference !== undefined) return difference;
    }
    return path;
  }
  if (left !== null && right !== null && typeof left === "object" && typeof right === "object") {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) {
      if (!hasOwn(left, key) || !hasOwn(right, key)) return `${path}.${key}`;
      const difference = firstDifference(left[key], right[key], `${path}.${key}`);
      if (difference !== undefined) return difference;
    }
    return path;
  }
  return path;
}

function candidateWithAllowedValues(original, candidate) {
  const expected = structuredClone(original);
  if (!Array.isArray(candidate?.papers) || candidate.papers.length !== expected.papers.length) return expected;
  for (const [index, paper] of expected.papers.entries()) {
    const candidatePaper = candidate.papers[index];
    if (candidatePaper === null || typeof candidatePaper !== "object" || Array.isArray(candidatePaper)) continue;
    for (const field of SIMPLE_PROSE_FIELDS) {
      if (hasOwn(candidatePaper, field)) paper[field] = structuredClone(candidatePaper[field]);
      else if (field === "fullTextReviewStatus") delete paper[field];
    }
    if (candidatePaper.scoreReasons !== null && typeof candidatePaper.scoreReasons === "object") {
      for (const key of SCORE_KEYS) {
        if (hasOwn(candidatePaper.scoreReasons, key)) {
          paper.scoreReasons[key] = structuredClone(candidatePaper.scoreReasons[key]);
        }
      }
    }
    if (Array.isArray(candidatePaper.abstractLines)) {
      paper.abstractLines = structuredClone(candidatePaper.abstractLines);
    }
  }
  return expected;
}

function assertStrictProseOnly(original, candidate) {
  const expected = candidateWithAllowedValues(original, candidate);
  const unauthorizedPath = firstDifference(expected, candidate);
  if (unauthorizedPath !== undefined) {
    fail(`${unauthorizedPath} is not in the published prose-correction allowlist; paperType and all scoring, identity, evidence, audit, and run fields must remain fixed.`);
  }
  if (isDeepStrictEqual(original, candidate)) fail("The corrected report does not change any allowlisted prose value.");
}

function projectCorrectedCategory(category, report) {
  const projected = structuredClone(category);
  const byArxivId = new Map(report.papers.map((paper) => [paper.arxivId, paper]));
  const publicPapers = [...projected.topPapers, ...projected.otherPapers];
  if (publicPapers.length !== report.papers.length) {
    fail("The dated public category and source report have different paper counts.");
  }
  for (const publicPaper of publicPapers) {
    const source = byArxivId.get(publicPaper.arxivId);
    if (source === undefined) fail(`The dated public category contains unknown paper ${publicPaper.arxivId}.`);
    for (const field of SIMPLE_PROSE_FIELDS) {
      if (hasOwn(publicPaper, field)) {
        if (!hasOwn(source, field)) fail(`Corrected report is missing ${field} for ${source.arxivId}.`);
        publicPaper[field] = structuredClone(source[field]);
      }
    }
    if (hasOwn(publicPaper, "abstractLines")) publicPaper.abstractLines = structuredClone(source.abstractLines);
    if (hasOwn(publicPaper, "scoreReasons")) publicPaper.scoreReasons = structuredClone(source.scoreReasons);
  }
  return projected;
}

function assertProtectedFilesUnchanged(snapshot) {
  for (const [path, content] of snapshot) {
    if (!existsSync(path) || !readFileSync(path).equals(content)) {
      fail(`${path} changed concurrently; current.json and index.json are never written by this command.`);
    }
  }
}

export function applyPublishedProseCorrection({
  root = repositoryRoot,
  date,
  category,
  correctedReportPath,
  confirmation,
  transactionOptions,
} = {}) {
  if (confirmation !== PUBLISHED_PROSE_CORRECTION_CONFIRMATION) {
    fail(`Published prose correction requires the explicit ${PUBLISHED_PROSE_CORRECTION_CONFIRMATION} confirmation.`);
  }
  const absoluteRoot = resolve(root);
  validateDate(date);
  if (!CATEGORIES.includes(category)) fail(`Unsupported category ${JSON.stringify(category)}.`);
  const rootIdentity = securePathIdentity(absoluteRoot, "Repository root", { directory: true });
  const canonicalRoot = rootIdentity.realPath;
  const directoryIdentities = [
    rootIdentity,
    securePathIdentity(resolve(canonicalRoot, "data"), "data directory", { directory: true, repositoryRoot: canonicalRoot }),
    securePathIdentity(resolve(canonicalRoot, "data/reports"), "reports directory", { directory: true, repositoryRoot: canonicalRoot }),
    securePathIdentity(resolve(canonicalRoot, "public"), "public directory", { directory: true, repositoryRoot: canonicalRoot }),
    securePathIdentity(resolve(canonicalRoot, "public/data"), "public data directory", { directory: true, repositoryRoot: canonicalRoot }),
  ];
  const proseCorrectionTarget = { date, category };
  const baseline = validateRepository(canonicalRoot, { proseCorrectionTarget });
  if (baseline.publicArchive.index.latestDate === date) {
    fail(`Published prose correction is historical-only: ${date} is the latest edition. current.json must remain unchanged.`);
  }
  if (!baseline.publicArchive.editions.has(date)) fail(`No published edition exists for ${date}.`);
  const targetEdition = baseline.publicArchive.editions.get(date);
  if (targetEdition.schemaVersion !== PRODUCTION_SCHEMA) {
    fail(`Only schema ${PRODUCTION_SCHEMA} historical editions support prose-only correction.`);
  }

  const reportPath = resolve(canonicalRoot, `data/reports/${date}-${category}.json`);
  const editionPath = resolve(canonicalRoot, `public/data/${date}.json`);
  const currentPath = resolve(canonicalRoot, "public/data/current.json");
  const indexPath = resolve(canonicalRoot, "public/data/index.json");
  const correctedInputPath = resolve(correctedReportPath);
  const protectedFileIdentities = [
    securePathIdentity(currentPath, "current.json", { repositoryRoot: canonicalRoot }),
    securePathIdentity(indexPath, "index.json", { repositoryRoot: canonicalRoot }),
  ];
  const targetFileIdentities = [
    securePathIdentity(reportPath, "Target report", { repositoryRoot: canonicalRoot }),
    securePathIdentity(editionPath, "Target edition", { repositoryRoot: canonicalRoot }),
  ];
  const correctedInputIdentity = securePathIdentity(correctedInputPath, "Corrected report input");
  if (pathIsWithin(canonicalRoot, correctedInputIdentity.realPath)) {
    fail("Corrected report input must be a separate file outside the repository.");
  }
  const correctedInputBytes = readFileSync(correctedInputPath);
  const originalReport = parseJsonFile(reportPath);
  const correctedReport = parseJsonFile(correctedInputPath);
  assertSecurePathUnchanged(correctedInputIdentity);
  if (!readFileSync(correctedInputPath).equals(correctedInputBytes)) {
    fail("Corrected report input changed while it was being parsed.");
  }
  assertStrictProseOnly(originalReport, correctedReport);
  correctedReport.papers.forEach((paper, index) => {
    validateProductionPaperProse(paper, `data/reports/${date}-${category}.json.papers[${index}]`);
  });
  validateProductionReportProseDiversity(
    correctedReport,
    `data/reports/${date}-${category}.json`,
    { enforceLatestProseGates: true },
  );

  const reports = Object.fromEntries(CATEGORIES.map((slug) => [
    slug,
    slug === category
      ? correctedReport
      : parseJsonFile(resolve(canonicalRoot, `data/reports/${date}-${slug}.json`)),
  ]));
  validateProductionReportSet(reports, {
    date,
    policy: baseline.policy,
    expectedRunId: originalReport.evaluationRun.runId,
    paths: Object.fromEntries(CATEGORIES.map((slug) => [slug, `data/reports/${date}-${slug}.json`])),
  });

  const correctedEdition = structuredClone(targetEdition);
  correctedEdition.categories[category] = projectCorrectedCategory(
    targetEdition.categories[category],
    correctedReport,
  );
  validatePublicEdition(correctedEdition, {
    expectedDate: date,
    policy: baseline.policy,
    path: `public/data/${date}.json`,
  });

  const protectedSnapshot = new Map([
    [currentPath, readFileSync(currentPath)],
    [indexPath, readFileSync(indexPath)],
  ]);
  const targetSnapshot = snapshotFiles([reportPath, editionPath]);
  for (const identity of [...directoryIdentities, ...protectedFileIdentities, ...targetFileIdentities, correctedInputIdentity]) {
    assertSecurePathUnchanged(identity);
  }
  assertSnapshotUnchanged(targetSnapshot, "Correction target");
  if (!readFileSync(correctedInputPath).equals(correctedInputBytes)) {
    fail("Corrected report input changed before publication.");
  }
  assertProtectedFilesUnchanged(protectedSnapshot);
  const result = transactionalWriteFiles([
    { path: reportPath, content: serializeJson(correctedReport) },
    { path: editionPath, content: serializeJson(correctedEdition) },
  ], transactionOptions);
  try {
    assertProtectedFilesUnchanged(protectedSnapshot);
    for (const identity of [...directoryIdentities, ...protectedFileIdentities, correctedInputIdentity]) {
      assertSecurePathUnchanged(identity);
    }
    validateRepository(canonicalRoot);
    assertProtectedFilesUnchanged(protectedSnapshot);
  } catch (error) {
    if (result.changed) {
      try {
        restoreFileSnapshot(targetSnapshot);
      } catch (rollbackError) {
        error.message += `; prose-correction rollback failed: ${rollbackError.message}`;
      }
    }
    throw error;
  }
  return {
    date,
    category,
    changed: result.changed,
    paths: result.paths,
  };
}

function runCli() {
  if (process.argv.length !== 6 || process.argv[5] !== PUBLISHED_PROSE_CORRECTION_CONFIRMATION) {
    fail(`Usage: node scripts/apply-published-prose-correction.mjs <YYYY-MM-DD> <category> <corrected-report.json> ${PUBLISHED_PROSE_CORRECTION_CONFIRMATION}`);
  }
  const result = applyPublishedProseCorrection({
    date: process.argv[2],
    category: process.argv[3],
    correctedReportPath: process.argv[4],
    confirmation: process.argv[5],
  });
  console.log(`PUBLISHED_PROSE_CORRECTION_PREPARED: ${result.date}; category=${result.category}; files=${result.paths.length}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    console.error(`ACTION_REQUIRED: PUBLISHED_PROSE_CORRECTION_FAILED: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  }
}
