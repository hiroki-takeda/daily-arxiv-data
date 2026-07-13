import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";

export const PRODUCTION_SCHEMA = "1.3";
export const LEGACY_SCHEMA = "1.2";
export const CATEGORIES = Object.freeze(["hep-th", "gr-qc", "quant-ph"]);
export const SCORE_KEYS = Object.freeze([
  "broadImpact",
  "categoryImpact",
  "originality",
  "technicalStrength",
]);

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const JST_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/;
const ARXIV_ID_PATTERN = /^\d{4}\.\d{4,5}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const MAX_JSON_BYTES = 10 * 1024 * 1024;
const TEXT_FIELDS = ["title", "titleJa", "paperType", "curiosity", "concept", "conclusion", "assessment"];
const EXPECTED_POLICY = Object.freeze({
  schemaVersion: "1.1",
  requiredModelId: "gpt-5.6-sol",
  requiredModelDisplayName: "GPT-5.6-Sol",
  requiredReasoningEffort: "ultra",
  requireExplicitModelSelection: true,
  qualificationStatus: "not_benchmarked",
  qualificationRequiredForPublication: false,
});

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

function fail(path, message) {
  throw new ValidationError(`${path}: ${message}`);
}

function assertObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  return value;
}

function assertNonEmptyString(value, path) {
  if (typeof value !== "string" || value.trim() === "") fail(path, "must be a non-empty string");
}

function assertNonNegativeInteger(value, path) {
  if (!Number.isInteger(value) || value < 0) fail(path, "must be a non-negative integer");
}

function assertExactKeys(value, keys, path) {
  const actual = Object.keys(assertObject(value, path)).sort();
  const expected = [...keys].sort();
  if (actual.join("\0") !== expected.join("\0")) {
    fail(path, `must contain exactly: ${expected.join(", ")}`);
  }
}

export function validateDate(value, path = "date") {
  if (typeof value !== "string") fail(path, "must be a YYYY-MM-DD string");
  const match = DATE_PATTERN.exec(value);
  if (!match) fail(path, "must use YYYY-MM-DD");
  const [, year, month, day] = match;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() + 1 !== Number(month) ||
    parsed.getUTCDate() !== Number(day)
  ) {
    fail(path, "is not a real calendar date");
  }
  return value;
}

export function validateJstTimestamp(value, path) {
  if (typeof value !== "string" || !JST_TIMESTAMP_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    fail(path, "must be an ISO timestamp with seconds and the +09:00 offset");
  }
  return value;
}

export function parseJsonFile(path) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    fail(path, `cannot be inspected (${error.message})`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) fail(path, "must be a regular JSON file");
  if (metadata.size > MAX_JSON_BYTES) fail(path, `exceeds the ${MAX_JSON_BYTES}-byte JSON safety limit`);
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    fail(path, `cannot be read (${error.message})`);
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    fail(path, `invalid JSON (${error.message})`);
  }
}

export function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function validateModelPolicy(policy, path = "data/model-policy.json") {
  assertObject(policy, path);
  assertExactKeys(policy, [
    ...Object.keys(EXPECTED_POLICY),
    "verificationScope",
    "publicationRule",
    "lastReviewed",
  ], path);
  for (const [key, expected] of Object.entries(EXPECTED_POLICY)) {
    if (policy[key] !== expected) fail(`${path}.${key}`, `must be ${JSON.stringify(expected)}`);
  }
  assertNonEmptyString(policy.verificationScope, `${path}.verificationScope`);
  assertNonEmptyString(policy.publicationRule, `${path}.publicationRule`);
  validateDate(policy.lastReviewed, `${path}.lastReviewed`);
  if (/\bqualified\b/i.test(String(policy.qualificationStatus))) {
    fail(`${path}.qualificationStatus`, "must not claim benchmark qualification");
  }
  return policy;
}

export function validateEvaluationRun(run, policy, path = "evaluationRun") {
  assertObject(run, path);
  assertExactKeys(run, [
    "modelId",
    "modelDisplayName",
    "reasoningEffort",
    "modelSelectionVerified",
    "runId",
  ], path);
  if (run.modelId !== policy.requiredModelId) fail(`${path}.modelId`, `must be ${policy.requiredModelId}`);
  if (run.modelDisplayName !== policy.requiredModelDisplayName) {
    fail(`${path}.modelDisplayName`, `must be ${policy.requiredModelDisplayName}`);
  }
  if (run.reasoningEffort !== policy.requiredReasoningEffort) {
    fail(`${path}.reasoningEffort`, `must be ${policy.requiredReasoningEffort}`);
  }
  if (run.modelSelectionVerified !== true) fail(`${path}.modelSelectionVerified`, "must be true");
  if (typeof run.runId !== "string" || !RUN_ID_PATTERN.test(run.runId)) {
    fail(`${path}.runId`, "must be an 8-128 character stable identifier");
  }
  return run;
}

function evaluationRunFingerprint(run) {
  return JSON.stringify([
    run.modelId,
    run.modelDisplayName,
    run.reasoningEffort,
    run.modelSelectionVerified,
    run.runId,
  ]);
}

