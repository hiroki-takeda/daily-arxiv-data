import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  mergeEditionTransactionally,
  transactionalWriteFiles,
} from "../scripts/lib/pipeline.mjs";
import { DATE, validReportSet, writeBaseRoot, writeReports } from "./helpers.mjs";

test("transactional writes restore every target after an injected partial failure", () => {
  const root = mkdtempSync(resolve(tmpdir(), "daily-arxiv-atomic-"));
  const existing = resolve(root, "existing.txt");
  const created = resolve(root, "created.txt");
  writeFileSync(existing, "before\n");
  assert.throws(() => transactionalWriteFiles([
    { path: existing, content: "after\n" },
    { path: created, content: "new\n" },
  ], { failAfterWrites: 1 }), /injected/);
  assert.equal(readFileSync(existing, "utf8"), "before\n");
  assert.equal(existsSync(created), false);
});

test("invalid report input never changes current.json", () => {
  const root = mkdtempSync(resolve(tmpdir(), "daily-arxiv-preflight-"));
  writeBaseRoot(root);
  const reports = validReportSet();
  reports["hep-th"].papers[0].scores.broadImpact = 99;
  writeReports(root, reports);
  const current = resolve(root, "public/data/current.json");
  writeFileSync(current, "previous-current\n");
  assert.throws(() => mergeEditionTransactionally({ root, date: DATE }), /0 through 25/);
  assert.equal(readFileSync(current, "utf8"), "previous-current\n");
});

test("the three-file edition merge rolls back after a partial filesystem failure", () => {
  const root = mkdtempSync(resolve(tmpdir(), "daily-arxiv-merge-rollback-"));
  writeBaseRoot(root);
  writeReports(root);
  const current = resolve(root, "public/data/current.json");
  const index = resolve(root, "public/data/index.json");
  const dated = resolve(root, `public/data/${DATE}.json`);
  writeFileSync(current, "previous-current\n");
  writeFileSync(index, "previous-index\n");
  assert.throws(() => mergeEditionTransactionally({
    root,
    date: DATE,
    transactionOptions: { failAfterWrites: 1 },
  }), /injected/);
  assert.equal(existsSync(dated), false);
  assert.equal(readFileSync(current, "utf8"), "previous-current\n");
  assert.equal(readFileSync(index, "utf8"), "previous-index\n");
});

test("repeating an identical merge is a no-op", () => {
  const root = mkdtempSync(resolve(tmpdir(), "daily-arxiv-merge-noop-"));
  writeBaseRoot(root);
  writeReports(root);
  assert.equal(mergeEditionTransactionally({ root, date: DATE }).changed, true);
  const before = readFileSync(resolve(root, "public/data/current.json"), "utf8");
  assert.equal(mergeEditionTransactionally({ root, date: DATE }).changed, false);
  assert.equal(readFileSync(resolve(root, "public/data/current.json"), "utf8"), before);
});

test("an all-empty announcement is never published", () => {
  const root = mkdtempSync(resolve(tmpdir(), "daily-arxiv-empty-"));
  writeBaseRoot(root);
  writeReports(root, validReportSet({ count: 0 }));
  assert.throws(() => mergeEditionTransactionally({ root, date: DATE }), /all-empty edition/);
});

test("post-merge repository validation failure restores outputs and preserves unrelated files", () => {
  const root = mkdtempSync(resolve(tmpdir(), "daily-arxiv-postcheck-"));
  writeBaseRoot(root);
  writeReports(root);
  const current = resolve(root, "public/data/current.json");
  const index = resolve(root, "public/data/index.json");
  const dated = resolve(root, `public/data/${DATE}.json`);
  const unrelated = resolve(root, "unrelated.pdf");
  writeFileSync(current, "previous-current\n");
  writeFileSync(index, "previous-index\n");
  writeFileSync(unrelated, "%PDF unrelated fixture\n");
  assert.throws(() => mergeEditionTransactionally({ root, date: DATE }), /PDF files are forbidden/);
  assert.equal(existsSync(dated), false);
  assert.equal(readFileSync(current, "utf8"), "previous-current\n");
  assert.equal(readFileSync(index, "utf8"), "previous-index\n");
  assert.equal(readFileSync(unrelated, "utf8"), "%PDF unrelated fixture\n");
});
