import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { SCORE_KEYS } from "../scripts/lib/pipeline.mjs";

test("the dashboard script compiles and exposes expandable full-rank details", () => {
  const html = readFileSync(resolve("public/index.html"), "utf8");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0]));
  assert.match(html, /<details class="paper-row"/);
  assert.match(html, /\.\/data\/reports\//);
  assert.match(html, /11位以下/);
  assert.match(html, /評価根拠/);
});

test("the dashboard renders and joins a lower-ranked report without browser-only dependencies", async () => {
  const html = readFileSync(resolve("public/index.html"), "utf8");
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  const index = JSON.parse(readFileSync(resolve("public/data/index.json"), "utf8"));
  const reportDate = index.availableDates.find((date) => {
    const candidate = JSON.parse(readFileSync(resolve("data/reports", `${date}-hep-th.json`), "utf8"));
    return candidate.papers.length > 10;
  });
  assert.ok(reportDate, "an archived hep-th edition must exercise lower-ranked details");
  const report = JSON.parse(readFileSync(resolve("data/reports", `${reportDate}-hep-th.json`), "utf8"));
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
  assert.match(elements["#app"].innerHTML, /hep-th 上位10件/);
  assert.match(elements["#app"].innerHTML, /11位以下/);

  const lower = report.papers[10];
  await context.loadReport("hep-th", lower.arxivId);
  assert.match(elements["#app"].innerHTML, new RegExp(lower.titleJa.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const detail = context.paperDetail(lower, { ...lower, eminentAuthors: [] });
  assert.match(detail, /Abstract/);
  assert.match(detail, /Curiosity/);
  assert.match(detail, /Concept/);
  assert.match(detail, /Conclusion/);
  assert.match(detail, /評定/);
  assert.match(detail, /評価根拠/);

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
