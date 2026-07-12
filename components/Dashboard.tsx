"use client";

import {
  Award,
  BookOpen,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Clock3,
  ExternalLink,
  RefreshCw,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getDemoDashboard } from "@/lib/demo-data";
import { CATEGORY_ORDER, type CategorySlug, type DashboardData, type DashboardDataIndex, type Paper } from "@/lib/types";

const CACHE_KEY = "daily-arxiv:last-successful-data";
const SCROLL_KEY = "daily-arxiv:scroll-position";

const categoryMeta: Record<CategorySlug, { short: string; description: string }> = {
  "hep-th": { short: "HEP–TH", description: "High Energy Physics — Theory" },
  "gr-qc": { short: "GR–QC", description: "General Relativity & Quantum Cosmology" },
  "quant-ph": { short: "QUANT–PH", description: "Quantum Physics" },
};

function todayJst() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
}

function formatDateJa(value: string) {
  const date = new Date(`${value}T12:00:00+09:00`);
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(date);
}

function formatTimestamp(value: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date)} JST`;
}

function formatCountdown(seconds: number) {
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function nextScheduledReload() {
  const dateParts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const candidates = [
    Date.parse(`${dateParts}T11:15:00+09:00`),
    Date.parse(`${dateParts}T15:15:00+09:00`),
  ];
  const now = Date.now();
  const nextToday = candidates.find((value) => value > now);
  if (nextToday) return nextToday;
  const tomorrow = new Date(Date.parse(`${dateParts}T12:00:00+09:00`) + 24 * 60 * 60 * 1000);
  const tomorrowDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(tomorrow);
  return Date.parse(`${tomorrowDate}T11:15:00+09:00`);
}

function scoreMaximum(paper: Paper) {
  return Number.isFinite(paper.scores.technicalStrength) ? 100 : 80;
}

function authorsLabel(authors: string[]) {
  if (authors.length <= 4) return authors.join(", ");
  return `${authors.slice(0, 3).join(", ")} ほか${authors.length - 3}名`;
}

function StatusBadge({ data, stale }: { data: DashboardData; stale: boolean }) {
  const status = stale ? "error" : data.status;
  const label = stale
    ? "前回データ"
    : status === "ok"
      ? "正常"
      : status === "partial"
        ? "暫定"
        : status === "updating"
          ? "更新中"
          : "更新エラー";
  return (
    <span className={`status-badge status-${status}`}>
      <span className="status-dot" />
      {label}
    </span>
  );
}

function ScoreBars({ paper }: { paper: Paper }) {
  const modern = Number.isFinite(paper.scores.technicalStrength);
  const componentMaximum = modern ? 25 : 20;
  const rows: ReadonlyArray<readonly [string, string, number]> = modern
    ? [
        ["全体的重要度", "物理学全体へのインパクト・波及範囲", paper.scores.broadImpact],
        ["カテゴリ重要度", "当該カテゴリ内での重要度・インパクト", paper.scores.categoryImpact],
        ["独創性", "問い・結果の非自明度、概念的・技術的新規性", paper.scores.originality],
        [
          "方法・結果の説得力",
          paper.fullTextEvaluated
            ? "PDF本文から確認した方法の明確さ・検証の強さ・結果の具体性"
            : "Abstractから確認できる方法の明確さ・検証の強さ・結果の具体性",
          paper.scores.technicalStrength ?? 0,
        ],
      ]
    : [
        ["全体的重要度", "旧方式アーカイブ", paper.scores.broadImpact],
        ["カテゴリ重要度", "旧方式アーカイブ", paper.scores.categoryImpact],
        ["独創性", "旧方式アーカイブ", paper.scores.originality],
        ["著者点（旧方式）", "現在のランキングでは廃止済み", paper.scores.authorAuthority ?? 0],
      ];

  return (
    <div className="score-panel" aria-label="評価項目">
      {rows.map(([label, description, score]) => (
        <div className="score-row" key={label}>
          <div className="score-label-wrap">
            <span className="score-label">{label}</span>
            <span className="score-description">{description}</span>
          </div>
          <div className="score-track" aria-hidden="true">
            <span style={{ width: `${score / componentMaximum * 100}%` }} />
          </div>
          <strong>{score}<small>/{componentMaximum}</small></strong>
        </div>
      ))}
    </div>
  );
}

function PaperDetail({ paper, sourceMode }: { paper: Paper; sourceMode: DashboardData["sourceMode"] }) {
  const maximum = scoreMaximum(paper);
  const evaluationLabel = paper.evaluationBasis === "title_authors_abstract"
    ? "タイトル・著者・要旨評価"
    : paper.fullTextEvaluated
      ? "全文抽出・主要節確認"
      : sourceMode === "demo"
        ? "デモ評定"
        : "タイトル・著者・要旨評価";
  return (
    <article className="paper-detail" id={`paper-${paper.arxivId}`}>
      <div className="paper-detail-top">
        <div className="rank-medallion" aria-label={`${paper.rank}位`}>
          <span>RANK</span>
          <strong>{String(paper.rank).padStart(2, "0")}</strong>
        </div>
        <div className="paper-heading">
          <div className="paper-flags">
            <span className="paper-type">{paper.paperType}</span>
            <span>{paper.primaryCategory}</span>
            <span className={sourceMode === "demo" ? "basis-demo" : "basis-ok"}>
              {sourceMode === "demo" ? <ShieldAlert size={15} /> : <CircleCheck size={15} />}
              {evaluationLabel}
            </span>
            {paper.eminentAuthors?.map((item) => (
              <span className="eminent-flag" key={`${paper.arxivId}-${item.authorName}`}>
                <Award size={15} /> {item.label}: {item.authorName}
              </span>
            ))}
          </div>
          <h2>{paper.title}</h2>
          <p className="title-ja">{paper.titleJa}</p>
          <p className="authors">{authorsLabel(paper.authors)}</p>
          {paper.url ? (
            <a className="arxiv-link" href={paper.url} target="_blank" rel="noreferrer">
              arXiv:{paper.arxivId} <ExternalLink size={16} />
            </a>
          ) : (
            <span className="arxiv-link disabled">{paper.arxivId}</span>
          )}
        </div>
        <div className="hero-score">
          <span>TOTAL SCORE</span>
          <strong>{paper.totalScore}</strong>
          <small>/ {maximum}</small>
        </div>
      </div>

      <ScoreBars paper={paper} />

      {paper.fullTextEvaluated && paper.fullTextReviewStatus ? (
        <section className="fulltext-review">
          <BookOpen size={20} />
          <div>
            <div className="section-kicker">FULL-TEXT REVIEW</div>
            <h3>PDF全文確認済み</h3>
            <p>{paper.fullTextReviewStatus}</p>
          </div>
        </section>
      ) : null}

      {paper.eminentAuthors?.length ? (
        <section className="eminent-authors">
          <div>
            <div className="section-kicker">EMINENT AUTHOR · NON-SCORING</div>
            <h3>著名著者マーク（総合点には不使用）</h3>
          </div>
          <div className="eminent-author-list">
            {paper.eminentAuthors.map((item) => (
              <article key={`${paper.arxivId}-${item.authorName}-badge`}>
                <Award size={20} />
                <div>
                  <strong>{item.authorName}</strong>
                  <p>{item.reason}</p>
                  <small>本人同定: {item.identityEvidence}</small>
                  <div className="authority-links">
                    {item.evidenceUrls.map((url, index) => (
                      <a key={url} href={url} target="_blank" rel="noreferrer">根拠{index + 1} <ExternalLink size={13} /></a>
                    ))}
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {!Number.isFinite(paper.scores.technicalStrength) && paper.authorAuthorityEvidence?.length ? (
        <section className="authority-evidence">
          <div>
            <div className="section-kicker">AUTHOR AUTHORITY</div>
            <h3>著者権威の根拠</h3>
            {paper.authorAuthorityRationale ? <p className="authority-summary">{paper.authorAuthorityRationale}</p> : null}
          </div>
          <div className="authority-evidence-list">
            {paper.authorAuthorityEvidence.slice(0, 3).map((item) => (
              <article key={`${paper.arxivId}-${item.authorName}`}>
                <strong>
                  {item.authorName} <small>{item.individualScore}/20 · 本人同定{Math.round((item.identityConfidence ?? 0) * 100)}%</small>
                </strong>
                <p>{item.rationale}</p>
                {item.evidenceUrls.length > 0 && (
                  <div className="authority-links">
                    {item.evidenceUrls.map((url, index) => (
                      <a key={url} href={url} target="_blank" rel="noreferrer">根拠{index + 1} <ExternalLink size={13} /></a>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <section className="abstract-block">
        <div className="section-kicker">ABSTRACT</div>
        <h3>3行要約</h3>
        <ol>
          {paper.abstractLines.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ol>
      </section>

      <div className="analysis-grid">
        <section>
          <span className="analysis-number">01</span>
          <div className="section-kicker">CURIOSITY</div>
          <h3>背景と問題設定</h3>
          <p>{paper.curiosity}</p>
        </section>
        <section>
          <span className="analysis-number">02</span>
          <div className="section-kicker">CONCEPT</div>
          <h3>中心アイデアと評価方法</h3>
          <p>{paper.concept}</p>
        </section>
        <section>
          <span className="analysis-number">03</span>
          <div className="section-kicker">CONCLUSION</div>
          <h3>主結果と残された問題</h3>
          <p>{paper.conclusion}</p>
        </section>
      </div>

      <section className="assessment-block">
        <Sparkles size={21} />
        <div>
          <div className="section-kicker">ASSESSMENT</div>
          <h3>評定</h3>
          <p>{paper.assessment}</p>
        </div>
      </section>
    </article>
  );
}

export function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [activeCategory, setActiveCategory] = useState<CategorySlug>("hep-th");
  const [selectedPaperId, setSelectedPaperId] = useState<string>("");
  const [selectedDate, setSelectedDate] = useState(todayJst());
  const [nextReloadAt] = useState(nextScheduledReload);
  const [remaining, setRemaining] = useState(() => Math.max(0, Math.ceil((nextReloadAt - Date.now()) / 1000)));
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const rememberView = useCallback(() => {
    sessionStorage.setItem(SCROLL_KEY, String(window.scrollY));
  }, []);

  const reloadLatest = useCallback(() => {
    rememberView();
    const url = new URL(window.location.href);
    url.searchParams.delete("date");
    url.searchParams.delete("paper");
    window.location.replace(`${url.pathname}${url.search}${url.hash}`);
  }, [rememberView]);

  const loadData = useCallback(async (date: string, preferredPaper?: string, preferredCategory?: CategorySlug) => {
    setLoading(true);
    setErrorMessage("");
    try {
      const dataBase = process.env.NEXT_PUBLIC_DAILY_ARXIV_DATA_BASE_URL?.trim().replace(/\/$/, "");
      const endpoint = process.env.NEXT_PUBLIC_DAILY_ARXIV_DATA_URL?.trim();
      let nextData: DashboardData;
      if (dataBase) {
        const cacheBust = String(Date.now());
        const indexResponse = await fetch(`${dataBase}/index.json?ts=${cacheBust}`, { cache: "no-store" });
        if (!indexResponse.ok) throw new Error(`データ索引の取得に失敗しました (${indexResponse.status})`);
        const index = (await indexResponse.json()) as DashboardDataIndex;
        const targetDate = index.availableDates.includes(date) ? date : index.latestDate;
        const response = await fetch(`${dataBase}/${targetDate}.json?ts=${cacheBust}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`データ取得に失敗しました (${response.status})`);
        nextData = (await response.json()) as DashboardData;
        nextData.availableDates = index.availableDates;
        nextData.lastSuccessfulAtJst = index.lastSuccessfulAtJst;
      } else if (endpoint) {
        const url = new URL(endpoint);
        url.searchParams.set("date", date);
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) throw new Error(`データ取得に失敗しました (${response.status})`);
        nextData = (await response.json()) as DashboardData;
      } else {
        const cacheBust = String(Date.now());
        const indexResponse = await fetch(`/data/index.json?ts=${cacheBust}`, { cache: "no-store" });
        if (indexResponse.ok) {
          const index = (await indexResponse.json()) as DashboardDataIndex;
          const targetDate = index.availableDates.includes(date) ? date : index.latestDate;
          const response = await fetch(`/data/${targetDate}.json?ts=${cacheBust}`, { cache: "no-store" });
          if (!response.ok) throw new Error(`データ取得に失敗しました (${response.status})`);
          nextData = (await response.json()) as DashboardData;
          nextData.availableDates = index.availableDates;
          nextData.lastSuccessfulAtJst = index.lastSuccessfulAtJst;
        } else {
          const response = await fetch(`/data/${date}.json?ts=${cacheBust}`, { cache: "no-store" });
          nextData = response.ok
            ? (await response.json()) as DashboardData
            : getDemoDashboard(date);
        }
      }
      setData(nextData);
      setSelectedDate(nextData.date);
      setStale(false);
      const selectionCategory = preferredCategory ?? activeCategory;
      const firstPaper = nextData.categories[selectionCategory]?.topPapers[0];
      const requested = nextData.categories[selectionCategory]?.topPapers.find((paper) => paper.arxivId === preferredPaper);
      setSelectedPaperId(requested?.arxivId ?? firstPaper?.arxivId ?? "");
      if (nextData.sourceMode === "live" && nextData.status === "ok") {
        localStorage.setItem(CACHE_KEY, JSON.stringify(nextData));
      }
    } catch (error) {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) {
        const cachedData = JSON.parse(cached) as DashboardData;
        setData(cachedData);
        setStale(true);
        setErrorMessage("最新データを取得できないため、前回正常更新時点の内容を表示しています。");
        setSelectedPaperId(cachedData.categories[activeCategory]?.topPapers[0]?.arxivId ?? "");
      } else {
        setErrorMessage(error instanceof Error ? error.message : "データを取得できませんでした。");
      }
    } finally {
      setLoading(false);
    }
  }, [activeCategory]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const category = params.get("category") as CategorySlug | null;
    const date = params.get("date") || todayJst();
    const paper = params.get("paper") || undefined;
    if (category && CATEGORY_ORDER.includes(category)) setActiveCategory(category);
    setSelectedDate(date);
    void loadData(date, paper, category && CATEGORY_ORDER.includes(category) ? category : undefined);
    const scroll = sessionStorage.getItem(SCROLL_KEY);
    if (scroll) requestAnimationFrame(() => window.scrollTo(0, Number(scroll)));
    sessionStorage.removeItem(SCROLL_KEY);
    // Initial state is intentionally read from the URL once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const seconds = Math.ceil((nextReloadAt - Date.now()) / 1000);
      if (seconds <= 0) {
        reloadLatest();
        return;
      }
      setRemaining(seconds);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [nextReloadAt, reloadLatest]);

  useEffect(() => {
    if (!data) return;
    const params = new URLSearchParams(window.location.search);
    const latestDate = [...data.availableDates].sort().reverse()[0];
    if (selectedDate === latestDate) params.delete("date");
    else params.set("date", selectedDate);
    params.set("category", activeCategory);
    if (selectedPaperId) params.set("paper", selectedPaperId);
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
  }, [activeCategory, data, selectedDate, selectedPaperId]);

  const category = data?.categories[activeCategory] ?? null;
  const selectedPaper = useMemo(
    () => category?.topPapers.find((paper) => paper.arxivId === selectedPaperId) ?? category?.topPapers[0] ?? null,
    [category, selectedPaperId],
  );
  const categoryMaximum = category?.topPapers[0] ? scoreMaximum(category.topPapers[0]) : 100;

  const switchCategory = (slug: CategorySlug) => {
    setActiveCategory(slug);
    setSelectedPaperId(data?.categories[slug].topPapers[0]?.arxivId ?? "");
  };

  const navigateArchive = (direction: "newer" | "older") => {
    if (!data) return;
    const dates = [...data.availableDates].sort().reverse();
    const index = dates.indexOf(selectedDate);
    const target = direction === "older" ? dates[index + 1] : dates[index - 1];
    if (target) void loadData(target);
  };

  const refreshNow = () => {
    rememberView();
    window.location.reload();
  };

  if (!data && loading) {
    return (
      <main className="loading-screen">
        <div className="loading-mark"><BookOpen size={34} /></div>
        <h1>Daily arXiv</h1>
        <p>本日の論文データを読み込んでいます…</p>
        <div className="loading-line"><span /></div>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="loading-screen error-screen">
        <ShieldAlert size={42} />
        <h1>データを表示できません</h1>
        <p>{errorMessage}</p>
        <button onClick={refreshNow}><RefreshCw size={18} />再読み込み</button>
      </main>
    );
  }

  return (
    <div className="dashboard-shell" data-category={activeCategory}>
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-icon"><BookOpen size={23} /></div>
          <div>
            <div className="brand-title">DAILY <em>arXiv</em></div>
            <div className="brand-subtitle">RESEARCH INTELLIGENCE DISPLAY</div>
          </div>
        </div>
        <div className="topbar-center">
          <span className={selectedDate === todayJst() ? "live-tag" : "archive-tag"}>
            {selectedDate === todayJst() ? "TODAY / LIVE" : "ARCHIVE"}
          </span>
          {data.sourceMode === "demo" && <span className="demo-tag">DEMO DATA</span>}
        </div>
        <div className="update-cluster">
          <StatusBadge data={data} stale={stale} />
          <div className="timestamp-pair">
            <span>最終更新 <strong>{formatTimestamp(data.generatedAtJst)}</strong></span>
            <span>前回正常 <strong>{formatTimestamp(data.lastSuccessfulAtJst)}</strong></span>
          </div>
          <button className="refresh-button" onClick={refreshNow} aria-label="今すぐ再読み込み">
            <RefreshCw size={18} />
            <span className={remaining <= 10 ? "countdown urgent" : "countdown"}>{formatCountdown(remaining)}</span>
          </button>
        </div>
      </header>

      {(data.sourceMode === "demo" || stale || data.status !== "ok") && (
        <div className={`notice-bar ${stale ? "notice-error" : ""}`}>
          <ShieldAlert size={17} />
          <strong>{stale ? errorMessage : data.statusMessage}</strong>
        </div>
      )}

      <nav className="date-nav" aria-label="日付ナビゲーション">
        <button onClick={() => navigateArchive("older")} disabled={!data.availableDates.some((date) => date < selectedDate)}>
          <ChevronLeft size={19} /> 前の発表日
        </button>
        <label className="date-display">
          <CalendarDays size={20} />
          <span>{formatDateJa(selectedDate)}</span>
          <input
            type="date"
            value={selectedDate}
            max={todayJst()}
            onChange={(event) => event.target.value && void loadData(event.target.value)}
            aria-label="日付を選択"
          />
        </label>
        <button onClick={() => navigateArchive("newer")} disabled={!data.availableDates.some((date) => date > selectedDate)}>
          次の発表日 <ChevronRight size={19} />
        </button>
      </nav>

      <nav className="category-tabs" aria-label="arXivカテゴリ">
        {CATEGORY_ORDER.map((slug) => {
          const item = data.categories[slug];
          return (
            <button key={slug} className={activeCategory === slug ? "active" : ""} onClick={() => switchCategory(slug)}>
              <span className="tab-accent" />
              <span className="tab-name">{categoryMeta[slug].short}</span>
              <span className="tab-description">{categoryMeta[slug].description}</span>
              <span className="tab-stat"><strong>{item.totalNew}</strong> new</span>
              <span className="tab-best">
                BEST {item.topPapers[0]?.totalScore ?? "—"}/{item.topPapers[0] ? scoreMaximum(item.topPapers[0]) : 100}
              </span>
            </button>
          );
        })}
      </nav>

      <div className="category-summary">
        <div>
          <span className="eyebrow">TODAY&apos;S RANKING</span>
          <h1>{activeCategory}</h1>
          <p>{categoryMeta[activeCategory].description}</p>
          {categoryMaximum === 100 ? (
            <p className="badge-note">★ 著名著者マークは非加点・非網羅的です。マークなしは著名でないことを意味しません。</p>
          ) : null}
        </div>
        <div className="summary-stats">
          <span>
            <strong>{data.pipeline?.evaluationRun?.modelDisplayName ?? "未記録"}</strong>
            評価モデル
          </span>
          <span><strong>{category?.evaluatedCount ?? 0}</strong> 評価済み</span>
          {categoryMaximum === 100 ? (
            <>
              <span><strong>{category?.fullTextEvaluatedCount ?? 0}</strong> PDF全文確認</span>
              <span><strong>{category?.eminentAuthorPaperCount ?? category?.topPapers.filter((paper) => paper.eminentAuthors?.length).length ?? 0}</strong> 著名著者マーク</span>
            </>
          ) : (
            <span><strong>旧方式</strong> 80点満点</span>
          )}
          <span><strong>{category?.crosslistsExcluded ?? 0}</strong> cross-list除外</span>
          <span><strong>TOP 10</strong> 総合点順</span>
        </div>
      </div>

      <main className="dashboard-grid">
        <aside className="ranking-panel" aria-label={`${activeCategory}ランキング`}>
          <div className="ranking-head">
            <span>順位</span><span>論文</span><span>総合点</span>
          </div>
          <div className="ranking-list">
            {category?.topPapers.map((paper) => (
              <button
                key={paper.arxivId}
                className={selectedPaper?.arxivId === paper.arxivId ? "ranking-item selected" : "ranking-item"}
                onClick={() => setSelectedPaperId(paper.arxivId)}
              >
                <span className={`rank-number rank-${paper.rank}`}>{String(paper.rank).padStart(2, "0")}</span>
                <span className="rank-paper">
                  <strong>{paper.title}</strong>
                  <small>
                    {paper.paperType} · {authorsLabel(paper.authors)}
                    {paper.eminentAuthors?.length ? ` · ★ ${paper.eminentAuthors.map((item) => item.authorName).join(", ")}` : ""}
                  </small>
                </span>
                <span className="rank-score"><strong>{paper.totalScore}</strong><small>/{scoreMaximum(paper)}</small></span>
              </button>
            ))}
          </div>
          <div className="ranking-foot">
            <span>{categoryMaximum === 100 ? "評価基準 v2.0 · 4項目×25点" : "旧評価基準アーカイブ"}</span>
            <span>{categoryMaximum === 100 ? "同点: 全体的重要度 → 独創性 → 説得力 → arXiv ID" : "旧方式（著者点を含む）"}</span>
          </div>
        </aside>

        <section className="detail-column">
          {loading && <div className="inline-loading"><RefreshCw size={17} />データ更新中</div>}
          {selectedPaper ? (
            <PaperDetail paper={selectedPaper} sourceMode={data.sourceMode} />
          ) : (
            <div className="empty-state">本日の評価済み論文はありません。</div>
          )}

          <section className="other-papers">
            <div className="other-heading">
              <div>
                <span className="eyebrow">BEYOND TOP 10</span>
                <h2>上位外の論文</h2>
              </div>
              <span>{category?.otherPapers.length ?? 0} papers shown</span>
            </div>
            <div className="other-table-wrap">
              <table>
                <thead><tr><th>順位</th><th>総合点</th><th>Title / Authors</th><th>Type</th><th>arXiv</th></tr></thead>
                <tbody>
                  {category?.otherPapers.map((paper) => (
                    <tr key={paper.arxivId}>
                      <td>#{paper.rank}</td>
                      <td><strong>{paper.totalScore}</strong><small>/{categoryMaximum}</small></td>
                      <td>
                        <span>{paper.title}</span>
                        <small>
                          {authorsLabel(paper.authors)}
                          {paper.eminentAuthors?.length ? ` · ★ ${paper.eminentAuthors.map((item) => item.authorName).join(", ")}` : ""}
                        </small>
                      </td>
                      <td><span className="paper-type">{paper.paperType}</span></td>
                      <td>{paper.url ? <a href={paper.url} target="_blank" rel="noreferrer">{paper.arxivId}</a> : paper.arxivId}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </section>
      </main>

      <footer>
        <span>DAILY arXiv · Research Display</span>
        <span><Clock3 size={15} />上位10件はPDF全文確認 · 11:15・15:15に自動再読み込み</span>
        <span>日時はすべて日本標準時（JST）</span>
      </footer>
    </div>
  );
}