export function validateDistinguishedRegistry(registry, path = "data/distinguished-authors.json") {
  assertObject(registry, path);
  if (registry.schemaVersion !== "1.0") fail(`${path}.schemaVersion`, "must be 1.0");
  if (!Array.isArray(registry.authors)) fail(`${path}.authors`, "must be an array");
  const identities = new Set();
  for (const [index, entry] of registry.authors.entries()) {
    const entryPath = `${path}.authors[${index}]`;
    assertObject(entry, entryPath);
    assertNonEmptyString(entry.canonicalName, `${entryPath}.canonicalName`);
    if (!Array.isArray(entry.aliases) || entry.aliases.some((alias) => typeof alias !== "string" || alias.trim() === "")) {
      fail(`${entryPath}.aliases`, "must be an array of non-empty strings");
    }
    for (const name of [entry.canonicalName, ...entry.aliases]) {
      const key = normalize(name);
      if (identities.has(key)) fail(entryPath, `duplicate registry identity ${name}`);
      identities.add(key);
    }
    if (!Array.isArray(entry.fieldTags) || entry.fieldTags.length === 0 || entry.fieldTags.some((tag) => !CATEGORIES.includes(tag))) {
      fail(`${entryPath}.fieldTags`, `must contain only ${CATEGORIES.join(", ")}`);
    }
    assertNonEmptyString(entry.distinction, `${entryPath}.distinction`);
    assertNonEmptyString(entry.identityEvidence, `${entryPath}.identityEvidence`);
    if (!Array.isArray(entry.officialUrls) || entry.officialUrls.length === 0 || entry.officialUrls.some((url) => !/^https:\/\//.test(url))) {
      fail(`${entryPath}.officialUrls`, "must contain official HTTPS sources");
    }
    validateDate(entry.lastVerified, `${entryPath}.lastVerified`);
  }
  return registry;
}

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function arxivAbsUrl(arxivId) {
  return `https://arxiv.org/abs/${arxivId}`;
}

function arxivPdfUrl(arxivId) {
  return `https://arxiv.org/pdf/${arxivId}`;
}

function arxivVersionedAbsUrl(arxivId) {
  return `${arxivAbsUrl(arxivId)}v1`;
}

function arxivVersionedPdfUrl(arxivId) {
  return `${arxivPdfUrl(arxivId)}v1`;
}

function validateArxivIdentity(paper, path) {
  if (typeof paper.arxivId !== "string" || !ARXIV_ID_PATTERN.test(paper.arxivId)) {
    fail(`${path}.arxivId`, "must be an unversioned modern arXiv ID");
  }
  if (paper.url !== arxivAbsUrl(paper.arxivId)) {
    fail(`${path}.url`, `must be ${arxivAbsUrl(paper.arxivId)}`);
  }
}

function validateScores(paper, path) {
  assertExactKeys(paper.scores, SCORE_KEYS, `${path}.scores`);
  for (const key of SCORE_KEYS) {
    const value = paper.scores[key];
    if (!Number.isInteger(value) || value < 0 || value > 25) {
      fail(`${path}.scores.${key}`, "must be an integer from 0 through 25");
    }
  }
  const total = SCORE_KEYS.reduce((sum, key) => sum + paper.scores[key], 0);
  if (paper.totalScore !== total) fail(`${path}.totalScore`, `must equal the four-score sum (${total})`);
}

function validateAuthors(authors, path) {
  if (!Array.isArray(authors) || authors.length === 0) fail(path, "must be a non-empty array");
  const seen = new Set();
  for (const [index, author] of authors.entries()) {
    assertNonEmptyString(author, `${path}[${index}]`);
    const key = normalize(author);
    if (seen.has(key)) fail(path, `contains duplicate author ${author}`);
    seen.add(key);
  }
}

function validatePaper(paper, slug, path, {
  requireDetailed = true,
  production = false,
  allowEminentAuthors = false,
} = {}) {
  assertObject(paper, path);
  validateArxivIdentity(paper, path);
  assertNonNegativeInteger(paper.rank, `${path}.rank`);
  assertNonEmptyString(paper.title, `${path}.title`);
  validateAuthors(paper.authors, `${path}.authors`);
  assertNonEmptyString(paper.paperType, `${path}.paperType`);
  if (!Number.isInteger(paper.totalScore) || paper.totalScore < 0 || paper.totalScore > 100) {
    fail(`${path}.totalScore`, "must be an integer from 0 through 100");
  }
  if (!requireDetailed) return;

  if (production) {
    const keys = [
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
      "totalScore",
      "abstractLines",
      "curiosity",
      "concept",
      "conclusion",
      "assessment",
      "evaluationBasis",
      "fullTextEvaluated",
      "sourceUrls",
      ...(paper.fullTextEvaluated === true ? ["fullTextReviewStatus"] : []),
      ...(allowEminentAuthors ? ["eminentAuthors"] : []),
    ];
    assertExactKeys(paper, keys, path);
    if (paper.arxivVersion !== "v1") fail(`${path}.arxivVersion`, "must be v1");
    if (paper.submissionType !== "new") fail(`${path}.submissionType`, "must be new");
  }

  if (paper.primaryCategory !== slug) fail(`${path}.primaryCategory`, `must be ${slug}`);
  for (const field of TEXT_FIELDS) assertNonEmptyString(paper[field], `${path}.${field}`);
  validateScores(paper, path);
  if (!Array.isArray(paper.abstractLines) || paper.abstractLines.length !== 3) {
    fail(`${path}.abstractLines`, "must contain exactly three lines");
  }
  paper.abstractLines.forEach((line, index) => assertNonEmptyString(line, `${path}.abstractLines[${index}]`));
  const requiredAbstractUrl = production ? arxivVersionedAbsUrl(paper.arxivId) : arxivAbsUrl(paper.arxivId);
  if (!Array.isArray(paper.sourceUrls) || !paper.sourceUrls.includes(requiredAbstractUrl)) {
    fail(`${path}.sourceUrls`, `must include ${requiredAbstractUrl}`);
  }
  if (paper.sourceUrls.some((url) => typeof url !== "string" || !/^https:\/\//.test(url))) {
    fail(`${path}.sourceUrls`, "may contain only HTTPS URLs");
  }

  if (paper.fullTextEvaluated === true) {
    if (paper.evaluationBasis !== "full_text_major_sections") {
      fail(`${path}.evaluationBasis`, "must be full_text_major_sections after full-text review");
    }
    assertNonEmptyString(paper.fullTextReviewStatus, `${path}.fullTextReviewStatus`);
    const requiredPdfUrl = production ? arxivVersionedPdfUrl(paper.arxivId) : arxivPdfUrl(paper.arxivId);
    if (!paper.sourceUrls.includes(requiredPdfUrl)) {
      fail(`${path}.sourceUrls`, `must include ${requiredPdfUrl} after full-text review`);
    }
  } else if (paper.fullTextEvaluated === false) {
    if (paper.evaluationBasis !== "title_authors_abstract") {
      fail(`${path}.evaluationBasis`, "must be title_authors_abstract without full-text review");
    }
  } else {
    fail(`${path}.fullTextEvaluated`, "must be a boolean");
  }
  if (production) {
    const allowedUrls = new Set([
      arxivVersionedAbsUrl(paper.arxivId),
      ...(paper.fullTextEvaluated ? [arxivVersionedPdfUrl(paper.arxivId)] : []),
    ]);
    if (
      paper.sourceUrls.length !== allowedUrls.size
      || new Set(paper.sourceUrls).size !== paper.sourceUrls.length
      || paper.sourceUrls.some((url) => !allowedUrls.has(url))
    ) {
      fail(`${path}.sourceUrls`, "must contain exactly the version-fixed arXiv abstract URL and, after full-text review, PDF URL");
    }
  }
}

export function comparePapers(a, b) {
  return b.totalScore - a.totalScore ||
    b.scores.broadImpact - a.scores.broadImpact ||
    b.scores.originality - a.scores.originality ||
    b.scores.technicalStrength - a.scores.technicalStrength ||
    b.scores.categoryImpact - a.scores.categoryImpact ||
    a.arxivId.localeCompare(b.arxivId);
}

function validateAudit(audit, report, date, slug, path) {
  assertObject(audit, path);
  assertExactKeys(audit, [
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
  ], path);
  const allowedListingUrls = new Set([
    `https://arxiv.org/list/${slug}/new`,
    `https://arxiv.org/list/${slug}/pastweek`,
  ]);
  if (!allowedListingUrls.has(audit.listingUrl)) {
    fail(`${path}.listingUrl`, `must be the official ${slug} new or pastweek listing URL`);
  }
  if (audit.announcementDate !== date) fail(`${path}.announcementDate`, `must equal ${date}`);
  for (const field of [
    "selectionRule",
    "evaluationPolicy",
    "scoreRubric",
    "fullTextPolicy",
    "authorPolicy",
    "rankingTieBreak",
  ]) {
    assertNonEmptyString(audit[field], `${path}.${field}`);
  }
  validateJstTimestamp(audit.generatedAtJst, `${path}.generatedAtJst`);
  if (audit.fullTextEvaluatedCount !== report.fullTextEvaluatedCount) {
    fail(`${path}.fullTextEvaluatedCount`, "must match the report count");
  }
  const counts = assertObject(audit.sourceCounts, `${path}.sourceCounts`);
  assertExactKeys(counts, [
    "newPrimary",
    "crosslistsExcluded",
    "titleAuthorAbstractEvaluated",
  ], `${path}.sourceCounts`);
  if (counts.newPrimary !== report.totalNew) {
    fail(`${path}.sourceCounts.newPrimary`, "must match totalNew");
  }
  if (counts.crosslistsExcluded !== report.crosslistsExcluded) {
    fail(`${path}.sourceCounts.crosslistsExcluded`, "must match crosslistsExcluded");
  }
  if (counts.titleAuthorAbstractEvaluated !== report.totalNew) {
    fail(`${path}.sourceCounts.titleAuthorAbstractEvaluated`, "must match totalNew");
  }
}

export function validateProductionReport(report, { date, slug, policy, path = "report" }) {
  assertObject(report, path);
  assertExactKeys(report, [
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
  ], path);
  if (report.schemaVersion !== PRODUCTION_SCHEMA) fail(`${path}.schemaVersion`, `must be ${PRODUCTION_SCHEMA}`);
  validateDate(date, "expected date");
  if (report.reportDate !== date) fail(`${path}.reportDate`, `must equal ${date}`);
  if (report.slug !== slug) fail(`${path}.slug`, `must equal ${slug}`);
  assertNonEmptyString(report.label, `${path}.label`);
  assertNonNegativeInteger(report.totalNew, `${path}.totalNew`);
  assertNonNegativeInteger(report.crosslistsExcluded, `${path}.crosslistsExcluded`);
  if (report.evaluatedCount !== report.totalNew) {
    fail(`${path}.evaluatedCount`, "must equal totalNew");
  }
  assertNonNegativeInteger(report.fullTextEvaluatedCount, `${path}.fullTextEvaluatedCount`);
  validateEvaluationRun(report.evaluationRun, policy, `${path}.evaluationRun`);
  validateAudit(report.audit, report, date, slug, `${path}.audit`);

  if (!Array.isArray(report.papers) || report.papers.length !== report.totalNew) {
    fail(`${path}.papers`, "must contain one detailed record for every new paper");
  }
  const ids = new Set();
  for (const [index, paper] of report.papers.entries()) {
    validatePaper(paper, slug, `${path}.papers[${index}]`, { production: true });
    if (ids.has(paper.arxivId)) fail(`${path}.papers[${index}].arxivId`, "is duplicated in this report");
    ids.add(paper.arxivId);
  }
  const ranked = [...report.papers].sort(comparePapers);
  ranked.forEach((paper, index) => {
    if (paper.rank !== index + 1) {
      fail(`${path}.papers`, `${paper.arxivId} must have deterministic rank ${index + 1}`);
    }
  });
  const actualFullTextCount = report.papers.filter((paper) => paper.fullTextEvaluated).length;
  if (report.fullTextEvaluatedCount !== actualFullTextCount) {
    fail(`${path}.fullTextEvaluatedCount`, `must equal ${actualFullTextCount}`);
  }
  const topCount = Math.min(10, report.totalNew);
  if (ranked.slice(0, topCount).some((paper) => !paper.fullTextEvaluated)) {
    fail(`${path}.papers`, `every final top-${topCount} paper must have a documented full-text review`);
  }
  return report;
}

export function validateProductionReportSet(reports, { date, policy, existingRunIds = new Set(), paths = {} }) {
  validateDate(date);
  validateModelPolicy(policy);
  assertExactKeys(reports, CATEGORIES, "reports");
  const allIds = new Set();
  let canonicalRun;
  let canonicalListingKind;
  for (const slug of CATEGORIES) {
    const report = validateProductionReport(reports[slug], {
      date,
      slug,
      policy,
      path: paths[slug] ?? `reports.${slug}`,
    });
    const runJson = evaluationRunFingerprint(report.evaluationRun);
    canonicalRun ??= runJson;
    if (runJson !== canonicalRun) fail("reports", "all categories must use the identical evaluationRun object");
    const listingKind = report.audit.listingUrl.endsWith("/pastweek") ? "pastweek" : "new";
    canonicalListingKind ??= listingKind;
    if (listingKind !== canonicalListingKind) fail("reports", "all categories must use the same official listing kind");
    for (const paper of report.papers) {
      if (allIds.has(paper.arxivId)) fail("reports", `duplicate arXiv ID across categories: ${paper.arxivId}`);
      allIds.add(paper.arxivId);
    }
  }
  const runId = reports[CATEGORIES[0]].evaluationRun.runId;
  if (existingRunIds.has(runId)) fail("reports.evaluationRun.runId", "was already used by another edition");
  return reports;
}

function validateBadgeList(value, authors, path) {
  if (!Array.isArray(value)) fail(path, "must be an array");
  const authorKeys = new Set(authors.map(normalize));
  const seen = new Set();
  for (const [index, badge] of value.entries()) {
    assertObject(badge, `${path}[${index}]`);
    const key = normalize(badge.authorName);
    if (!key || !authorKeys.has(key) || seen.has(key)) fail(`${path}[${index}].authorName`, "must identify one listed author once");
    seen.add(key);
    if (badge.label !== "著名著者") fail(`${path}[${index}].label`, "must be 著名著者");
    assertNonEmptyString(badge.reason, `${path}[${index}].reason`);
    assertNonEmptyString(badge.identityEvidence, `${path}[${index}].identityEvidence`);
    if (!Array.isArray(badge.evidenceUrls) || badge.evidenceUrls.length === 0 || badge.evidenceUrls.some((url) => !/^https:\/\//.test(url))) {
      fail(`${path}[${index}].evidenceUrls`, "must contain official HTTPS evidence");
    }
  }
}

function validatePublicCategory(category, slug, schema, path) {
  assertObject(category, path);
  if (schema === PRODUCTION_SCHEMA && category.schemaVersion !== PRODUCTION_SCHEMA) {
    fail(`${path}.schemaVersion`, `must be ${PRODUCTION_SCHEMA}`);
  }
  if (category.slug !== slug) fail(`${path}.slug`, `must be ${slug}`);
  assertNonNegativeInteger(category.totalNew, `${path}.totalNew`);
  assertNonNegativeInteger(category.evaluatedCount, `${path}.evaluatedCount`);
  assertNonNegativeInteger(category.fullTextEvaluatedCount, `${path}.fullTextEvaluatedCount`);
  if (category.evaluatedCount !== category.totalNew) fail(`${path}.evaluatedCount`, "must equal totalNew");
  const expectedTop = Math.min(10, category.totalNew);
  if (!Array.isArray(category.topPapers) || category.topPapers.length !== expectedTop) {
    fail(`${path}.topPapers`, `must contain ${expectedTop} papers`);
  }
  if (!Array.isArray(category.otherPapers) || category.otherPapers.length !== category.totalNew - expectedTop) {
    fail(`${path}.otherPapers`, `must contain ${category.totalNew - expectedTop} papers`);
  }
  const ids = new Set();
  const all = [...category.topPapers, ...category.otherPapers];
  all.forEach((paper, index) => {
    validatePaper(paper, slug, `${path}.${index < expectedTop ? "topPapers" : "otherPapers"}[${index < expectedTop ? index : index - expectedTop}]`, {
      requireDetailed: index < expectedTop,
      production: schema === PRODUCTION_SCHEMA,
      allowEminentAuthors: schema === PRODUCTION_SCHEMA && index < expectedTop,
    });
    if (paper.rank !== index + 1) fail(`${path}.papers`, "ranks must be consecutive");
    if (ids.has(paper.arxivId)) fail(`${path}.papers`, `duplicate arXiv ID ${paper.arxivId}`);
    ids.add(paper.arxivId);
    if (schema === PRODUCTION_SCHEMA) validateBadgeList(paper.eminentAuthors, paper.authors, `${path}.papers[${index}].eminentAuthors`);
  });
  if (category.topPapers.some((paper) => !paper.fullTextEvaluated)) {
    fail(`${path}.topPapers`, "every top paper must have a full-text review");
  }
  const sortedTop = [...category.topPapers].sort(comparePapers);
  if (JSON.stringify(sortedTop.map((paper) => paper.arxivId)) !== JSON.stringify(category.topPapers.map((paper) => paper.arxivId))) {
    fail(`${path}.topPapers`, "must follow the deterministic ranking order");
  }
  for (let index = 1; index < all.length; index += 1) {
    if (all[index - 1].totalScore < all[index].totalScore) {
      fail(`${path}.papers`, "total scores must be non-increasing by rank");
    }
  }
  if (schema === PRODUCTION_SCHEMA) {
    const fullTextCount = category.topPapers.filter((paper) => paper.fullTextEvaluated).length;
    if (category.fullTextEvaluatedCount < fullTextCount) fail(`${path}.fullTextEvaluatedCount`, "is smaller than the detailed top-paper count");
    if (category.eminentAuthorPaperCount !== all.filter((paper) => paper.eminentAuthors.length > 0).length) {
      fail(`${path}.eminentAuthorPaperCount`, "does not match badge data");
    }
    assertObject(category.audit, `${path}.audit`);
  }
  return ids;
}

export function validatePublicEdition(edition, { expectedDate, policy, path = "edition" } = {}) {
  assertObject(edition, path);
  if (![LEGACY_SCHEMA, PRODUCTION_SCHEMA].includes(edition.schemaVersion)) {
    fail(`${path}.schemaVersion`, `must be ${LEGACY_SCHEMA} or ${PRODUCTION_SCHEMA}`);
  }
  validateDate(edition.date, `${path}.date`);
  if (expectedDate && edition.date !== expectedDate) fail(`${path}.date`, `must equal filename date ${expectedDate}`);
  if (edition.sourceMode !== "live") fail(`${path}.sourceMode`, "must be live");
  if (edition.status !== "ok") fail(`${path}.status`, "must be ok");
  assertNonEmptyString(edition.statusMessage, `${path}.statusMessage`);
  validateJstTimestamp(edition.generatedAtJst, `${path}.generatedAtJst`);
  validateJstTimestamp(edition.lastSuccessfulAtJst, `${path}.lastSuccessfulAtJst`);
  if (edition.generatedAtJst !== edition.lastSuccessfulAtJst) fail(path, "generated and last-success timestamps must match");
  assertExactKeys(edition.categories, CATEGORIES, `${path}.categories`);
  const allIds = new Set();
  for (const slug of CATEGORIES) {
    const ids = validatePublicCategory(edition.categories[slug], slug, edition.schemaVersion, `${path}.categories.${slug}`);
    for (const id of ids) {
      if (allIds.has(id)) fail(`${path}.categories`, `duplicate arXiv ID across categories: ${id}`);
      allIds.add(id);
    }
    if (edition.schemaVersion === PRODUCTION_SCHEMA) {
      validateAudit(
        edition.categories[slug].audit,
        edition.categories[slug],
        edition.date,
        slug,
        `${path}.categories.${slug}.audit`,
      );
    }
  }
  if (edition.schemaVersion === PRODUCTION_SCHEMA) {
    const pipeline = assertObject(edition.pipeline, `${path}.pipeline`);
    if (pipeline.rubricVersion !== "2.0" || pipeline.scoreMaximum !== 100) fail(`${path}.pipeline`, "must use rubric 2.0 and a 100-point maximum");
    validateEvaluationRun(pipeline.evaluationRun, policy, `${path}.pipeline.evaluationRun`);
    assertExactKeys(pipeline.audit, CATEGORIES, `${path}.pipeline.audit`);
    for (const slug of CATEGORIES) {
      if (JSON.stringify(pipeline.audit[slug]) !== JSON.stringify(edition.categories[slug].audit)) {
        fail(`${path}.pipeline.audit.${slug}`, "must exactly match the category audit");
      }
    }
  }
  return edition;
}

export function listPublicDateFiles(dataDir) {
  if (!existsSync(dataDir)) return [];
  return readdirSync(dataDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.json$/.test(entry.name))
    .map((entry) => entry.name.slice(0, -5))
    .sort()
    .reverse();
}

export function validatePublicArchive(root, policy) {
  const dataDir = resolve(root, "public/data");
  for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^(?:current|index|\d{4}-\d{2}-\d{2})\.json$/.test(entry.name)) {
      fail(`public/data/${entry.name}`, "unexpected public archive entry");
    }
  }
  const dates = listPublicDateFiles(dataDir);
  if (dates.length === 0) fail(dataDir, "must contain at least one dated edition");
  const editions = new Map();
  const runIds = new Set();
  for (const date of dates) {
    validateDate(date, `public/data/${date}.json filename`);
    const edition = validatePublicEdition(parseJsonFile(resolve(dataDir, `${date}.json`)), {
      expectedDate: date,
      policy,
      path: `public/data/${date}.json`,
    });
    if (edition.schemaVersion === PRODUCTION_SCHEMA) {
      const runId = edition.pipeline.evaluationRun.runId;
      if (runIds.has(runId)) fail(`public/data/${date}.json`, `duplicate runId ${runId}`);
      runIds.add(runId);
    }
    editions.set(date, edition);
  }
  const index = parseJsonFile(resolve(dataDir, "index.json"));
  const current = parseJsonFile(resolve(dataDir, "current.json"));
  assertObject(index, "public/data/index.json");
  if (index.latestDate !== dates[0]) fail("public/data/index.json.latestDate", `must equal ${dates[0]}`);
  if (JSON.stringify(index.availableDates) !== JSON.stringify(dates)) {
    fail("public/data/index.json.availableDates", "must exactly match dated archive files in descending order");
  }
  if (current.date !== index.latestDate) fail("public/data/current.json.date", "must match index.latestDate");
  if (JSON.stringify(current) !== JSON.stringify(editions.get(dates[0]))) {
    fail("public/data/current.json", "must exactly match the latest dated edition");
  }
  if (index.schemaVersion !== current.schemaVersion) fail("public/data/index.json.schemaVersion", "must match current.json");
  if (index.generatedAtJst !== current.generatedAtJst || index.lastSuccessfulAtJst !== current.lastSuccessfulAtJst) {
    fail("public/data/index.json", "timestamps must match current.json");
  }
  if (JSON.stringify(current.availableDates) !== JSON.stringify(dates)) {
    fail("public/data/current.json.availableDates", "must match index and archive files");
  }
  return { dates, editions, index, current, runIds };
}

function validateLegacyReport(report, { date, slug, path }) {
  assertObject(report, path);
  if (String(report.schemaVersion) !== LEGACY_SCHEMA) fail(`${path}.schemaVersion`, `historical report must remain ${LEGACY_SCHEMA}`);
  if (report.slug !== slug) fail(`${path}.slug`, `must equal ${slug}`);
  if (report.audit?.announcementDate !== date) fail(`${path}.audit.announcementDate`, `must equal ${date}`);
  if (!Array.isArray(report.papers) || report.papers.length !== report.totalNew || report.evaluatedCount !== report.totalNew) {
    fail(`${path}.papers`, "legacy report counts are inconsistent");
  }
  const ids = new Set();
  for (const [index, paper] of report.papers.entries()) {
    const paperPath = `${path}.papers[${index}]`;
    validatePaper(paper, slug, paperPath, { requireDetailed: false });
    if (paper.rank !== index + 1) fail(`${paperPath}.rank`, `must equal ${index + 1}`);
    if (paper.primaryCategory !== slug) fail(`${paperPath}.primaryCategory`, `must be ${slug}`);
    for (const field of TEXT_FIELDS) assertNonEmptyString(paper[field], `${paperPath}.${field}`);
    validateScores(paper, paperPath);
    if (!Array.isArray(paper.abstractLines) || paper.abstractLines.length !== 3) {
      fail(`${paperPath}.abstractLines`, "must contain exactly three lines");
    }
    paper.abstractLines.forEach((line, lineIndex) => assertNonEmptyString(line, `${paperPath}.abstractLines[${lineIndex}]`));
    if (paper.fullTextEvaluated === true) {
      if (paper.evaluationBasis !== "full_text_major_sections") {
        fail(`${paperPath}.evaluationBasis`, "must be full_text_major_sections after full-text review");
      }
      assertNonEmptyString(paper.fullTextReviewStatus, `${paperPath}.fullTextReviewStatus`);
    } else if (paper.fullTextEvaluated === false) {
      if (paper.evaluationBasis !== "title_authors_abstract") {
        fail(`${paperPath}.evaluationBasis`, "must be title_authors_abstract without full-text review");
      }
    } else {
      fail(`${paperPath}.fullTextEvaluated`, "must be a boolean");
    }
    if (paper.sourceUrls !== undefined) {
      if (!Array.isArray(paper.sourceUrls) || paper.sourceUrls.some((url) => typeof url !== "string" || !/^https:\/\//.test(url))) {
        fail(`${paperPath}.sourceUrls`, "may contain only HTTPS URLs when present");
      }
    }
    if (ids.has(paper.arxivId)) fail(`${path}.papers`, `duplicate arXiv ID ${paper.arxivId}`);
    ids.add(paper.arxivId);
  }
  for (let index = 1; index < report.papers.length; index += 1) {
    if (report.papers[index - 1].totalScore < report.papers[index].totalScore) {
      fail(`${path}.papers`, "total scores must be non-increasing by rank");
    }
  }
  if (report.papers.filter((paper) => paper.fullTextEvaluated).length !== report.fullTextEvaluatedCount) {
    fail(`${path}.fullTextEvaluatedCount`, "does not match detailed paper records");
  }
  return ids;
}

export function validateReportsArchive(root, policy, publicArchive) {
  const reportsDir = resolve(root, "data/reports");
  const groups = new Map();
  for (const entry of readdirSync(reportsDir, { withFileTypes: true })) {
    if (!entry.isFile()) fail(`data/reports/${entry.name}`, "only report files are allowed");
    const match = /^(\d{4}-\d{2}-\d{2})-(hep-th|gr-qc|quant-ph)\.json$/.exec(entry.name);
    if (!match) fail(`data/reports/${entry.name}`, "unexpected report filename");
    const [, date, slug] = match;
    validateDate(date, `${entry.name} date`);
    if (!groups.has(date)) groups.set(date, {});
    groups.get(date)[slug] = parseJsonFile(resolve(reportsDir, entry.name));
  }
  for (const [date, reports] of groups) {
    assertExactKeys(reports, CATEGORIES, `data/reports/${date}`);
    const edition = publicArchive.editions.get(date);
    if (edition?.schemaVersion === LEGACY_SCHEMA) {
      const legacyIds = new Set();
      for (const slug of CATEGORIES) {
        const ids = validateLegacyReport(reports[slug], { date, slug, path: `data/reports/${date}-${slug}.json` });
        for (const id of ids) {
          if (legacyIds.has(id)) fail(`data/reports/${date}`, `duplicate arXiv ID across categories: ${id}`);
          legacyIds.add(id);
        }
      }
    } else {
      const otherRunIds = new Set(publicArchive.runIds);
      if (edition?.schemaVersion === PRODUCTION_SCHEMA) otherRunIds.delete(edition.pipeline.evaluationRun.runId);
      validateProductionReportSet(reports, { date, policy, existingRunIds: otherRunIds });
      if (!edition) fail(`data/reports/${date}`, "production reports have no corresponding public edition");
      if (edition.pipeline.evaluationRun.runId !== reports[CATEGORIES[0]].evaluationRun.runId) {
        fail(`data/reports/${date}`, "runId does not match the public edition");
      }
      if (JSON.stringify(edition.pipeline.evaluationRun) !== JSON.stringify(reports[CATEGORIES[0]].evaluationRun)) {
        fail(`data/reports/${date}`, "evaluationRun does not exactly match the public edition");
      }
      const expectedGeneratedAt = CATEGORIES.map((slug) => reports[slug].audit.generatedAtJst).sort().at(-1);
      if (edition.generatedAtJst !== expectedGeneratedAt) {
        fail(`public/data/${date}.json.generatedAtJst`, "must equal the latest category audit timestamp");
      }
      for (const slug of CATEGORIES) {
        const report = reports[slug];
        const category = edition.categories[slug];
        for (const key of [
          "slug",
          "label",
          "totalNew",
          "crosslistsExcluded",
          "evaluatedCount",
          "fullTextEvaluatedCount",
          "audit",
        ]) {
          if (JSON.stringify(category[key]) !== JSON.stringify(report[key])) {
            fail(`public/data/${date}.json.categories.${slug}.${key}`, "does not match its source report");
          }
        }
        const ranked = structuredClone(report.papers).sort(comparePapers);
        ranked.forEach((paper, index) => { paper.rank = index + 1; delete paper.eminentAuthors; });
        const actualTop = structuredClone(category.topPapers);
        actualTop.forEach((paper) => { delete paper.eminentAuthors; });
        if (JSON.stringify(actualTop) !== JSON.stringify(ranked.slice(0, 10))) {
          fail(`public/data/${date}.json.categories.${slug}.topPapers`, "does not match its source report");
        }
        const expectedOther = ranked.slice(10).map((paper) => ({
          rank: paper.rank,
          arxivId: paper.arxivId,
          url: paper.url,
          title: paper.title,
          authors: paper.authors,
          paperType: paper.paperType,
          totalScore: paper.totalScore,
        }));
        const actualOther = structuredClone(category.otherPapers);
        actualOther.forEach((paper) => { delete paper.eminentAuthors; });
        if (JSON.stringify(actualOther) !== JSON.stringify(expectedOther)) {
          fail(`public/data/${date}.json.categories.${slug}.otherPapers`, "does not match its source report");
        }
      }
    }
  }
  for (const [date, edition] of publicArchive.editions) {
    if (edition.schemaVersion === PRODUCTION_SCHEMA && !groups.has(date)) {
      fail(`public/data/${date}.json`, "production edition is missing its three immutable source reports");
    }
  }
}

const SECRET_FILE_PATTERNS = [
  /^\.env(?:\.(?!example$).+)?$/i,
  /^(?:id_rsa|id_ed25519|credentials\.json|service-account\.json|\.npmrc)$/i,
  /\.(?:pem|p12|pfx|key)$/i,
];

const SECRET_CONTENT_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+\/-]{20,}/i,
  /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[=:]\s*["']?(?!example|placeholder|redacted|changeme)[A-Za-z0-9._~+\/-]{16,}/i,
  /https?:\/\/[^\s/:]+:[^\s/@]+@/i,
];

export function findForbiddenRepositoryArtifacts(root) {
  const problems = [];
  const absoluteRoot = resolve(root);
  function visit(directory, relativeDirectory = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (relativePath === ".git" || relativePath === "node_modules") continue;
      const absolutePath = resolve(directory, entry.name);
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        problems.push(`${relativePath}: symbolic links are not allowed`);
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name === ".git") {
          problems.push(`${relativePath}: nested .git directory is forbidden`);
        } else {
          visit(absolutePath, relativePath);
        }
        continue;
      }
      if (!entry.isFile()) {
        problems.push(`${relativePath}: special filesystem entry is forbidden`);
        continue;
      }
      if (/\.pdf$/i.test(entry.name)) problems.push(`${relativePath}: PDF files are forbidden`);
      if (SECRET_FILE_PATTERNS.some((pattern) => pattern.test(entry.name))) {
        problems.push(`${relativePath}: credential-bearing filename is forbidden`);
      }
      if (stat.size <= 10 * 1024 * 1024) {
        const bytes = readFileSync(absolutePath);
        if (!bytes.includes(0)) {
          const source = bytes.toString("utf8");
          if (SECRET_CONTENT_PATTERNS.some((pattern) => pattern.test(source))) {
            problems.push(`${relativePath}: probable secret or credential detected`);
          }
        }
      } else {
        problems.push(`${relativePath}: file exceeds the 10 MiB safety-scan limit`);
      }
    }
  }
  visit(absoluteRoot);
  return problems;
}

