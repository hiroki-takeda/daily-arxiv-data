import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  PUBLISHED_PROSE_CORRECTION_CONFIRMATION,
  applyPublishedProseCorrection,
} from "../scripts/apply-published-prose-correction.mjs";
import { mergeEditionTransactionally, serializeJson } from "../scripts/lib/pipeline.mjs";
import { CATEGORIES } from "../scripts/lib/pipeline.mjs";
import { validReportSet, validRun, writeBaseRoot } from "./helpers.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(REPOSITORY_ROOT, "scripts", "apply-published-prose-correction.mjs");
const OLD_DATE = "2099-01-05";
const LATEST_DATE = "2099-01-06";

function applyCorrection(options) {
  return applyPublishedProseCorrection({
    ...options,
    confirmation: PUBLISHED_PROSE_CORRECTION_CONFIRMATION,
  });
}

function writeReportSet(root, date, reports) {
  const directory = resolve(root, "data/reports");
  mkdirSync(directory, { recursive: true });
  for (const slug of CATEGORIES) {
    writeFileSync(resolve(directory, `${date}-${slug}.json`), serializeJson(reports[slug]));
  }
}

function historyFixture() {
  const outer = mkdtempSync(resolve(tmpdir(), "daily-arxiv-published-prose-"));
  const root = resolve(outer, "repository");
  mkdirSync(root);
  writeBaseRoot(root);
  const oldReports = validReportSet({ date: OLD_DATE, run: validRun() });
  writeReportSet(root, OLD_DATE, oldReports);
  mergeEditionTransactionally({ root, date: OLD_DATE });

  const latestRun = { ...validRun(), runId: "run-2099-01-06-fixture" };
  const latestReports = validReportSet({ date: LATEST_DATE, run: latestRun });
  writeReportSet(root, LATEST_DATE, latestReports);
  mergeEditionTransactionally({ root, date: LATEST_DATE });
  return { outer, root, oldReports, latestReports };
}

function correctionInput({ outer, reports, category = "quant-ph", mutate }) {
  const corrected = structuredClone(reports[category]);
  mutate(corrected);
  const path = resolve(outer, `corrected-${category}-${Date.now()}-${Math.random()}.json`);
  writeFileSync(path, serializeJson(corrected));
  return { corrected, path };
}

test("manual published correction updates exactly one report and one historical edition", () => {
  const { outer, root, oldReports } = historyFixture();
  const currentPath = resolve(root, "public/data/current.json");
  const indexPath = resolve(root, "public/data/index.json");
  const latestEditionPath = resolve(root, `public/data/${LATEST_DATE}.json`);
  const otherReportPath = resolve(root, `data/reports/${OLD_DATE}-gr-qc.json`);
  const protectedBefore = new Map([
    [currentPath, readFileSync(currentPath)],
    [indexPath, readFileSync(indexPath)],
    [latestEditionPath, readFileSync(latestEditionPath)],
    [otherReportPath, readFileSync(otherReportPath)],
  ]);
  const { corrected, path } = correctionInput({
    outer,
    reports: oldReports,
    mutate(report) {
      report.papers.forEach((paper, index) => {
        paper.titleJa = `過去版修正版論文第${index + 1}号`;
      });
      report.papers[0].assessment = "有限温度で得た量子相関の制御則は有用だが、独立雑音への適用範囲は限定される。";
      report.papers[10].concept = "補助変数を消去して境界応答を直接計算する。";
    },
  });

  const result = applyCorrection({
    root,
    date: OLD_DATE,
    category: "quant-ph",
    correctedReportPath: path,
  });
  assert.equal(result.changed, true);
  assert.deepEqual(
    result.paths.map((entry) => resolve(entry)).sort(),
    [
      resolve(realpathSync(root), `data/reports/${OLD_DATE}-quant-ph.json`),
      resolve(realpathSync(root), `public/data/${OLD_DATE}.json`),
    ].sort(),
  );

  const storedReport = JSON.parse(readFileSync(resolve(root, `data/reports/${OLD_DATE}-quant-ph.json`), "utf8"));
  assert.deepEqual(storedReport, corrected);
  assert.equal(storedReport.papers[10].concept, corrected.papers[10].concept, "rank 11 detail remains available in the report");
  const storedEdition = JSON.parse(readFileSync(resolve(root, `public/data/${OLD_DATE}.json`), "utf8"));
  const publicPapers = [
    ...storedEdition.categories["quant-ph"].topPapers,
    ...storedEdition.categories["quant-ph"].otherPapers,
  ];
  assert.deepEqual(
    publicPapers.map((paper) => paper.titleJa),
    corrected.papers.map((paper) => paper.titleJa),
    "the dated public projection is refreshed through every rank",
  );
  assert.equal(storedEdition.categories["quant-ph"].topPapers[0].assessment, corrected.papers[0].assessment);
  for (const [protectedPath, before] of protectedBefore) {
    assert.equal(readFileSync(protectedPath).equals(before), true, protectedPath);
  }
});

