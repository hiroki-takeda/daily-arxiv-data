#!/usr/bin/env node

import { gunzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, posix, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ARXIV_ID_PATTERN = /^\d{4}\.\d{4,5}$/u;
const RUN_ROOT_PATTERN = /^\/tmp\/daily-arxiv-automation-(\d+)\/run-\d{8}T\d{6}Z-[a-f0-9]{12}$/u;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 192 * 1024 * 1024;
const MAX_SOURCE_FILE_BYTES = 12 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 40 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_TEXT_FILES = 512;
const MIN_SOURCE_REQUEST_INTERVAL_MS = 3_000;
const SOURCE_RETRY_DELAYS_MS = Object.freeze([10_000, 30_000, 60_000]);
const DEFAULT_SOURCE_REQUEST_TIMEOUT_MS = 60_000;
const MAX_SOURCE_REQUEST_TIMEOUT_MS = 120_000;
const DISALLOWED_TEXT_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const TEXT_EXTENSIONS = new Set([
  ".tex", ".ltx", ".bib", ".bbl", ".txt", ".md",
  ".cls", ".sty", ".def", ".cfg", ".ins", ".dtx",
  ".json", ".yaml", ".yml",
]);

function fail(message) {
  throw new Error(message);
}

export function validateArxivSourceId(value) {
  if (typeof value !== "string" || !ARXIV_ID_PATTERN.test(value)) {
    fail("arXiv source ID must be an unversioned modern identifier.");
  }
  return value;
}

function boundedInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    fail(`${label} is outside the permitted range.`);
  }
  return value;
}

function decodeNullTerminated(bytes, label) {
  const end = bytes.indexOf(0);
  const slice = end === -1 ? bytes : bytes.subarray(0, end);
  let value;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(slice);
  } catch {
    fail(`${label} is not valid UTF-8.`);
  }
  return value;
}

function parseTarOctal(bytes, label) {
  const value = decodeNullTerminated(bytes, label).trim();
  if (!/^[0-7]+$/u.test(value)) fail(`${label} is not a supported octal tar field.`);
  return boundedInteger(Number.parseInt(value, 8), label, MAX_UNCOMPRESSED_BYTES);
}

function tarChecksum(header) {
  let sum = 0;
  for (let index = 0; index < header.length; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  return sum;
}

function allZero(bytes) {
  return bytes.every((byte) => byte === 0);
}

function safeArchivePath(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 1_024) {
    fail("arXiv source archive contains an invalid path length.");
  }
  if (value.startsWith("/") || value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`arXiv source archive contains an unsafe path: ${JSON.stringify(value)}.`);
  }
  const withoutDotPrefix = value.replace(/^(?:\.\/)+/u, "");
  const normalized = posix.normalize(withoutDotPrefix);
  const segments = normalized.split("/");
  if (
    normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail(`arXiv source archive contains path traversal: ${JSON.stringify(value)}.`);
  }
  return normalized;
}

function parsePaxPath(payload) {
  let cursor = 0;
  let path;
  while (cursor < payload.length) {
    const space = payload.indexOf(0x20, cursor);
    if (space === -1) fail("arXiv source archive contains malformed PAX metadata.");
    const lengthText = payload.subarray(cursor, space).toString("ascii");
    if (!/^[1-9]\d*$/u.test(lengthText)) fail("arXiv source archive contains malformed PAX record length.");
    const length = boundedInteger(Number(lengthText), "PAX record length", payload.length - cursor);
    const end = cursor + length;
    if (end > payload.length || payload[end - 1] !== 0x0a) fail("arXiv source archive contains truncated PAX metadata.");
    const body = payload.subarray(space + 1, end - 1).toString("utf8");
    const equals = body.indexOf("=");
    if (equals < 1) fail("arXiv source archive contains malformed PAX metadata.");
    if (body.slice(0, equals) === "path") path = body.slice(equals + 1);
    cursor = end;
  }
  return path;
}

function decodeStrictSourceText(bytes, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(`arXiv source text is not valid UTF-8: ${label}.`);
  }
  if (DISALLOWED_TEXT_CONTROLS.test(text)) {
    fail(`arXiv source text contains disallowed control characters: ${label}.`);
  }
  return text;
}