export function validateRepository(root) {
  const policyPath = resolve(root, "data/model-policy.json");
  const policy = validateModelPolicy(parseJsonFile(policyPath), "data/model-policy.json");
  validateDistinguishedRegistry(parseJsonFile(resolve(root, "data/distinguished-authors.json")));
  const forbidden = findForbiddenRepositoryArtifacts(root);
  if (forbidden.length > 0) fail("repository safety scan", forbidden.join("; "));
  const publicArchive = validatePublicArchive(root, policy);
  validateReportsArchive(root, policy, publicArchive);
  if (!existsSync(resolve(root, "public/index.html"))) fail("public/index.html", "is required");
  if (!existsSync(resolve(root, ".github/workflows/pages-data.yml"))) fail(".github/workflows/pages-data.yml", "is required");
  return { policy, publicArchive };
}

function registryBadges(paper, slug, registry) {
  return paper.authors.flatMap((authorName) => {
    const key = normalize(authorName);
    const match = (registry.authors ?? []).find((entry) =>
      (entry.fieldTags ?? []).includes(slug) &&
      [entry.canonicalName, ...(entry.aliases ?? [])].some((name) => normalize(name) === key));
    if (!match) return [];
    return [{
      authorName,
      label: "著名著者",
      reason: match.distinction,
      identityEvidence: match.identityEvidence,
      evidenceUrls: match.officialUrls,
    }];
  });
}

