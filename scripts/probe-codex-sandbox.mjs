#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function expectDenied(label, operation) {
  try {
    operation();
  } catch (error) {
    if (["EACCES", "EPERM", "ENOENT"].includes(error?.code)) return error.code;
    throw new Error(`${label} failed for an unexpected reason: ${error?.message}`);
  }
  throw new Error(`${label} unexpectedly succeeded; the Codex filesystem profile is unsafe.`);
}

const [allowedOutput, deniedSentinel, authPath, ...extra] = process.argv.slice(2);
if (!allowedOutput || !deniedSentinel || !authPath || extra.length) {
  throw new Error("Usage: node scripts/probe-codex-sandbox.mjs ALLOWED_OUTPUT DENIED_SENTINEL AUTH_PATH");
}

const repositoryRead = readFileSync(resolve("AGENTS.md"), "utf8");
if (!repositoryRead.includes("Daily arXiv")) throw new Error("The agent worktree is not readable inside the permission profile.");

const descriptor = openSync(resolve(allowedOutput), "wx", 0o600);
try {
  writeFileSync(descriptor, "allowed run-root write\n", "utf8");
} finally {
  closeSync(descriptor);
}

const deniedWrite = expectDenied("Write-open inside the read-only workspace", () => {
  // Opening the existing sentinel read/write proves write authority without
  // changing its contents or leaving a new file behind if the sandbox regresses.
  const target = openSync(resolve(deniedSentinel), "r+");
  closeSync(target);
});
const authRead = expectDenied("Read of Codex authentication storage", () => readFileSync(resolve(authPath)));

const allowedNetwork = spawnSync("/usr/bin/curl", [
  "--fail",
  "--silent",
  "--show-error",
  "--max-time", "20",
  "--output", "/dev/null",
  "https://arxiv.org/",
], { encoding: "utf8", timeout: 25_000 });
if (allowedNetwork.error || allowedNetwork.status !== 0) {
  throw new Error(`Allowed arXiv network probe failed: ${allowedNetwork.error?.message ?? allowedNetwork.stderr}`);
}

const deniedNetwork = spawnSync("/usr/bin/curl", [
  "--silent",
  "--max-time", "10",
  "--output", "/dev/null",
  "https://example.com/",
], { encoding: "utf8", timeout: 15_000 });
if (deniedNetwork.status === 0) throw new Error("Network outside the arXiv allowlist unexpectedly succeeded.");

console.log(JSON.stringify({
  status: "PERMISSION_PROBE_OK",
  repositoryRead: true,
  runRootWrite: true,
  deniedWrite,
  authRead,
  arxivNetworkAllowed: true,
  externalNetworkDenied: true,
}));