function looksLikeTexText(text) {
  if (text.length === 0) return false;
  const sample = text.slice(0, 256 * 1024);
  return /\\(?:documentclass|begin\s*\{document\}|section\s*\{|title\s*\{)/u.test(sample);
}

function eligibleTextFile(path, content) {
  const extension = extname(path).toLocaleLowerCase("en-US");
  if (TEXT_EXTENSIONS.has(extension)) {
    decodeStrictSourceText(content, path);
    return true;
  }
  if (extension !== "") return false;
  try {
    return looksLikeTexText(decodeStrictSourceText(content, path));
  } catch {
    return false;
  }
}

function parseTarArchive(buffer) {
  const files = [];
  const seen = new Set();
  let offset = 0;
  let entryCount = 0;
  let totalExtracted = 0;
  let pendingPath;

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (allZero(header)) break;
    entryCount += 1;
    if (entryCount > MAX_ARCHIVE_ENTRIES) fail("arXiv source archive contains too many entries.");
    const expectedChecksum = parseTarOctal(header.subarray(148, 156), "tar checksum");
    if (tarChecksum(header) !== expectedChecksum) fail("arXiv source archive failed its tar checksum.");

    const name = decodeNullTerminated(header.subarray(0, 100), "tar name");
    const prefix = decodeNullTerminated(header.subarray(345, 500), "tar prefix");
    const headerPath = prefix ? `${prefix}/${name}` : name;
    const size = parseTarOctal(header.subarray(124, 136), "tar entry size");
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > buffer.length) fail("arXiv source archive contains a truncated entry.");
    const content = buffer.subarray(dataStart, dataEnd);
    const type = String.fromCharCode(header[156] || 0x30);

    if (type === "x") {
      pendingPath = parsePaxPath(content) ?? pendingPath;
    } else if (type === "g") {
      if (parsePaxPath(content) !== undefined) fail("Global PAX path overrides are not permitted.");
    } else if (type === "L") {
      pendingPath = decodeNullTerminated(content, "GNU long path").replace(/\n$/u, "");
    } else {
      const candidatePath = pendingPath ?? headerPath;
      pendingPath = undefined;
      if (type === "0") {
        const path = safeArchivePath(candidatePath);
        if (eligibleTextFile(path, content)) {
          if (content.length > MAX_SOURCE_FILE_BYTES) fail(`arXiv source text file is too large: ${path}.`);
          if (seen.has(path)) fail(`arXiv source archive repeats a text path: ${path}.`);
          seen.add(path);
          totalExtracted += content.length;
          if (totalExtracted > MAX_EXTRACTED_BYTES) fail("arXiv source archive contains too much text.");
          if (files.length >= MAX_TEXT_FILES) fail("arXiv source archive contains too many text files.");
          files.push(Object.freeze({ path, content: Buffer.from(content) }));
        }
      } else if (!["5", "1", "2", "3", "4", "6", "7", "K"].includes(type)) {
        fail(`arXiv source archive contains unsupported tar entry type ${JSON.stringify(type)}.`);
      }
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (files.length === 0) fail("arXiv source archive contains no readable TeX or text source.");
  return files;
}

export function parseArxivSourceArchive(compressed, arxivId) {
  validateArxivSourceId(arxivId);
  const input = Buffer.from(compressed);
  if (input.length < 1 || input.length > MAX_DOWNLOAD_BYTES) fail("arXiv source download has an invalid size.");
  let unpacked = input;
  if (input[0] === 0x1f && input[1] === 0x8b) {
    try {
      unpacked = gunzipSync(input, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
    } catch (error) {
      fail(`arXiv source gzip extraction failed: ${error.message}`);
    }
  }
  if (unpacked.length > MAX_UNCOMPRESSED_BYTES) fail("arXiv source archive is too large after decompression.");

  if (unpacked.length >= 512) {
    const firstHeader = unpacked.subarray(0, 512);
    let isTar = false;
    try {
      isTar = !allZero(firstHeader)
        && tarChecksum(firstHeader) === parseTarOctal(firstHeader.subarray(148, 156), "tar checksum");
    } catch {
      // A gzip-compressed single TeX source is not a tar archive.
    }
    if (isTar) return Object.freeze(parseTarArchive(unpacked));
  }
  const sourceText = decodeStrictSourceText(unpacked, `${arxivId}.tex`);
  if (!looksLikeTexText(sourceText)) fail("arXiv source payload is neither a supported tar archive nor a TeX source.");
  return Object.freeze([Object.freeze({ path: `${arxivId}.tex`, content: Buffer.from(unpacked) })]);
}

async function readBoundedBody(response) {
  const declared = response.headers?.get?.("content-length");
  if (declared !== null && declared !== undefined) {
    if (!/^(0|[1-9]\d*)$/u.test(declared) || Number(declared) > MAX_DOWNLOAD_BYTES) {
      fail("arXiv source response has an invalid or excessive Content-Length.");
    }
  }
  const reader = response.body?.getReader?.();
  if (!reader) fail("arXiv source response body is not readable.");
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array)) fail("arXiv source response returned a non-byte chunk.");
    total += value.byteLength;
    if (total > MAX_DOWNLOAD_BYTES) {
      await reader.cancel("source response too large");
      fail("arXiv source response exceeded the download limit.");
    }
    chunks.push(Buffer.from(value));
  }
  if (total === 0) fail("arXiv source response was empty.");
  return Buffer.concat(chunks, total);
}

