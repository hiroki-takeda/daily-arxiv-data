export const CATEGORY_ORDER = ["hep-th", "gr-qc", "quant-ph"] as const;

export type CategorySlug = (typeof CATEGORY_ORDER)[number];
export type PaperType = "理論" | "実験・観測" | "解析" | "レビュー";
export type UpdateStatus = "ok" | "partial" | "updating" | "error";

export type ScoreBreakdown = {
  broadImpact: number;
  categoryImpact: number;
  originality: number;
  technicalStrength?: number;
  /** Legacy v1.1 archives only. New editions never use author reputation as a score. */
  authorAuthority?: number;
};

export type EvaluationBasis = "title_authors_abstract" | "full_text_major_sections";

export type EminentAuthorBadge = {
  authorName: string;
  label: "著名著者";
  reason: string;
  identityEvidence: string;
  evidenceUrls: string[];
};

export type AuthorAuthorityEvidence = {
  authorName: string;
  individualScore: number;
  individualRawScore?: number;
  confidence: "high" | "medium" | "low";
  identityConfidence?: number;
  openAlexId?: string;
  orcid?: string | null;
  metricQuality?: "complete" | "partial" | "unavailable";
  metrics?: {
    hIndex: number;
    citedByCount: number;
    lifetimeNormalizedImpact: number;
    recentNormalizedImpact: number;
  };
  rationale: string;
  evidenceUrls: string[];
  verifiedAt?: string;
};

export type Paper = {
  rank: number;
  arxivId: string;
  url: string;
  title: string;
  titleJa: string;
  authors: string[];
  primaryCategory: CategorySlug;
  paperType: PaperType;
  scores: ScoreBreakdown;
  totalScore: number;
  abstractLines: [string, string, string];
  curiosity: string;
  concept: string;
  conclusion: string;
  assessment: string;
  fullTextEvaluated: boolean;
  evaluationBasis?: EvaluationBasis;
  fullTextReviewStatus?: string;
  authorAuthorityEvidence?: AuthorAuthorityEvidence[];
  authorAuthorityCoverage?: number;
  authorAuthorityRationale?: string;
  authorAuthoritySampledCount?: number;
  authorityModelVersion?: string;
  contentAssessment?: string;
  eminentAuthors?: EminentAuthorBadge[];
};

export type CompactPaper = Pick<
  Paper,
  "rank" | "arxivId" | "url" | "title" | "authors" | "paperType" | "totalScore" | "eminentAuthors"
>;

export type CategoryData = {
  slug: CategorySlug;
  label: string;
  totalNew: number;
  crosslistsExcluded: number;
  evaluatedCount: number;
  fullTextEvaluatedCount?: number;
  authorAuthorityEvaluatedCount?: number;
  eminentAuthorPaperCount?: number;
  topPapers: Paper[];
  otherPapers: CompactPaper[];
};

export type DashboardData = {
  schemaVersion: "1.0" | "1.1" | "1.2" | "1.3";
  sourceMode: "demo" | "live";
  date: string;
  status: UpdateStatus;
  statusMessage: string;
  generatedAtJst: string;
  lastSuccessfulAtJst: string;
  availableDates: string[];
  categories: Record<CategorySlug, CategoryData>;
  pipeline?: {
    mode?: string;
    rubricVersion?: string;
    scoreMaximum?: number;
    evaluationRun?: {
      modelId: string;
      modelDisplayName: string;
      reasoningEffort: "ultra";
      modelSelectionVerified: true;
      runId: string;
    };
  };
};

export type DashboardDataIndex = {
  schemaVersion: "1.1" | "1.2" | "1.3";
  latestDate: string;
  availableDates: string[];
  generatedAtJst: string;
  lastSuccessfulAtJst: string;
};