function readProductionReports(reportsDir, date) {
  const reports = {};
  const paths = {};
  for (const slug of CATEGORIES) {
    const path = resolve(reportsDir, `${date}-${slug}.json`);
    reports[slug] = parseJsonFile(path);
    paths[slug] = path;
  }
  return { reports, paths };
}

export function buildEdition({ root, date, reportsDir = resolve(root, "data/reports") }) {
  validateDate(date);
  const policy = validateModelPolicy(parseJsonFile(resolve(root, "data/model-policy.json")));
  const dataDir = resolve(root, "public/data");
  const existingDates = listPublicDateFiles(dataDir);
  const existingEditions = new Map();
  const existingRunIds = new Set();
  for (const existingDate of existingDates) {
    const edition = validatePublicEdition(parseJsonFile(resolve(dataDir, `${existingDate}.json`)), {
      expectedDate: existingDate,
      policy,
      path: `public/data/${existingDate}.json`,
    });
    existingEditions.set(existingDate, edition);
    if (edition.schemaVersion === PRODUCTION_SCHEMA && existingDate !== date) {
      existingRunIds.add(edition.pipeline.evaluationRun.runId);
    }
  }
  if (existingDates.length > 0 && date < existingDates[0]) {
    fail("date", `cannot publish ${date} behind current latest date ${existingDates[0]}`);
  }
  if (existingEditions.get(date)?.schemaVersion === LEGACY_SCHEMA) {
    fail(`public/data/${date}.json`, "legacy schema-1.2 editions are immutable");
  }
  const { reports, paths } = readProductionReports(reportsDir, date);
  validateProductionReportSet(reports, { date, policy, existingRunIds, paths });
  const registry = validateDistinguishedRegistry(parseJsonFile(resolve(root, "data/distinguished-authors.json")));
  const categoryData = {};
  for (const slug of CATEGORIES) {
    const report = reports[slug];
    const papers = structuredClone(report.papers).sort(comparePapers);
    papers.forEach((paper, index) => {
      paper.rank = index + 1;
      paper.eminentAuthors = registryBadges(paper, slug, registry);
      validateBadgeList(paper.eminentAuthors, paper.authors, `${paths[slug]}.papers[${index}].eminentAuthors`);
    });
    const topPapers = papers.slice(0, 10);
    const otherPapers = papers.slice(10).map((paper) => ({
      rank: paper.rank,
      arxivId: paper.arxivId,
      url: paper.url,
      title: paper.title,
      authors: paper.authors,
      paperType: paper.paperType,
      totalScore: paper.totalScore,
      eminentAuthors: paper.eminentAuthors,
    }));
    categoryData[slug] = {
      schemaVersion: PRODUCTION_SCHEMA,
      slug,
      label: report.label,
      totalNew: report.totalNew,
      crosslistsExcluded: report.crosslistsExcluded,
      evaluatedCount: report.evaluatedCount,
      fullTextEvaluatedCount: report.fullTextEvaluatedCount,
      audit: report.audit,
      topPapers,
      otherPapers,
      eminentAuthorPaperCount: papers.filter((paper) => paper.eminentAuthors.length > 0).length,
    };
  }
  const availableDates = [...new Set([...existingDates, date])].sort().reverse();
  const generatedAtJst = CATEGORIES.map((slug) => reports[slug].audit.generatedAtJst).sort().at(-1);
  const expected = CATEGORIES.reduce((sum, slug) => sum + reports[slug].totalNew, 0);
  if (expected === 0) fail("reports", "must not publish an all-empty edition");
  const distinguished = CATEGORIES.reduce((sum, slug) => sum + categoryData[slug].eminentAuthorPaperCount, 0);
  const evaluationRun = structuredClone(reports[CATEGORIES[0]].evaluationRun);
  const edition = {
    schemaVersion: PRODUCTION_SCHEMA,
    sourceMode: "live",
    date,
    status: "ok",
    statusMessage: `全${expected}件を一次評価し、各カテゴリ上位10件はPDF全文を確認して4項目100点満点で最終評価しました。著名著者マーク${distinguished}件は順位に加点していません。`,
    generatedAtJst,
    lastSuccessfulAtJst: generatedAtJst,
    availableDates,
    categories: categoryData,
    pipeline: {
      mode: "scheduled-abstract-screen-fulltext-top10",
      rubricVersion: "2.0",
      scoreMaximum: 100,
      evaluationRun,
      authorPolicy: "Author identity and reputation never affect scores. Verified distinction badges are non-scoring and non-exhaustive.",
      audit: Object.fromEntries(CATEGORIES.map((slug) => [slug, reports[slug].audit])),
    },
  };
  validatePublicEdition(edition, { expectedDate: date, policy, path: `generated ${date} edition` });
  const index = {
    schemaVersion: PRODUCTION_SCHEMA,
    latestDate: date,
    availableDates,
    generatedAtJst,
    lastSuccessfulAtJst: generatedAtJst,
  };
  return { edition, index, reports, policy };
}

