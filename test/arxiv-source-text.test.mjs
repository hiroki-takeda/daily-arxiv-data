import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { gzipSync } from "node:zlib";
import test from "node:test";

import {
  extractArxivSource,
  fetchArxivSourceArchive,
  parseArxivSourceArchive,
  validateArxivSourceId,
  writeArxivSourceFiles,
} from "../scripts/extract-arxiv-source.mjs";

function writeTarString(buffer, offset, length, value) {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length > length) throw new Error("test tar field overflow");
  encoded.copy(buffer, offset);
}

function tarHeader(path, size, type = "0") {
  const header = Buffer.alloc(512);
  writeTarString(header, 0, 100, path);
  writeTarString(header, 100, 8, "0000644\0");
  writeTarString(header, 108, 8, "0000000\0");
  writeTarString(header, 116, 8, "0000000\0");
  writeTarString(header, 124, 12, `${size.toString(8).padStart(11, "0")}\0`);
  writeTarString(header, 136, 12, "00000000000\0");
  header.fill(0x20, 148, 156);
  writeTarString(header, 156, 1, type);
  writeTarString(header, 257, 6, "ustar\0");
  writeTarString(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeTarString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function makeTar(entries) {
  const chunks = [];
  for (const { path, content, type = "0" } of entries) {
    const body = Buffer.from(content);
    chunks.push(tarHeader(path, body.length, type));
    chunks.push(body);
    const padding = (512 - (body.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1_024));
  return Buffer.concat(chunks);
}

function makeRunRoot(t) {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const parent = `/tmp/daily-arxiv-automation-${uid}`;
  const runRoot = `${parent}/run-20260714T000000Z-${randomBytes(6).toString("hex")}`;
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  t.after(() => rmSync(runRoot, { recursive: true, force: true }));
  return runRoot;
}

function successfulSourceResponse(payload, arxivId = "2607.00001") {
  return {
    status: 200,
    ok: true,
    url: `https://arxiv.org/src/${arxivId}v1`,
    headers: new Headers({ "content-length": String(payload.length) }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(payload);
        controller.close();
      },
    }),
  };
}

test("official e-print parser extracts bounded text and ignores binary figures", () => {
  const archive = gzipSync(makeTar([
    { path: "paper/main.tex", content: "\\documentclass{article}\n\\begin{document}Result\\end{document}\n" },
    { path: "refs.bib", content: "@article{x,title={Reference}}\n" },
    { path: "figures/plot.png", content: Buffer.from([0, 1, 2, 3]) },
  ]));
  const files = parseArxivSourceArchive(archive, "2607.09242");
  assert.deepEqual(files.map(({ path }) => path), ["paper/main.tex", "refs.bib"]);
  assert.match(files[0].content.toString("utf8"), /begin\{document\}/u);
});

test("official e-print parser accepts a gzip-compressed single TeX source", () => {
  const source = Buffer.from("\\documentclass{article}\n\\begin{document}Text\\end{document}\n");
  const files = parseArxivSourceArchive(gzipSync(source), "2607.00001");
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "2607.00001.tex");
  assert.deepEqual(files[0].content, source);
});

test("official e-print parser rejects archive traversal and malformed IDs", () => {
  const archive = gzipSync(makeTar([
    { path: "../escape.tex", content: "\\documentclass{article}\n" },
  ]));
  assert.throws(() => parseArxivSourceArchive(archive, "2607.00001"), /path traversal/u);
  assert.throws(() => validateArxivSourceId("2607.00001v1"), /unversioned/u);
});

test("official e-print parser rejects invalid UTF-8 and text control characters", () => {
  const invalidUtf8 = gzipSync(makeTar([
    { path: "main.tex", content: Buffer.from([0x5c, 0x74, 0xc3, 0x28]) },
  ]));
  const controlCharacter = gzipSync(makeTar([
    { path: "main.tex", content: Buffer.from("\\documentclass{article}\nBad\u001bText\n", "utf8") },
  ]));
  assert.throws(() => parseArxivSourceArchive(invalidUtf8, "2607.00001"), /valid UTF-8/u);
  assert.throws(() => parseArxivSourceArchive(controlCharacter, "2607.00001"), /control characters/u);
});

