import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { MODEL_SOURCE_FAILURE_CLASS } from "../scripts/lib/source-blocker.mjs";

function runId() {
  return `run-20990105T123456Z-${randomBytes(6).toString("hex")}`;
}

test("fixed helper writes one bounded source-incomplete receipt only under the run blocker directory", () => {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const base = `/tmp/daily-arxiv-automation-${uid}`;
  const runRoot = join(base, runId());
  const blockers = join(runRoot, "blockers");
  mkdirSync(blockers, { recursive: true, mode: 0o700 });
  const script = resolve("scripts", "record-source-incomplete.mjs");
  const args = [
    script,
    "quant-ph",
    "2607.00001",
    MODEL_SOURCE_FAILURE_CLASS,
    "2607.00001,2607.00002",
  ];
  try {
    const rejectedClass = spawnSync(process.execPath, [
      ...args.slice(0, 3),
      "schema_failure",
      args[4],
    ], {
      cwd: process.cwd(),
      env: { ...process.env, TMPDIR: runRoot },
      encoding: "utf8",
    });
    assert.notEqual(rejectedClass.status, 0);
    assert.match(rejectedClass.stderr, /Model failure class must be exactly/);
    assert.equal(existsSync(join(blockers, "quant-ph.json")), false);

    const first = spawnSync(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...process.env, TMPDIR: runRoot },
      encoding: "utf8",
    });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout.trim(), "SOURCE_INCOMPLETE_RECORDED");
    const receiptPath = join(blockers, "quant-ph.json");
    assert.deepEqual(JSON.parse(readFileSync(receiptPath, "utf8")), {
      schemaVersion: "1.0",
      status: "source_incomplete",
      arxivId: "2607.00001",
      failureClass: MODEL_SOURCE_FAILURE_CLASS,
      provisionalCandidateIds: ["2607.00001", "2607.00002"],
    });
    assert.equal(statSync(receiptPath).mode & 0o777, 0o600);

    const second = spawnSync(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...process.env, TMPDIR: runRoot },
      encoding: "utf8",
    });
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /already exists/);
    assert.equal(existsSync(join(blockers, "gr-qc.json")), false);
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
});