function durableWrite(path, content, mode) {
  const descriptor = openSync(path, "wx", mode);
  try {
    let offset = 0;
    while (offset < content.length) offset += writeSync(descriptor, content, offset);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function snapshotFiles(paths) {
  return new Map(paths.map((path) => [path, existsSync(path) ? {
    content: readFileSync(path),
    mode: statSync(path).mode,
  } : null]));
}

export function restoreFileSnapshot(snapshot) {
  const entries = [];
  for (const [path, previous] of snapshot) {
    if (previous) entries.push({ path, content: previous.content, mode: previous.mode });
  }
  transactionalWriteFiles(entries);
  for (const [path, previous] of snapshot) {
    if (!previous && existsSync(path)) rmSync(path, { force: true });
  }
}

export function transactionalWriteFiles(entries, { failAfterWrites = Number.POSITIVE_INFINITY } = {}) {
  const normalized = entries.map((entry, index) => ({
    path: resolve(entry.path),
    content: Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, "utf8"),
    mode: entry.mode ?? 0o644,
    index,
  }));
  const unique = new Set(normalized.map((entry) => entry.path));
  if (unique.size !== normalized.length) fail("transaction", "target paths must be unique");
  const changed = normalized.filter((entry) => !existsSync(entry.path) || !readFileSync(entry.path).equals(entry.content));
  if (changed.length === 0) return { changed: false, paths: [] };
  const snapshot = snapshotFiles(changed.map((entry) => entry.path));
  const temporaryPaths = [];
  let written = 0;
  try {
    for (const entry of changed) {
      mkdirSync(dirname(entry.path), { recursive: true });
      const temporaryPath = `${entry.path}.tmp-${process.pid}-${entry.index}-${Date.now()}`;
      durableWrite(temporaryPath, entry.content, entry.mode);
      temporaryPaths.push(temporaryPath);
      entry.temporaryPath = temporaryPath;
    }
    for (const entry of changed) {
      renameSync(entry.temporaryPath, entry.path);
      written += 1;
      if (written >= failAfterWrites) throw new Error("injected transactional write failure");
    }
    return { changed: true, paths: changed.map((entry) => entry.path) };
  } catch (error) {
    for (const [path, previous] of snapshot) {
      try {
        if (previous) {
          const rollbackPath = `${path}.rollback-${process.pid}-${Date.now()}`;
          durableWrite(rollbackPath, previous.content, previous.mode);
          renameSync(rollbackPath, path);
        } else {
          rmSync(path, { force: true });
        }
      } catch (rollbackError) {
        error.message += `; rollback failed for ${path}: ${rollbackError.message}`;
      }
    }
    throw error;
  } finally {
    for (const path of temporaryPaths) rmSync(path, { force: true });
  }
}

export function editionOutputEntries({ root, date, edition, index }) {
  return [
    { path: resolve(root, `public/data/${date}.json`), content: serializeJson(edition) },
    { path: resolve(root, "public/data/current.json"), content: serializeJson(edition) },
    { path: resolve(root, "public/data/index.json"), content: serializeJson(index) },
  ];
}

export function mergeEditionTransactionally(options) {
  const built = buildEdition(options);
  const entries = editionOutputEntries({ ...options, ...built });
  const datedPath = entries[0].path;
  if (existsSync(datedPath) && readFileSync(datedPath, "utf8") !== entries[0].content) {
    fail(datedPath, "dated editions are immutable and existing content differs");
  }
  const snapshot = snapshotFiles(entries.map((entry) => entry.path));
  const result = transactionalWriteFiles(entries, options.transactionOptions);
  try {
    validateRepository(options.root);
    return { ...built, ...result };
  } catch (error) {
    if (result.changed) {
      try {
        restoreFileSnapshot(snapshot);
      } catch (rollbackError) {
        error.message += `; merge rollback failed: ${rollbackError.message}`;
      }
    }
    throw error;
  }
}

export function pathIsWithin(parent, candidate) {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

export function relativePosix(root, path) {
  return relative(resolve(root), resolve(path)).split(sep).join("/");
}

export function assertExactStagingReports(stagingDir, date) {
  const expected = CATEGORIES.map((slug) => `${date}-${slug}.json`).sort();
  const entries = readdirSync(stagingDir, { withFileTypes: true });
  const actual = entries.map((entry) => entry.name).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(stagingDir, `must contain exactly ${expected.join(", ")}`);
  }
  for (const entry of entries) {
    const path = resolve(stagingDir, entry.name);
    if (!entry.isFile() || lstatSync(path).isSymbolicLink()) fail(path, "must be a regular, non-symlink file");
  }
  return Object.fromEntries(CATEGORIES.map((slug) => [slug, resolve(stagingDir, `${date}-${slug}.json`)]));
}

export function publicationAllowlist(date) {
  validateDate(date);
  return [
    ...CATEGORIES.map((slug) => `data/reports/${date}-${slug}.json`),
    `public/data/${date}.json`,
    "public/data/current.json",
    "public/data/index.json",
  ];
}

export function basenameForDisplay(path) {
  return basename(path);
}
