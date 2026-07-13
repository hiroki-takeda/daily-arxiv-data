import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  assertExactStagingReports,
  buildEdition,
  findForbiddenRepositoryArtifacts,
  parseJsonFile,
  publicationAllowlist,
  serializeJson,
  validatePublicArchive,
  validateRepository,
} from "../scripts/lib/pipeline.mjs";
import {
  DATE,
  validPolicy,
  validReportSet,
  writeBaseRoot,
  writeProductionRepository,
  writeReports,
} from "./helpers.mjs";

test("current.json and index.json must exactly describe the dated archive", () => {
  const root = mkdtempSync(resolve(tmpdir(), "daily-arxiv-archive-"));
  writeProductionRepository(root);
  assert.doesNotThrow(() => validatePublicArchive(root, validPolicy()));

  const indexPath = resolve(root, "public/data/index.json");
  const originalIndex = readFileSync(indexPath, "utf8");
  const index = JSON.parse(originalIndex);
  index.latestDate = "2099-01-06";
  writeFileSync(indexPath, serializeJson(index));
  assert.throws(() => validatePublicArchive(root, validPolicy()), /latestDate/);

  writeFileSync(indexPath, originalIndex);
  const currentPath = resolve(root, "public/data/current.json");
  const current = JSON.parse(readFileSync(currentPath, "utf8"));
  current.statusMessage = "Changed only in current";
  writeFileSync(currentPath, serializeJson(current));
  assert.throws(() => validatePublicArchive(root, validPolicy()), /exactly match the latest dated edition/);
});

test("the checked-in schema-1.2 edition is accepted but cannot be overwritten", () => {
  const root = mkdtempSync(resolve(tmpdir(), "daily-arxiv-legacy-readonly-"));
  writeBaseRoot(root);
  const legacy = JSON.parse(readFileSync(resolve("public/data/2026-07-10.json"), "utf8"));
  writeFileSync(resolve(root, "public/data/2026-07-10.json"), serializeJson(legacy));
  assert.throws(() => buildEdition({ root, date: "2026-07-10" }), /legacy schema-1\.2 editions are immutable/);
});

test("a production public edition must match its three immutable source reports", () => {
  const root = mkdtempSync(resolve(tmpdir(), "daily-arxiv-report-sync-"));
  writeProductionRepository(root);
  const datedPath = resolve(root, `public/data/${DATE}.json`);
  const currentPath = resolve(root, "public/data/current.json");
  const edition = JSON.parse(readFileSync(datedPath, "utf8"));
  edition.categories["hep-th"].topPapers[0].title = "Tampered title";
  writeFileSync(datedPath, serializeJson(edition));
  writeFileSync(currentPath, serializeJson(edition));
  assert.throws(() => validateRepository(root), /does not match its source report/);
});

test("secret material, PDFs, and nested .git directories are found", () => {
  const root = mkdtempSync(resolve(tmpdir(), "daily-arxiv-forbidden-"));
  mkdirSync(resolve(root, "nested/.git"), { recursive: true });
  writeFileSync(resolve(root, "paper.PDF"), "%PDF fixture");
  const token = ["sk", "abcdefghijklmnopqrstuvwxyz123456"].join("-");
  writeFileSync(resolve(root, "notes.txt"), `token=${token}\n`);
  const problems = findForbiddenRepositoryArtifacts(root).join("\n");
  assert.match(problems, /nested \.git/);
  assert.match(problems, /PDF files are forbidden/);
  assert.match(problems, /probable secret/);
});

test("oversized JSON cannot bypass the repository secret scan limit", () => {
  const root = mkdtempSync(resolve(tmpdir(), "daily-arxiv-oversized-json-"));
  const path = resolve(root, "oversized.json");
  writeFileSync(path, "{}\n");
  truncateSync(path, 10 * 1024 * 1024 + 1);
  assert.throws(() => parseJsonFile(path), /JSON safety limit/);
  assert.match(findForbiddenRepositoryArtifacts(root).join("\n"), /safety-scan limit/);
});

test("the publish staging directory and six-file allowlist are exact", () => {
  const root = mkdtempSync(resolve(tmpdir(), "daily-arxiv-stage-"));
  writeReports(root, validReportSet(), root);
  assert.doesNotThrow(() => assertExactStagingReports(root, DATE));
  writeFileSync(resolve(root, "extra.json"), "{}\n");
  assert.throws(() => assertExactStagingReports(root, DATE), /exactly/);
  assert.equal(publicationAllowlist(DATE).length, 6);
  assert.equal(new Set(publicationAllowlist(DATE)).size, 6);
});
