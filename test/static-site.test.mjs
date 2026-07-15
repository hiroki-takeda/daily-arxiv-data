import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { SCORE_KEYS } from "../scripts/lib/pipeline.mjs";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#39;",
})[character]);
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("the dashboard script compiles and exposes expandable full-rank details", () => {
  const html = readFileSync(resolve("public/index.html"), "utf8");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0]));
  assert.match(html, /<details class="paper-row/);
  assert.match(html, /\.\/data\/reports\//);
  assert.match(html, /11位以下/);
  assert.doesNotMatch(html, /選択して詳細を表示/);
  assert.doesNotMatch(html, />詳細表示</);
  assert.match(html, /paper-original-title/);
  assert.match(html, /detail-toolbar/);
  assert.match(html, /detail-meta/);
  assert.match(html, /\.row-badges \.badge\.kind\{display:none\}/);
  assert.match(html, /\.detail-meta\{display:flex\}/);
  assert.match(html, /\.detail-meta \.badge\.star\{display:inline-flex\}/);
  assert.doesNotMatch(html, /class="detail-heading"/);
  assert.match(html, /評価根拠/);
  assert.match(html, /評価基準/);
  for (const label of ["科学的重要性", "分野への貢献", "独創性", "厳密性・信頼性"]) {
    assert.match(html, new RegExp(label));
  }
});