test("official e-print fetcher uses arxiv.org and requires its exact version-fixed redirect", async () => {
  const payload = gzipSync(Buffer.from("\\documentclass{article}\n"));
  const response = successfulSourceResponse(payload);
  let requested;
  const result = await fetchArxivSourceArchive("2607.00001", {
    fetchImpl: async (url, options) => {
      requested = { url, options };
      return response;
    },
  });
  assert.deepEqual(result, payload);
  assert.equal(requested.url, "https://arxiv.org/e-print/2607.00001v1");
  assert.equal(requested.options.redirect, "follow");

  await assert.rejects(() => fetchArxivSourceArchive("2607.00001", {
    fetchImpl: async () => ({ ...response, url: "https://example.com/src/2607.00001v1" }),
  }), /unexpected URL/u);
});

test("official e-print fetch timeout remains active until the response body completes", async () => {
  let observedSignal;
  await assert.rejects(() => fetchArxivSourceArchive("2607.00001", {
    maxAttempts: 1,
    requestTimeoutMs: 20,
    fetchImpl: async (_url, options) => {
      observedSignal = options.signal;
      return {
        status: 200,
        ok: true,
        url: "https://arxiv.org/src/2607.00001v1",
        headers: new Headers(),
        body: new ReadableStream({
          start(controller) {
            options.signal.addEventListener("abort", () => controller.error(options.signal.reason), { once: true });
          },
        }),
      };
    },
  }), /request timed out/u);
  assert.equal(observedSignal.aborted, true);
});

test("official e-print fetcher retries a transient 429 with bounded backoff", async () => {
  const payload = gzipSync(Buffer.from("\\documentclass{article}\n"));
  let attempts = 0;
  const delays = [];
  const result = await fetchArxivSourceArchive("2607.00001", {
    sleepImpl: async (milliseconds) => { delays.push(milliseconds); },
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          status: 429,
          ok: false,
          url: "https://arxiv.org/src/2607.00001v1",
          headers: new Headers({ "retry-after": "7" }),
          body: new ReadableStream({ start(controller) { controller.close(); } }),
        };
      }
      return {
        status: 200,
        ok: true,
        url: "https://arxiv.org/src/2607.00001v1",
        headers: new Headers({ "content-length": String(payload.length) }),
        body: new ReadableStream({ start(controller) { controller.enqueue(payload); controller.close(); } }),
      };
    },
  });
  assert.deepEqual(result, payload);
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [7_000]);
});

test("source writer publishes only a complete atomically renamed directory", (t) => {
  const runRoot = makeRunRoot(t);
  const env = { TMPDIR: runRoot };
  const result = writeArxivSourceFiles([
    { path: "paper/main.tex", content: Buffer.from("\\documentclass{article}\n") },
    { path: "refs.bib", content: Buffer.from("@article{x,title={Reference}}\n") },
  ], "2607.00001", { env });
  assert.equal(existsSync(result.outputRoot), true);
  assert.equal(readFileSync(result.files[0], "utf8"), "\\documentclass{article}\n");
  assert.deepEqual(readdirSync(`${runRoot}/sources`).sort(), ["2607.00001"]);

  assert.throws(() => writeArxivSourceFiles([
    { path: "main.tex", content: Buffer.from("\\documentclass{article}\n") },
    { path: `${"x".repeat(300)}.tex`, content: Buffer.from("\\documentclass{article}\n") },
  ], "2607.00002", { env }));
  assert.equal(existsSync(`${runRoot}/sources/2607.00002`), false);
  assert.deepEqual(readdirSync(`${runRoot}/sources`).sort(), ["2607.00001"]);
});

test("source pacing state is atomically replaced before a fetch attempt", async (t) => {
  const runRoot = makeRunRoot(t);
  await assert.rejects(() => extractArxivSource("2607.00001", {
    env: { TMPDIR: runRoot },
    maxAttempts: 1,
    now: () => 12_345,
    fetchImpl: async () => ({
      status: 500,
      ok: false,
      url: "https://arxiv.org/e-print/2607.00001v1",
      headers: new Headers(),
      body: new ReadableStream({ start(controller) { controller.close(); } }),
    }),
  }), /HTTP 500/u);
  assert.deepEqual(JSON.parse(readFileSync(`${runRoot}/.source-fetch-state.json`, "utf8")), {
    lastAttemptAt: 12_345,
  });
  assert.deepEqual(readdirSync(runRoot), [".source-fetch-state.json"]);
});
