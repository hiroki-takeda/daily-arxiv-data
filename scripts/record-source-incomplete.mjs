#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { MODEL_SOURCE_FAILURE_CLASS } from "./lib/source-blocker.mjs";

const CATEGORIES = new Set(["quant-ph", "gr-qc", "hep-th"]);
const ARXIV_ID_PATTERN = /^\d{4}\.\d{4,5}$/u;
const FAILURE_CLASS_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const RUN_ROOT_PATTERN = /^\/tmp\/daily-arxiv-automation-(\d+)\/run-\d{8}T\d{6}Z-[a-f0-9]{12}$/u;

function fail(message) {
  throw new Error(message);
}

function assertOwnedDirectory(path, label) {
  const entry = lstatSync(path);
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  if (
    entry.isSymbolicLink()
    || !entry.isDirectory()
    || statSync(path).uid !== uid
    || (entry.mode & 0o077) !== 0
  ) {
    fail(`${label} must be a private real directory owned by the current user.`);
  }
}

function fixedRunRoot() {
  const runRoot = resolve(process.env.TMPDIR ?? "");
  const match = RUN_ROOT_PATTERN.exec(runRoot);
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  if (!match || Number(match[1]) !== uid) fail("TMPDIR is not the fixed Daily arXiv run root.");
  assertOwnedDirectory(runRoot, "Daily arXiv run root");
  return runRoot;
}

function validateId(value, label) {
  if (!ARXIV_ID_PATTERN.test(value)) fail(`${label} must be an unversioned modern arXiv ID.`);
  return value;
}

function writeExclusive(path, content) {
  const temporary = `${path}.new-${process.pid}-${randomBytes(8).toString("hex")}`;
  let descriptor;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  try {
    linkSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function main() {
  if (process.argv.length !== 6) {
    fail(
      "Usage: node scripts/record-source-incomplete.mjs "
      + "<category> <failed-arxiv-id> <failure-class> <comma-separated-provisional-candidate-ids>",
    );
  }
  const [, , category, arxivId, failureClass, candidateList] = process.argv;
  if (!CATEGORIES.has(category)) fail(`Unsupported Daily arXiv category: ${category}`);
  validateId(arxivId, "Failed arXiv ID");
  if (!FAILURE_CLASS_PATTERN.test(failureClass)) {
    fail("Failure class must be a lowercase safe identifier of at most 64 characters.");
  }
  if (failureClass !== MODEL_SOURCE_FAILURE_CLASS) {
    fail(`Model failure class must be exactly ${MODEL_SOURCE_FAILURE_CLASS}.`);
  }
  const provisionalCandidateIds = candidateList.split(",");
  if (provisionalCandidateIds.length < 1 || provisionalCandidateIds.some((id) => id === "")) {
    fail("Provisional candidate IDs must be a non-empty comma-separated list.");
  }
  provisionalCandidateIds.forEach((id, index) => validateId(id, `Candidate ID ${index + 1}`));
  if (new Set(provisionalCandidateIds).size !== provisionalCandidateIds.length) {
    fail("Provisional candidate IDs must not contain duplicates.");
  }
  if (!provisionalCandidateIds.includes(arxivId)) {
    fail("Failed arXiv ID must be present in the provisional candidate list.");
  }

  const blockers = join(fixedRunRoot(), "blockers");
  assertOwnedDirectory(blockers, "Daily arXiv blocker directory");
  const destination = join(blockers, `${category}.json`);
  if (existsSync(destination)) fail(`A source-incomplete receipt already exists for ${category}.`);
  const receipt = {
    schemaVersion: "1.0",
    status: "source_incomplete",
    arxivId,
    failureClass,
    provisionalCandidateIds,
  };
  writeExclusive(destination, `${JSON.stringify(receipt)}\n`);
  console.log("SOURCE_INCOMPLETE_RECORDED");
}

try {
  main();
} catch (error) {
  console.error(`ACTION_REQUIRED: SOURCE_INCOMPLETE_RECEIPT: ${error.stack ?? error.message}`);
  process.exitCode = 1;
}