function retryableFetchError(error) {
  return error instanceof TypeError
    || error?.name === "AbortError"
    || /terminated|fetch failed|ECONNRESET|UND_ERR|timed out/iu.test(String(error?.message ?? ""));
}

function retryAfterMilliseconds(response, attempt) {
  const header = response?.headers?.get?.("retry-after");
  if (header && /^(0|[1-9]\d*)$/u.test(header)) {
    return Math.min(120_000, Number(header) * 1_000);
  }
  return SOURCE_RETRY_DELAYS_MS[Math.min(attempt - 1, SOURCE_RETRY_DELAYS_MS.length - 1)];
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export async function fetchArxivSourceArchive(arxivId, {
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
  maxAttempts = 4,
  requestTimeoutMs = DEFAULT_SOURCE_REQUEST_TIMEOUT_MS,
} = {}) {
  validateArxivSourceId(arxivId);
  if (typeof fetchImpl !== "function") fail("A fetch implementation is required.");
  if (typeof sleepImpl !== "function") fail("A sleep implementation is required.");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) fail("Source fetch attempts must be from 1 through 5.");
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > MAX_SOURCE_REQUEST_TIMEOUT_MS) {
    fail("Source request timeout is outside the permitted range.");
  }
  const requested = `https://arxiv.org/e-print/${arxivId}v1`;
  const expectedFinalUrl = `https://arxiv.org/src/${arxivId}v1`;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("arXiv source request timed out")), requestTimeoutMs);
    let response;
    try {
      response = await fetchImpl(requested, {
        method: "GET",
        redirect: "follow",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: {
          Accept: "application/gzip, application/x-eprint-tar, application/octet-stream",
          "User-Agent": "daily-arxiv-data/1.1 (+https://github.com/hiroki-takeda/daily-arxiv-data)",
        },
        signal: controller.signal,
      });
      if ([429, 502, 503, 504].includes(response.status)) {
        lastError = new Error(`arXiv source endpoint returned transient HTTP ${response.status}.`);
        await response.body?.cancel?.("retrying transient source response");
      } else {
        if (response.status !== 200 || response.ok !== true) {
          fail(`arXiv source endpoint returned HTTP ${String(response.status)}.`);
        }
        const finalUrl = new URL(response.url);
        if (
          finalUrl.href !== expectedFinalUrl
          || finalUrl.username !== ""
          || finalUrl.password !== ""
        ) {
          fail(`arXiv source endpoint redirected to an unexpected URL: ${response.url}.`);
        }
        return await readBoundedBody(response);
      }
    } catch (error) {
      if (!retryableFetchError(error)) throw error;
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < maxAttempts) {
      const delay = response ? retryAfterMilliseconds(response, attempt) : SOURCE_RETRY_DELAYS_MS[attempt - 1];
      await sleepImpl(delay);
    }
  }
  fail(`arXiv source retrieval failed after ${maxAttempts} attempts: ${lastError?.message ?? "unknown network error"}`);
}

function safeRunRoot(env = process.env) {
  const runRoot = resolve(env.TMPDIR ?? "");
  const match = RUN_ROOT_PATTERN.exec(runRoot);
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  if (!match || Number(match[1]) !== uid) fail("TMPDIR is not the fixed Daily arXiv run root.");
  const entry = lstatSync(runRoot);
  if (entry.isSymbolicLink() || !entry.isDirectory() || statSync(runRoot).uid !== uid) {
    fail("Daily arXiv run root is not a safe owned directory.");
  }
  return runRoot;
}

function ensureOwnedDirectory(path) {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isDirectory() || statSync(path).uid !== uid) {
    fail(`Unsafe source output directory: ${path}.`);
  }
}

function atomicWriteFile(path, content, mode = 0o600) {
  const temporaryPath = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, path);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }
}