test("manual published correction rejects paperType and every non-prose mutation", () => {
  for (const mutate of [
    (report) => { report.papers[0].paperType = "実験"; },
    (report) => { report.papers[0].scores.originality -= 1; report.papers[0].totalScore -= 1; },
    (report) => { report.papers[0].fullTextEvaluated = false; },
    (report) => { report.audit.generatedAtJst = "2099-01-05T13:00:00+09:00"; },
  ]) {
    const { outer, root, oldReports } = historyFixture();
    const targetReport = resolve(root, `data/reports/${OLD_DATE}-quant-ph.json`);
    const targetEdition = resolve(root, `public/data/${OLD_DATE}.json`);
    const beforeReport = readFileSync(targetReport);
    const beforeEdition = readFileSync(targetEdition);
    const { path } = correctionInput({
      outer,
      reports: oldReports,
      mutate(report) {
        report.papers[0].titleJa = "許可された文章修正を含む検証論文";
        mutate(report);
      },
    });
    assert.throws(
      () => applyCorrection({ root, date: OLD_DATE, category: "quant-ph", correctedReportPath: path }),
      /not in the published prose-correction allowlist/,
    );
    assert.equal(readFileSync(targetReport).equals(beforeReport), true);
    assert.equal(readFileSync(targetEdition).equals(beforeEdition), true);
  }
});

test("manual published correction validates corrected prose before writing", () => {
  const { outer, root, oldReports } = historyFixture();
  const targetReport = resolve(root, `data/reports/${OLD_DATE}-quant-ph.json`);
  const targetEdition = resolve(root, `public/data/${OLD_DATE}.json`);
  const beforeReport = readFileSync(targetReport);
  const beforeEdition = readFileSync(targetEdition);
  const { path } = correctionInput({
    outer,
    reports: oldReports,
    mutate(report) { report.papers[0].concept = "有限系の応答を解析。"; },
  });
  assert.throws(
    () => applyCorrection({ root, date: OLD_DATE, category: "quant-ph", correctedReportPath: path }),
    /missing sahen inflection/,
  );
  assert.equal(readFileSync(targetReport).equals(beforeReport), true);
  assert.equal(readFileSync(targetEdition).equals(beforeEdition), true);
});

test("manual published correction can repair its one pre-existing latest-gate violation", () => {
  const { outer, root, oldReports } = historyFixture();
  const reportPath = resolve(root, `data/reports/${OLD_DATE}-quant-ph.json`);
  const editionPath = resolve(root, `public/data/${OLD_DATE}.json`);
  const invalidReport = JSON.parse(readFileSync(reportPath, "utf8"));
  const invalidEdition = JSON.parse(readFileSync(editionPath, "utf8"));
  invalidReport.papers[0].scoreReasons.technicalStrength =
    "三準位緩和fitと光子数校正により、検査中の緩和率と測定誤差を定量化した。";
  invalidEdition.categories["quant-ph"].topPapers[0].scoreReasons.technicalStrength =
    invalidReport.papers[0].scoreReasons.technicalStrength;
  writeFileSync(reportPath, serializeJson(invalidReport));
  writeFileSync(editionPath, serializeJson(invalidEdition));

  const { path } = correctionInput({
    outer,
    reports: { ...oldReports, "quant-ph": invalidReport },
    mutate(report) {
      report.papers[0].scoreReasons.technicalStrength =
        "三準位緩和のフィットと光子数校正により、検査中の緩和率と測定誤差を定量化した。";
    },
  });
  assert.doesNotThrow(() => applyCorrection({
    root,
    date: OLD_DATE,
    category: "quant-ph",
    correctedReportPath: path,
  }));
  const stored = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.match(stored.papers[0].scoreReasons.technicalStrength, /フィット/);
});

