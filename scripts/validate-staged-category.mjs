#!/usr/bin/env node

import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CATEGORIES,
  parseJsonFile,
  validateDate,
  validateProductionReport,
} from "./lib/pipeline.mjs";

function fail(message) {
  throw new Error(message);
}

const RUN_ID_PATTERN = /^run-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/u;
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

try {
  if (process.argv.length !== 6) {
    fail("Usage: node scripts/validate-staged-category.mjs <YYYY-MM-DD> <category> <fixed-staging-directory> <evaluation-run-id>");
  }
  const date = validateDate(process.argv[2]);
  const slug = process.argv[3];
  if (!CATEGORIES.includes(slug)) fail(`Unsupported category ${slug}.`);
  const staging = resolve(process.argv[4]);
  const expectedStaging = resolve(process.env.TMPDIR ?? "", "staging", slug);
  const entry = lstatSync(staging);
  if (entry.isSymbolicLink() || !entry.isDirectory()) fail("Staging directory must be a real directory.");
  if (realpathSync(staging) !== realpathSync(expectedStaging)) {
    fail(`Staging directory must be the fixed category path ${expectedStaging}.`);
  }
  const runId = process.argv[5];
  if (!RUN_ID_PATTERN.test(runId)) fail("Evaluation runId is invalid.");
  const expectedName = `${date}-${slug}.json`;
  const names = readdirSync(staging).sort();
  if (names.length !== 1 || names[0] !== expectedName) {
    fail(`Category staging must contain exactly ${expectedName}.`);
  }
  const reportPath = resolve(staging, expectedName);
  const reportEntry = lstatSync(reportPath);
  if (reportEntry.isSymbolicLink() || !reportEntry.isFile()) fail("Staged category report must be a regular file.");
  const policy = parseJsonFile(resolve(root, "data/model-policy.json"));
  const report = parseJsonFile(reportPath);
  validateProductionReport(report, { date, slug, policy, path: reportPath });
  if (report.evaluationRun.runId !== runId) fail(`evaluationRun.runId must equal ${runId}.`);
  console.log(`STAGED_CATEGORY_VALID: ${date}; ${slug}`);
} catch (error) {
  console.error(`ACTION_REQUIRED: STAGED_CATEGORY_INVALID: ${error.stack ?? error.message}`);
  process.exitCode = 1;
}
