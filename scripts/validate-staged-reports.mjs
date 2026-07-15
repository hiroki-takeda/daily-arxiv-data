#!/usr/bin/env node

import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CATEGORIES,
  assertExactStagingReports,
  parseJsonFile,
  validateDate,
  validateProductionReportSet,
} from "./lib/pipeline.mjs";

function fail(message) {
  throw new Error(message);
}

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

try {
  if (process.argv.length !== 4) {
    fail("Usage: node scripts/validate-staged-reports.mjs <YYYY-MM-DD> <fixed-staging-directory>");
  }
  const date = validateDate(process.argv[2]);
  const staging = resolve(process.argv[3]);
  const fixedStaging = resolve(process.env.TMPDIR ?? "", "staging");
  if (staging !== fixedStaging) fail(`Staging directory must be the fixed run path ${fixedStaging}.`);
  const entry = lstatSync(staging);
  if (entry.isSymbolicLink() || !entry.isDirectory()) fail("Staging directory must be a real directory.");
  const paths = assertExactStagingReports(staging, date);
  const reports = Object.fromEntries(CATEGORIES.map((slug) => [slug, parseJsonFile(paths[slug])]));
  const policy = parseJsonFile(resolve(root, "data/model-policy.json"));
  validateProductionReportSet(reports, { date, policy, paths });
  console.log(`STAGED_REPORTS_VALID: ${date}; ${CATEGORIES.join(", ")}`);
} catch (error) {
  console.error(`ACTION_REQUIRED: STAGED_REPORTS_INVALID: ${error.stack ?? error.message}`);
  process.exitCode = 1;
}
