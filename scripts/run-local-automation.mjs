#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverCodex,
  notifyMac,
  parseMode,
  readOnlyDiagnostics,
  resolveAgentWorktreeBase,
  runAutomation,
} from "./lib/local-automation.mjs";
import { assertJapanTimeZone } from "./lib/macos-schedule.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

try {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 22) throw new Error("Node.js 22 or newer is required.");
  assertJapanTimeZone();
  const mode = parseMode(process.argv.slice(2));
  if (mode === "check") {
    const codexBin = discoverCodex();
    const worktree = resolveAgentWorktreeBase(
      root,
      process.env.DAILY_ARXIV_AGENT_WORKTREE_BASE,
    );
    const diagnostics = readOnlyDiagnostics({ root, worktree, codexBin });
    console.log(JSON.stringify(diagnostics, null, 2));
  } else {
    await runAutomation({ root });
  }
} catch (error) {
  console.error(`ACTION_REQUIRED: ${error.stack ?? error.message}`);
  console.error("No further publication will be attempted. Inspect the logs and origin/main before any manual action.");
  notifyMac("failed");
  process.exitCode = 1;
}