test("manual published correction never exempts a different invalid category", () => {
  const { outer, root, oldReports } = historyFixture();
  const reportPath = resolve(root, `data/reports/${OLD_DATE}-gr-qc.json`);
  const editionPath = resolve(root, `public/data/${OLD_DATE}.json`);
  const invalidReport = JSON.parse(readFileSync(reportPath, "utf8"));
  const invalidEdition = JSON.parse(readFileSync(editionPath, "utf8"));
  invalidReport.papers[0].scoreReasons.technicalStrength =
    "三準位緩和fitと光子数校正により、検査中の緩和率と測定誤差を定量化した。";
  invalidEdition.categories["gr-qc"].topPapers[0].scoreReasons.technicalStrength =
    invalidReport.papers[0].scoreReasons.technicalStrength;
  writeFileSync(reportPath, serializeJson(invalidReport));
  writeFileSync(editionPath, serializeJson(invalidEdition));
  const { path } = correctionInput({
    outer,
    reports: oldReports,
    mutate(report) { report.papers[0].titleJa = "対象カテゴリだけを直す修正版論文"; },
  });
  assert.throws(
    () => applyCorrection({ root, date: OLD_DATE, category: "quant-ph", correctedReportPath: path }),
    /general English prose term "fit"/,
  );
});

test("manual published correction is historical-only so current and index stay immutable", () => {
  const { outer, root, latestReports } = historyFixture();
  const { path } = correctionInput({
    outer,
    reports: latestReports,
    mutate(report) { report.papers[0].titleJa = "最新号の文章修正候補"; },
  });
  assert.throws(
    () => applyCorrection({ root, date: LATEST_DATE, category: "quant-ph", correctedReportPath: path }),
    /historical-only.*current\.json must remain unchanged/,
  );
});

test("manual published correction rolls both targets back after a partial write", () => {
  const { outer, root, oldReports } = historyFixture();
  const targetReport = resolve(root, `data/reports/${OLD_DATE}-quant-ph.json`);
  const targetEdition = resolve(root, `public/data/${OLD_DATE}.json`);
  const beforeReport = readFileSync(targetReport);
  const beforeEdition = readFileSync(targetEdition);
  const { path } = correctionInput({
    outer,
    reports: oldReports,
    mutate(report) { report.papers[0].titleJa = "原子的更新を検証する修正版論文"; },
  });
  assert.throws(() => applyCorrection({
    root,
    date: OLD_DATE,
    category: "quant-ph",
    correctedReportPath: path,
    transactionOptions: { failAfterWrites: 1 },
  }), /injected transactional write failure/);
  assert.equal(readFileSync(targetReport).equals(beforeReport), true);
  assert.equal(readFileSync(targetEdition).equals(beforeEdition), true);
});

test("manual published correction CLI requires the explicit prose-only confirmation", () => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--confirm-published-prose-only/);
});

test("manual published correction API also requires the explicit prose-only confirmation", () => {
  assert.throws(
    () => applyPublishedProseCorrection(),
    /requires the explicit --confirm-published-prose-only confirmation/,
  );
});

test("manual published correction rejects a symlink root and hard-linked target", () => {
  {
    const { outer, root, oldReports } = historyFixture();
    const rootLink = resolve(outer, "repository-link");
    symlinkSync(root, rootLink);
    const { path } = correctionInput({
      outer,
      reports: oldReports,
      mutate(report) { report.papers[0].titleJa = "シンボリックリンク拒否を確認する論文"; },
    });
    assert.throws(
      () => applyCorrection({ root: rootLink, date: OLD_DATE, category: "quant-ph", correctedReportPath: path }),
      /Repository root must be a real directory/,
    );
  }
  {
    const { outer, root, oldReports } = historyFixture();
    const target = resolve(root, `data/reports/${OLD_DATE}-quant-ph.json`);
    linkSync(target, resolve(outer, "target-hardlink.json"));
    const { path } = correctionInput({
      outer,
      reports: oldReports,
      mutate(report) { report.papers[0].titleJa = "ハードリンク拒否を確認する論文"; },
    });
    assert.throws(
      () => applyCorrection({ root, date: OLD_DATE, category: "quant-ph", correctedReportPath: path }),
      /Target report must have exactly one hard link/,
    );
  }
});