test("the dashboard renders and joins a lower-ranked report without browser-only dependencies", async () => {
  const category = "quant-ph";
  const html = readFileSync(resolve("public/index.html"), "utf8");
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  const index = JSON.parse(readFileSync(resolve("public/data/index.json"), "utf8"));
  const reportDate = index.availableDates.find((date) => {
    const candidate = JSON.parse(readFileSync(resolve("data/reports", `${date}-${category}.json`), "utf8"));
    return candidate.papers.length > 10;
  });
  assert.ok(reportDate, `an archived ${category} edition must exercise lower-ranked details`);
  const report = JSON.parse(readFileSync(resolve("data/reports", `${reportDate}-${category}.json`), "utf8"));
  const elements = Object.fromEntries(["#app", "#meta", "#tabs", "#dates"].map((selector) => [selector, {
    innerHTML: "",
    addEventListener() {},
  }]));
  const storage = new Map();
  const context = {
    URL,
    CSS: { escape: (value) => String(value).replace(/[^A-Za-z0-9_.-]/g, "\\$&") },
    document: {
      title: "",
      querySelector: (selector) => elements[selector] ?? null,
      querySelectorAll: () => [],
    },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    fetch: async (request) => {
      const url = String(request);
      let path;
      if (url.includes("data/reports/")) path = resolve("data/reports", /data\/reports\/([^?]+)/.exec(url)[1]);
      else if (url.includes("index.json")) path = resolve("public/data/index.json");
      else if (url.includes("current.json")) path = resolve("public/data/current.json");
      else if (/data\/(\d{4}-\d{2}-\d{2}\.json)/.test(url)) path = resolve("public/data", /data\/(\d{4}-\d{2}-\d{2}\.json)/.exec(url)[1]);
      else throw new Error(`unexpected request ${url}`);
      return { ok: true, json: async () => JSON.parse(readFileSync(path, "utf8")) };
    },
    requestAnimationFrame: (callback) => callback(),
    setInterval: () => 0,
  };
  runInNewContext(script, context);
  for (let attempt = 0; attempt < 20 && !elements["#app"].innerHTML.includes("上位"); attempt += 1) {
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
  await context.load(`${reportDate}.json`);
  assert.match(elements["#app"].innerHTML, /quant-ph 上位10件/);
  assert.match(elements["#app"].innerHTML, /11位以下/);

  const edition = JSON.parse(readFileSync(resolve("public/data", `${reportDate}.json`), "utf8"));
  const lowerSummary = edition.categories[category].otherPapers[0];
  const pendingRow = context.paperRow(lowerSummary, "report");
  const displayedOriginalTitle = context.displayOriginalTitle(lowerSummary.title);
  assert.match(pendingRow, /<details class="paper-row pending-detail"/);
  assert.match(pendingRow, /<summary data-focus-id=/);
  assert.match(pendingRow, /class="chevron"/);
  assert.doesNotMatch(pendingRow, /選択して詳細を表示/);
  assert.doesNotMatch(pendingRow, />詳細表示</);
  if (lowerSummary.titleJa) {
    assert.match(pendingRow, new RegExp(`class="paper-title"[^>]*>${escapeRegExp(escapeHtml(lowerSummary.titleJa))}</strong>[\\s\\S]*class="paper-original-title"[^>]*>${escapeRegExp(escapeHtml(displayedOriginalTitle))}</span>[\\s\\S]*class="paper-authors"`));
  } else {
    assert.doesNotMatch(pendingRow, /class="paper-original-title"/);
  }

  const lower = report.papers[10];
  await context.loadReport(category, lower.arxivId);
  assert.match(elements["#app"].innerHTML, new RegExp(lower.titleJa.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const loadedRow = context.paperRow(lowerSummary, "report");
  assert.doesNotMatch(loadedRow, /pending-detail/);
  assert.match(loadedRow, /class="mini-scores"/);
  assert.match(loadedRow, />要旨評価<|>全文評価</);
  assert.doesNotMatch(loadedRow, /選択して詳細を表示|>詳細表示</);
  assert.match(loadedRow, new RegExp(`class="paper-title"[^>]*>${escapeRegExp(escapeHtml(lower.titleJa))}</strong><span class="paper-original-title" lang="en">${escapeRegExp(escapeHtml(context.displayOriginalTitle(lower.title)))}</span><span class="paper-authors">${escapeRegExp(escapeHtml(lower.authors.join(", ")))}</span>`));
  assert.equal((loadedRow.match(/class="paper-title"/g) ?? []).length, 1);
  assert.equal((loadedRow.match(/class="paper-original-title"/g) ?? []).length, 1);
  assert.equal((loadedRow.match(/class="paper-authors"/g) ?? []).length, 1);
  const detail = context.paperDetail(lower, { ...lower, eminentAuthors: [] });
  assert.match(detail, /class="detail-toolbar"/);
  assert.match(detail, /class="detail-meta"/);
  assert.match(detail, new RegExp(`class="badge kind">${escapeRegExp(escapeHtml(lower.paperType))}</span>`));
  assert.doesNotMatch(detail, /class="(?:detail-heading|english-title|authors|badges|scores)"|<h3>/);
  assert.doesNotMatch(detail, new RegExp(escapeRegExp(escapeHtml(lower.titleJa))));
  assert.doesNotMatch(detail, new RegExp(escapeRegExp(escapeHtml(lower.title))));
  assert.match(detail, /3行要約/);
  assert.match(detail, /着眼点/);
  assert.match(detail, /中核アイデア・方法/);
  assert.match(detail, /結論と限界/);
  assert.match(detail, /総合評定/);
  assert.match(detail, /評価根拠/);
  const displayedAssessment = context.displayAssessment(lower.assessment);
  assert.match(detail, new RegExp(displayedAssessment.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(displayedAssessment, /総合\s*\d{1,3}\s*\/\s*100/);

  const namedAuthor = lower.authors[0];
  const responsiveDetail = context.paperDetail(lower, {
    ...lower,
    eminentAuthors: [{ authorName: namedAuthor }],
  });
  assert.match(responsiveDetail, new RegExp(`class="badge star">★ ${escapeRegExp(escapeHtml(namedAuthor))}</span>`));

  const identicalTitles = { ...lower, titleJa: lower.title };
  const identicalTitleRow = context.paperRow(identicalTitles, "top");
  assert.doesNotMatch(identicalTitleRow, /class="paper-original-title"/);
  assert.equal((identicalTitleRow.match(new RegExp(escapeRegExp(escapeHtml(lower.title)), "g")) ?? []).length, 1);

  const texTitle = String.raw`Symmetry $\mathcal{PT}$ in $SU(2) \times U(1)$ with $\alpha_2^3$, phase-$\theta$ -- test`;
  const texTitleSnapshot = texTitle;
  assert.equal(context.displayOriginalTitle(texTitle), "Symmetry PT in SU(2) × U(1) with α₂³, phase-θ – test");
  assert.equal(texTitle, texTitleSnapshot, "display formatting must not mutate paper.title");
  const texPaper = { ...lower, title: texTitle, titleJa: "PT対称性と群構造の検証" };
  const texRow = context.paperRow(texPaper, "top");
  assert.match(texRow, /class="paper-original-title" lang="en">Symmetry PT in SU\(2\) × U\(1\) with α₂³, phase-θ – test<\/span>/);
  assert.doesNotMatch(texRow, /[$\\{}]|\\[A-Za-z]+/);
  assert.equal(texPaper.title, texTitle, "rendering must preserve the exact source title");
  const residualTex = context.displayOriginalTitle(String.raw`$\unknown{X} \mathbb{Q}_4 \left(2,3\right)$`);
  assert.equal(residualTex, "X Q₄ (2,3)");
  assert.doesNotMatch(residualTex, /[$\\{}]|\\[A-Za-z]+/);

  const compactLegacy = context.displayAssessment("総合84/100（物理全体23、カテゴリ22、独創性19、方法・結果20）。地平面問題・初期条件・過去完全性を同時に扱う。");
  assert.equal(compactLegacy, "地平面問題・初期条件・過去完全性を同時に扱う。");
  const slashLegacy = context.displayAssessment("総合95/100。物理全体22/25：隣接分野へ波及する。hep-th内25/25：中心課題を前進させる。独創性25/25：新しい構成を与える。方法・結果23/25：導出と限界が明確である。");
  assert.match(slashLegacy, /隣接分野へ波及する。/);
  assert.match(slashLegacy, /導出と限界が明確である。/);
  assert.doesNotMatch(slashLegacy, /(?:総合95\/100|物理全体22\/25|hep-th内25\/25|独創性25\/25|方法・結果23\/25)/);
  const pointLegacy = context.displayAssessment("総合92/100。物理全体23点：基礎問題に関わる。gr-qc内24点：中核課題へ答える。独創性24点：非自明な構成である。方法・結果21点：適用範囲に限界がある。");
  assert.match(pointLegacy, /基礎問題に関わる。/);
  assert.match(pointLegacy, /適用範囲に限界がある。/);
  assert.doesNotMatch(pointLegacy, /(?:総合92\/100|物理全体23点|gr-qc内24点|独創性24点|方法・結果21点)/);
  const narrativeAssessment = "中心成果の射程は広いが、適用範囲には明確な限界がある。";
  assert.equal(context.displayAssessment(narrativeAssessment), narrativeAssessment);
  for (const name of readdirSync(resolve("data/reports")).filter((entry) => entry.endsWith(".json"))) {
    const archived = JSON.parse(readFileSync(resolve("data/reports", name), "utf8"));
    for (const paper of archived.papers) {
      const displayed = context.displayAssessment(paper.assessment);
      assert.notEqual(displayed, "", `${name} ${paper.arxivId} displayed assessment`);
      assert.doesNotMatch(displayed, /^総合(?:評定|評価|点)?\s*[：:]?\s*\d{1,3}\s*\/\s*100/u, `${name} ${paper.arxivId} total recap`);
      assert.doesNotMatch(displayed, /(^|[。！？]\s*)(?:物理(?:学)?全体(?:への重要度・波及)?|(?:hep-th|gr-qc|quant-ph)内(?:の重要度・インパクト)?|カテゴリ|独創性|方法・結果(?:の説得力)?)\s*\d{1,2}\s*(?:\/\s*25|点)\s*[：:]/u, `${name} ${paper.arxivId} axis recap`);
    }
  }

  const scoreReasons = {
    broadImpact: "対象範囲が広く、隣接分野にも波及する。\n<script>alert(1)</script>",
    categoryImpact: "分野固有の未解決問題へ直接答える。",
    originality: "既存手法とは異なる構成を導入した。",
    technicalStrength: "本文の導出と限界を照合できる。",
  };
  const withReasons = { ...lower, scoreReasons };
  assert.doesNotThrow(() => context.validateDetailedPaper(withReasons, category));
  const reasonDetail = context.paperDetail(withReasons, { ...withReasons, eminentAuthors: [] });
  assert.equal((reasonDetail.match(/class="score-reason"/g) ?? []).length, 4);
  for (const [key, label] of [
    ["broadImpact", "科学的重要性"],
    ["categoryImpact", "分野への貢献"],
    ["originality", "独創性"],
    ["technicalStrength", "厳密性・信頼性"],
  ]) {
    assert.match(reasonDetail, new RegExp(`${label}[\\s\\S]*?${withReasons.scores[key]}/25`));
  }
  assert.match(reasonDetail, /波及する。<br>&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(reasonDetail, /<script>alert/);
  assert.match(reasonDetail, /総合評定/);

  const missingReason = structuredClone(withReasons);
  delete missingReason.scoreReasons.originality;
  assert.throws(() => context.validateDetailedPaper(missingReason, category), /invalid score reasons/);
  const extraReason = structuredClone(withReasons);
  extraReason.scoreReasons.extra = "余分な理由";
  assert.throws(() => context.validateDetailedPaper(extraReason, category), /invalid score reasons/);
  const emptyReason = structuredClone(withReasons);
  emptyReason.scoreReasons.technicalStrength = "  ";
  assert.throws(() => context.validateDetailedPaper(emptyReason, category), /invalid score reasons/);

  const versionedSources = {
    ...lower,
    url: `https://arxiv.org/abs/${lower.arxivId}`,
    sourceUrls: [
      `https://arxiv.org/abs/${lower.arxivId}v1`,
      `https://arxiv.org/pdf/${lower.arxivId}v1`,
      `https://arxiv.org/html/${lower.arxivId}v1`,
    ],
  };
  const linkedDetail = context.paperDetail(versionedSources, { ...versionedSources, eminentAuthors: [] });
  assert.match(linkedDetail, new RegExp(`>arXiv ${lower.arxivId} ↗</a>`));
  assert.equal((linkedDetail.match(/href="https:\/\/arxiv\.org\/abs\//g) ?? []).length, 1);
  assert.doesNotMatch(linkedDetail, new RegExp(`/abs/${lower.arxivId}v1`));
  assert.equal((linkedDetail.match(/>PDF ↗<\/a>/g) ?? []).length, 1);
  assert.equal((linkedDetail.match(/>HTML ↗<\/a>/g) ?? []).length, 1);
});

test("every archived report keeps displayable details for papers below rank ten", () => {
  const reportNames = readdirSync(resolve("data/reports")).filter((name) => name.endsWith(".json"));
  assert.ok(reportNames.length > 0);
  let lowerPaperCount = 0;
  for (const name of reportNames) {
    const report = JSON.parse(readFileSync(resolve("data/reports", name), "utf8"));
    for (const paper of report.papers.slice(10)) {
      lowerPaperCount += 1;
      assert.equal(typeof paper.titleJa, "string", `${name} ${paper.arxivId} titleJa`);
      assert.equal(paper.abstractLines.length, 3, `${name} ${paper.arxivId} abstractLines`);
      for (const field of ["curiosity", "concept", "conclusion", "assessment", "evaluationBasis"]) {
        assert.equal(typeof paper[field], "string", `${name} ${paper.arxivId} ${field}`);
        assert.notEqual(paper[field].trim(), "", `${name} ${paper.arxivId} ${field}`);
      }
      const total = SCORE_KEYS.reduce((sum, key) => sum + paper.scores[key], 0);
      assert.equal(paper.totalScore, total, `${name} ${paper.arxivId} score total`);
    }
  }
  assert.ok(lowerPaperCount > 0);
});

test("the Pages artifact contains only public assets plus validated reports", () => {
  const workflow = readFileSync(resolve(".github/workflows/pages-data.yml"), "utf8");
  assert.match(workflow, /cp -R public\/\. /);
  assert.match(workflow, /cp data\/reports\/\*\.json /);
  assert.match(workflow, /path: \$\{\{ runner\.temp \}\}\/daily-arxiv-site/);
});
