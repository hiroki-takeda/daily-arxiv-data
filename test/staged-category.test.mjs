import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { DATE, validReport, validRun } from "./helpers.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(ROOT, "scripts", "validate-staged-category.mjs");
const RUN_ID = "run-20990105T123456Z-abcdef123456";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-staged-category-test-"));
  const staging = join(root, "staging", "quant-ph");
  mkdirSync(staging, { recursive: true });
  const report = validReport("quant-ph", { run: { ...validRun(), runId: RUN_ID } });
  writeFileSync(join(staging, `${DATE}-quant-ph.json`), `${JSON.stringify(report, null, 2)}\n`);
  return { root, staging };
}

function validate({ root, staging }) {
  return spawnSync(process.execPath, [SCRIPT, DATE, "quant-ph", staging, RUN_ID], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, TMPDIR: root },
  });
}

test("single-category validator accepts only the fixed report and host evaluation runId", async () => {
  const paths = await fixture();
  const valid = validate(paths);
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, new RegExp(`STAGED_CATEGORY_VALID: ${DATE}; quant-ph`));

  writeFileSync(join(paths.staging, "extra.json"), "{}\n");
  const extra = validate(paths);
  assert.equal(extra.status, 1);
  assert.match(extra.stderr, /must contain exactly/);
});

test("single-category validator accepts the macOS lexical /tmp alias after realpath comparison", async () => {
  const root = await mkdtemp("/tmp/daily-arxiv-staged-category-alias-");
  const staging = join(root, "staging", "quant-ph");
  mkdirSync(staging, { recursive: true });
  const report = validReport("quant-ph", { run: { ...validRun(), runId: RUN_ID } });
  writeFileSync(join(staging, `${DATE}-quant-ph.json`), `${JSON.stringify(report, null, 2)}\n`);
  const result = validate({ root, staging });
  assert.equal(result.status, 0, result.stderr);
});
