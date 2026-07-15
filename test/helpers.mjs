import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CATEGORIES,
  mergeEditionTransactionally,
  serializeJson,
} from "../scripts/lib/pipeline.mjs";

export const DATE = "2099-01-05";

export function validPolicy() {
  return {
    schemaVersion: "1.1",
    requiredModelId: "gpt-5.6-sol",
    requiredModelDisplayName: "GPT-5.6-Sol",
    requiredReasoningEffort: "high",
    requireExplicitModelSelection: true,
    qualificationStatus: "not_benchmarked",
    qualificationRequiredForPublication: false,
    historicalRunExceptions: [],
    verificationScope: "Metadata is checked; scheduler model selection cannot be independently attested.",
    publicationRule: "Only complete schema-1.4 editions with exact runtime metadata may publish.",
    lastReviewed: "2099-01-05",
  };
}

export function validRun() {
  return {
    modelId: "gpt-5.6-sol",
    modelDisplayName: "GPT-5.6-Sol",
    reasoningEffort: "high",
    modelSelectionVerified: true,
    runId: "run-2099-01-05-fixture",
  };
}

function fixtureId(categoryIndex, paperIndex) {
  return `9901.${String(categoryIndex * 100 + paperIndex + 1).padStart(5, "0")}`;
}

export function validReport(slug, { date = DATE, count = 11, run = validRun() } = {}) {
  const categoryIndex = CATEGORIES.indexOf(slug);
  const papers = Array.from({ length: count }, (_, index) => {
    const arxivId = fixtureId(categoryIndex, index);
    const fullTextEvaluated = index < Math.min(10, count);
    const scores = {
      broadImpact: 25 - index,
      categoryImpact: 20,
      originality: 20,
      technicalStrength: fullTextEvaluated ? 20 : 17,
    };
    return {
      rank: index + 1,
      arxivId,
      arxivVersion: "v1",
      submissionType: "new",
      url: `https://arxiv.org/abs/${arxivId}`,
      title: `Fixture ${slug} ${index + 1}`,
      titleJa: `検証用論文第${index + 1}号`,
      authors: [`Author ${categoryIndex}-${index}`],
      primaryCategory: slug,
      paperType: "理論",
      scores,
      scoreReasons: {
        broadImpact: `論文${index + 1}の結果は、複数の物理領域へ波及する可能性がある。`,
        categoryImpact: `論文${index + 1}は、${slug}の中心課題に対して具体的な前進を示している。`,
        originality: `論文${index + 1}は、既存手法とは異なる構成を導入して新しい問いに答えている。`,
        technicalStrength: `論文${index + 1}は、明示した仮定の下で導出と検証を行い、適用限界も記している。`,
      },
      totalScore: Object.values(scores).reduce((sum, value) => sum + value, 0),
      abstractLines: ["背景を説明する。", "方法を説明する。", "結論を説明する。"],
      curiosity: "研究上の問いを説明する。",
      concept: "研究の方法を説明する。",
      conclusion: "研究の結論を説明する。",
      assessment: `論文${index + 1}は、提示した証拠と明記された限界を踏まえて総合評価した。`,
      evaluationBasis: fullTextEvaluated ? "full_text_major_sections" : "title_authors_abstract",
      fullTextEvaluated,
      ...(fullTextEvaluated ? { fullTextReviewStatus: `論文${index + 1}の主要節、結論、限界、付録を確認した。` } : {}),
      sourceUrls: [
        `https://arxiv.org/abs/${arxivId}v1`,
        ...(fullTextEvaluated ? [`https://arxiv.org/pdf/${arxivId}v1`] : []),
      ],
    };
  });
  return {
    schemaVersion: "1.4",
    reportDate: date,
    evaluationRun: structuredClone(run),
    slug,
    label: slug,
    totalNew: count,
    crosslistsExcluded: 2,
    evaluatedCount: count,
    fullTextEvaluatedCount: Math.min(10, count),
    papers,
    audit: {
      listingUrl: `https://arxiv.org/list/${slug}/new`,
      announcementDate: date,
      selectionRule: "Primary-category v1 new submissions only.",
      sourceCounts: {
        newPrimary: count,
        crosslistsExcluded: 2,
        titleAuthorAbstractEvaluated: count,
      },
      evaluationPolicy: "Every paper is scored without author reputation.",
      scoreRubric: "Daily arXiv rubric 3.0 — 四つの評価軸を各0点から25点で採点する。",
      fullTextPolicy: "Every final top-ten paper receives full-text review.",
      fullTextEvaluatedCount: Math.min(10, count),
      authorPolicy: "Author identity is never scored.",
      rankingTieBreak: "Total, dimensions, then arXiv ID.",
      generatedAtJst: `${date}T12:00:0${categoryIndex}+09:00`,
    },
  };
}

export function validReportSet(options) {
  return Object.fromEntries(CATEGORIES.map((slug) => [slug, validReport(slug, options)]));
}

export function writeBaseRoot(root) {
  mkdirSync(resolve(root, "data/reports"), { recursive: true });
  mkdirSync(resolve(root, "public/data"), { recursive: true });
  mkdirSync(resolve(root, ".github/workflows"), { recursive: true });
  writeFileSync(resolve(root, "data/model-policy.json"), serializeJson(validPolicy()));
  writeFileSync(resolve(root, "data/distinguished-authors.json"), serializeJson({ schemaVersion: "1.0", authors: [] }));
  writeFileSync(resolve(root, "public/index.html"), "<!doctype html><title>fixture</title>\n");
  writeFileSync(resolve(root, ".github/workflows/pages-data.yml"), "name: fixture\n");
}

export function writeReports(root, reports = validReportSet(), directory = resolve(root, "data/reports")) {
  mkdirSync(directory, { recursive: true });
  for (const slug of CATEGORIES) {
    writeFileSync(resolve(directory, `${DATE}-${slug}.json`), serializeJson(reports[slug]));
  }
}

export function writeProductionRepository(root, reports = validReportSet()) {
  writeBaseRoot(root);
  writeReports(root, reports);
  mergeEditionTransactionally({ root, date: DATE });
}
