import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const categories = ["hep-th", "gr-qc", "quant-ph"];
const SCORE_KEYS = ["broadImpact", "categoryImpact", "originality", "technicalStrength"];
const distinctionRegistry = JSON.parse(readFileSync(resolve("data/distinguished-authors.json"), "utf8"));
const requireModelPolicy = process.argv.includes("--require-model-policy");
const modelPolicy = requireModelPolicy
  ? JSON.parse(readFileSync(resolve("data/model-policy.json"), "utf8"))
  : null;
const date = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Tokyo",
}).format(new Date());

if (requireModelPolicy && modelPolicy.qualificationStatus !== "qualified") {
  throw new Error("gpt-5.6-sol has not passed the required Pro-reference qualification benchmark");
}

function nowJst() {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
  return `${parts.replace(" ", "T")}+09:00`;
}

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function validateEminentAuthors(paper, path) {
  if (paper.eminentAuthors === undefined) return;
  if (!Array.isArray(paper.eminentAuthors)) {
    throw new Error(`${path}: eminentAuthors must be an array for ${paper.arxivId}`);
  }
  const seen = new Set();
  for (const badge of paper.eminentAuthors) {
    const key = normalize(badge.authorName);
    if (!key || seen.has(key) || !paper.authors.some((author) => normalize(author) === key)) {
      throw new Error(`${path}: eminent author identity mismatch for ${paper.arxivId}`);
    }
    seen.add(key);
    if (badge.label !== "著名著者" || !badge.reason || !badge.identityEvidence) {
      throw new Error(`${path}: incomplete eminent-author badge for ${paper.arxivId}`);
    }
    if (
      !Array.isArray(badge.evidenceUrls) ||
      badge.evidenceUrls.length === 0 ||
      badge.evidenceUrls.some((url) => !/^https:\/\//.test(url))
    ) {
      throw new Error(`${path}: official https evidence is required for ${paper.arxivId}`);
    }
  }
}

function registryBadges(paper, slug) {
  return paper.authors.flatMap((authorName) => {
    const key = normalize(authorName);
    const matched = (distinctionRegistry.authors ?? []).find((entry) =>
      (entry.fieldTags ?? []).includes(slug) &&
      [entry.canonicalName, ...(entry.aliases ?? [])].some((name) => normalize(name) === key),
    );
    if (!matched) return [];
    return [{
      authorName,
      label: "著名著者",
      reason: matched.distinction,
      identityEvidence: matched.identityEvidence,
      evidenceUrls: matched.officialUrls,
    }];
  });
}

function readCategory(slug) {
  const path = resolve(`data/reports/${date}-${slug}.json`);
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const category = parsed.categoryData ?? parsed.category ?? parsed;
  const schemaVersion = String(parsed.schemaVersion ?? category.schemaVersion);
  const requiredSchema = requireModelPolicy ? "1.3" : "1.2";
  if (schemaVersion !== requiredSchema) {
    throw new Error(`${path}: schemaVersion ${requiredSchema} is required`);
  }
  if (requireModelPolicy) {
    const run = parsed.evaluationRun;
    if (
      run?.modelId !== "gpt-5.6-sol" ||
      run?.modelDisplayName !== "5.6 Sol Ultra" ||
      run?.reasoningEffort !== "ultra" ||
      run?.modelSelectionVerified !== true ||
      typeof run?.runId !== "string" ||
      !run.runId.trim()
    ) {
      throw new Error(`${path}: verified gpt-5.6-sol / ultra execution metadata is required`);
    }
  }
  if (category.slug !== slug) {
    throw new Error(`${path}: expected slug=${slug}, got ${category.slug}`);
  }
  const papers = category.papers;
  if (!Array.isArray(papers) || papers.length !== category.totalNew) {
    throw new Error(`${path}: detailed records are required for all ${category.totalNew} papers`);
  }

  for (const paper of papers) {
    const actualKeys = Object.keys(paper.scores ?? {}).sort();
    if (actualKeys.join(",") !== [...SCORE_KEYS].sort().join(",")) {
      throw new Error(`${path}: ${paper.arxivId} must contain exactly the four v2 content scores`);
    }
    const scoreValues = SCORE_KEYS.map((key) => paper.scores[key]);
    if (
      paper.primaryCategory !== slug ||
      scoreValues.some((score) => !Number.isInteger(score) || score < 0 || score > 25)
    ) {
      throw new Error(`${path}: invalid category or 0..25 score for ${paper.arxivId}`);
    }
    if (scoreValues.reduce((sum, score) => sum + score, 0) !== paper.totalScore) {
      throw new Error(`${path}: totalScore mismatch for ${paper.arxivId}`);
    }
    const abstractOnly = paper.evaluationBasis === "title_authors_abstract" && paper.fullTextEvaluated === false;
    const fullText = paper.evaluationBasis === "full_text_major_sections" &&
      paper.fullTextEvaluated === true &&
      typeof paper.fullTextReviewStatus === "string" &&
      paper.fullTextReviewStatus.trim().length > 0;
    if (
      (!abstractOnly && !fullText) ||
      !Array.isArray(paper.authors) ||
      paper.authors.length === 0 ||
      !Array.isArray(paper.abstractLines) ||
      paper.abstractLines.length !== 3
    ) {
      throw new Error(`${path}: incomplete title/authors/abstract evaluation for ${paper.arxivId}`);
    }
    paper.eminentAuthors = registryBadges(paper, slug);
    validateEminentAuthors(paper, path);
  }

  papers.sort((a, b) =>
    b.totalScore - a.totalScore ||
    b.scores.broadImpact - a.scores.broadImpact ||
    b.scores.originality - a.scores.originality ||
    b.scores.technicalStrength - a.scores.technicalStrength ||
    b.scores.categoryImpact - a.scores.categoryImpact ||
    a.arxivId.localeCompare(b.arxivId),
  );
  papers.forEach((paper, index) => {
    paper.rank = index + 1;
  });
  if (papers.slice(0, Math.min(10, papers.length)).some((paper) => !paper.fullTextEvaluated)) {
    throw new Error(`${path}: every final top-10 paper must have a documented full-text review`);
  }
  category.topPapers = papers.slice(0, 10);
  category.otherPapers = papers.slice(10).map((paper) => ({
    rank: paper.rank,
    arxivId: paper.arxivId,
    url: paper.url,
    title: paper.title,
    authors: paper.authors,
    paperType: paper.paperType,
    totalScore: paper.totalScore,
    eminentAuthors: paper.eminentAuthors ?? [],
  }));
  category.evaluatedCount = papers.length;
  category.eminentAuthorPaperCount = papers.filter((paper) => paper.eminentAuthors?.length).length;
  category.fullTextEvaluatedCount = papers.filter((paper) => paper.fullTextEvaluated).length;
  delete category.papers;
  delete category.authorAuthorityEvaluatedCount;
  return {
    category,
    audit: parsed.audit ?? parsed.methodology ?? null,
    evaluationRun: parsed.evaluationRun ?? null,
  };
}

const loaded = Object.fromEntries(categories.map((slug) => [slug, readCategory(slug)]));
const categoryData = Object.fromEntries(categories.map((slug) => [slug, loaded[slug].category]));
const allIds = categories.flatMap((slug) => [
  ...categoryData[slug].topPapers,
  ...categoryData[slug].otherPapers,
].map((paper) => paper.arxivId.replace(/v\d+$/, "")));
if (new Set(allIds).size !== allIds.length) {
  throw new Error("duplicate arXiv ID found across categories");
}

const expected = categories.reduce((sum, slug) => sum + categoryData[slug].totalNew, 0);
const evaluated = categories.reduce((sum, slug) => sum + categoryData[slug].evaluatedCount, 0);
if (evaluated !== expected) throw new Error(`incomplete edition: expected ${expected}, got ${evaluated}`);

let evaluationRun = null;
if (requireModelPolicy) {
  const runs = categories.map((slug) => loaded[slug].evaluationRun);
  const canonical = JSON.stringify(runs[0]);
  if (runs.some((run) => JSON.stringify(run) !== canonical)) {
    throw new Error("all category reports must come from the same verified Sol Ultra run");
  }
  evaluationRun = runs[0];
}

const generatedAtJst = nowJst();
const dataDir = resolve("public/data");
mkdirSync(dataDir, { recursive: true });
const existingDates = readdirSync(dataDir)
  .map((name) => name.match(/^(\d{4}-\d{2}-\d{2})\.json$/)?.[1])
  .filter(Boolean);
const availableDates = [...new Set([...existingDates, date])].sort().reverse();
const distinguishedCount = categories.reduce(
  (sum, slug) => sum + categoryData[slug].eminentAuthorPaperCount,
  0,
);

const dashboard = {
  schemaVersion: requireModelPolicy ? "1.3" : "1.2",
  sourceMode: "live",
  date,
  status: "ok",
  statusMessage: `全${expected}件を一次評価し、各カテゴリ上位10件はPDF全文を確認して4項目100点満点で最終評価しました。著名著者マーク${distinguishedCount}件は順位に加点していません。`,
  generatedAtJst,
  lastSuccessfulAtJst: generatedAtJst,
  availableDates,
  categories: categoryData,
  pipeline: {
    mode: "scheduled-abstract-screen-fulltext-top10",
    rubricVersion: "2.0",
    scoreMaximum: 100,
    ...(evaluationRun ? { evaluationRun } : {}),
    authorPolicy: "Author identity and reputation never affect scores. Verified distinction badges are non-scoring and non-exhaustive.",
    audit: Object.fromEntries(categories.map((slug) => [slug, loaded[slug].audit])),
  },
};

const output = resolve(`public/data/${date}.json`);
writeFileSync(output, `${JSON.stringify(dashboard, null, 2)}\n`, "utf8");
writeFileSync(resolve("public/data/current.json"), `${JSON.stringify(dashboard, null, 2)}\n`, "utf8");
const index = {
  schemaVersion: requireModelPolicy ? "1.3" : "1.2",
  latestDate: date,
  availableDates,
  generatedAtJst,
  lastSuccessfulAtJst: generatedAtJst,
};
writeFileSync(resolve("public/data/index.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");
console.log(`wrote ${output}, current.json, and index.json`);
