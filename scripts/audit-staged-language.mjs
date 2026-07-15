#!/usr/bin/env node

import { lstatSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CATEGORIES,
  assertExactStagingReports,
  parseJsonFile,
  validateDate,
  validateProductionReport,
} from "./lib/pipeline.mjs";

function fail(message) {
  throw new Error(message);
}

const FIELD_PATTERN = /^probe\.papers\[(\d+)\]\.(titleJa|paperType|curiosity|concept|conclusion|assessment|fullTextReviewStatus|abstractLines\[(\d+)\]|scoreReasons\.(broadImpact|categoryImpact|originality|technicalStrength)):/u;
const OUTPUT_NAMES = new Set(["language-issues-before.json", "language-issues-after.json"]);

function getField(paper, field, lineIndex, scoreKey) {
  if (lineIndex !== undefined) return paper.abstractLines[Number(lineIndex)];
  if (scoreKey !== undefined) return paper.scoreReasons[scoreKey];
  return paper[field];
}

function setSentinel(paper, field, paperIndex, lineIndex, scoreKey) {
  const n = paperIndex + 1;
  if (lineIndex !== undefined) {
    paper.abstractLines[Number(lineIndex)] = `第${n}論文の要約第${Number(lineIndex) + 1}文として、固有の課題、方法、結果の一側面を日本語で示す。`;
    return;
  }
  if (scoreKey !== undefined) {
    const labels = {
      broadImpact: "具体的成果が物理学の複数領域へ及ぼす波及経路と適用範囲",
      categoryImpact: "主分野の固有課題に対する従来研究からの前進と残る境界",
      originality: "最も近い既存手法との差分および継承した要素",
      technicalStrength: "中心手法を支える検証と未検証の仮定",
    };
    paper.scoreReasons[scoreKey] = `第${n}論文について、${labels[scoreKey]}を日本語で説明する。`;
    return;
  }
  const sentinels = {
    titleJa: `第${n}論文の中心課題に関する日本語題名`,
    paperType: "理論・方法論",
    curiosity: `第${n}論文で未解決の具体的な問いは何か。`,
    concept: `第${n}論文の問いと結果を結ぶ固有の方法上の要点を日本語で示す。`,
    conclusion: `第${n}論文の固有の結論と、その成立範囲および主要な限界を日本語で示す。`,
    assessment: `第${n}論文の固有の長所と、総合評価を抑える主要な限界を日本語で示す。`,
    fullTextReviewStatus: `第${n}論文で確認した固有の導出、検証、限界と、独立再現していない事項を日本語で示す。`,
  };
  paper[field] = sentinels[field];
}

try {
  if (process.argv.length !== 5) {
    fail("Usage: node scripts/audit-staged-language.mjs <YYYY-MM-DD> <fixed-staging-directory> <fixed-output-file>");
  }
  const date = validateDate(process.argv[2]);
  const runRoot = resolve(process.env.TMPDIR ?? "");
  const staging = resolve(process.argv[3]);
  const output = resolve(process.argv[4]);
  if (staging !== resolve(runRoot, "staging")) fail(`Staging directory must be ${resolve(runRoot, "staging")}.`);
  if (dirname(output) !== runRoot || !OUTPUT_NAMES.has(basename(output))) {
    fail(`Output must be language-issues-before.json or language-issues-after.json directly under ${runRoot}.`);
  }
  const stagingEntry = lstatSync(staging);
  if (stagingEntry.isSymbolicLink() || !stagingEntry.isDirectory()) fail("Staging must be a real directory.");
  const paths = assertExactStagingReports(staging, date);
  const policy = parseJsonFile(resolve(fileURLToPath(new URL("..", import.meta.url)), "data/model-policy.json"));
  const issues = [];

  for (const slug of CATEGORIES) {
    const original = parseJsonFile(paths[slug]);
    const probe = structuredClone(original);
    const seen = new Set();
    let completed = false;
    for (let attempt = 0; attempt < 10_000; attempt += 1) {
      try {
        validateProductionReport(probe, { date, slug, policy, path: "probe" });
        completed = true;
        break;
      } catch (error) {
        const match = FIELD_PATTERN.exec(error.message);
        if (!match) throw error;
        const [, paperIndexText, field, lineIndex, scoreKey] = match;
        const paperIndex = Number(paperIndexText);
        const key = `${slug}:${paperIndex}:${field}`;
        if (seen.has(key)) fail(`Repeated validation failure at ${key}: ${error.message}`);
        seen.add(key);
        issues.push({
          slug,
          index: paperIndex,
          rank: original.papers[paperIndex].rank,
          arxivId: original.papers[paperIndex].arxivId,
          path: field,
          message: error.message,
          value: getField(original.papers[paperIndex], field, lineIndex, scoreKey),
        });
        setSentinel(probe.papers[paperIndex], field, paperIndex, lineIndex, scoreKey);
      }
    }
    if (!completed) fail(`Language audit exceeded its bounded iteration limit for ${slug}.`);
  }

  writeFileSync(output, `${JSON.stringify({ date, count: issues.length, issues }, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  console.log(`STAGED_LANGUAGE_AUDIT: ${date}; issues=${issues.length}; output=${output}`);
} catch (error) {
  console.error(`ACTION_REQUIRED: STAGED_LANGUAGE_AUDIT_FAILED: ${error.stack ?? error.message}`);
  process.exitCode = 1;
}