async function enforcePoliteSourceInterval({ env = process.env, now = () => Date.now(), sleepImpl = sleep } = {}) {
  const runRoot = safeRunRoot(env);
  const statePath = resolve(runRoot, ".source-fetch-state.json");
  let lastAttemptAt = 0;
  if (existsSync(statePath)) {
    const entry = lstatSync(statePath);
    if (entry.isSymbolicLink() || !entry.isFile() || entry.size > 1_024) fail("Unsafe source-fetch pacing state.");
    const parsed = JSON.parse(readFileSync(statePath, "utf8"));
    if (Object.keys(parsed).join("\0") !== "lastAttemptAt" || !Number.isSafeInteger(parsed.lastAttemptAt) || parsed.lastAttemptAt < 0) {
      fail("Invalid source-fetch pacing state.");
    }
    lastAttemptAt = parsed.lastAttemptAt;
  }
  const observedAt = now();
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) fail("Invalid source-fetch pacing timestamp.");
  const delay = Math.max(0, MIN_SOURCE_REQUEST_INTERVAL_MS - (observedAt - lastAttemptAt));
  if (delay > 0) await sleepImpl(delay);
  const attemptAt = now();
  if (!Number.isSafeInteger(attemptAt) || attemptAt < 0) fail("Invalid source-fetch pacing timestamp.");
  atomicWriteFile(statePath, `${JSON.stringify({ lastAttemptAt: attemptAt })}\n`);
}

function normalizeSourceFiles(files) {
  if (!Array.isArray(files) || files.length === 0) fail("No parsed arXiv source files were provided.");
  if (files.length > MAX_TEXT_FILES) fail("Too many parsed arXiv source files were provided.");
  const seen = new Set();
  const normalized = [];
  let totalBytes = 0;
  for (const file of files) {
    if (!file || typeof file !== "object" || !(file.content instanceof Uint8Array)) {
      fail("Parsed arXiv source files must contain byte content.");
    }
    const path = safeArchivePath(file.path);
    if (seen.has(path)) fail(`Parsed arXiv source files repeat a path: ${path}.`);
    const content = Buffer.from(file.content);
    if (content.length > MAX_SOURCE_FILE_BYTES) fail(`arXiv source text file is too large: ${path}.`);
    if (!eligibleTextFile(path, content)) fail(`Parsed arXiv source file is not supported text: ${path}.`);
    totalBytes += content.length;
    if (totalBytes > MAX_EXTRACTED_BYTES) fail("Parsed arXiv source files contain too much text.");
    seen.add(path);
    normalized.push(Object.freeze({ path, content }));
  }
  const sortedPaths = [...seen].sort();
  for (let index = 0; index + 1 < sortedPaths.length; index += 1) {
    if (sortedPaths[index + 1].startsWith(`${sortedPaths[index]}/`)) {
      fail(`Parsed arXiv source paths conflict: ${sortedPaths[index]}.`);
    }
  }
  return normalized;
}

export function writeArxivSourceFiles(files, arxivId, { env = process.env } = {}) {
  validateArxivSourceId(arxivId);
  const normalizedFiles = normalizeSourceFiles(files);
  const runRoot = safeRunRoot(env);
  const sourcesRoot = resolve(runRoot, "sources");
  if (!existsSync(sourcesRoot)) mkdirSync(sourcesRoot, { mode: 0o700 });
  ensureOwnedDirectory(sourcesRoot);
  const outputRoot = resolve(sourcesRoot, arxivId);
  if (existsSync(outputRoot)) fail(`Source output already exists for ${arxivId}.`);
  let temporaryRoot;
  try {
    temporaryRoot = mkdtempSync(resolve(sourcesRoot, `.${arxivId}.tmp-`));
    chmodSync(temporaryRoot, 0o700);
    for (const file of normalizedFiles) {
      const destination = resolve(temporaryRoot, ...file.path.split("/"));
      if (!destination.startsWith(`${temporaryRoot}${sep}`)) fail("Source destination escaped its fixed output directory.");
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      const descriptor = openSync(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try {
        writeFileSync(descriptor, file.content);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    }
    if (existsSync(outputRoot)) fail(`Source output already exists for ${arxivId}.`);
    renameSync(temporaryRoot, outputRoot);
    temporaryRoot = undefined;
  } catch (error) {
    if (temporaryRoot && existsSync(temporaryRoot)) rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
  const written = normalizedFiles.map((file) => resolve(outputRoot, ...file.path.split("/")));
  return Object.freeze({ runRoot, outputRoot, files: Object.freeze(written) });
}

export async function extractArxivSource(arxivId, options = {}) {
  await enforcePoliteSourceInterval(options);
  const archive = await fetchArxivSourceArchive(arxivId, options);
  const files = parseArxivSourceArchive(archive, arxivId);
  return writeArxivSourceFiles(files, arxivId, options);
}

async function main() {
  if (process.argv.length !== 3) fail("Usage: node scripts/extract-arxiv-source.mjs <unversioned-arXiv-ID>");
  const arxivId = validateArxivSourceId(process.argv[2]);
  const result = await extractArxivSource(arxivId);
  console.log(JSON.stringify({
    status: "SOURCE_TEXT_READY",
    arxivId,
    outputRoot: result.outputRoot,
    fileCount: result.files.length,
    files: result.files,
  }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`ACTION_REQUIRED: SOURCE_TEXT_EXTRACTION: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
