import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const expectedRemote = /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)(?:hiroki-takeda\/daily-arxiv-data)(?:\.git)?$/;

function git(args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

try {
  if (process.argv.length !== 2) throw new Error("Usage: node scripts/prepare-worktree.mjs");
  if (!lstatSync(resolve(root, ".git")).isFile()) {
    throw new Error("Refusing to prepare the main checkout; select a dedicated Scheduled-task worktree.");
  }
  if (git(["status", "--porcelain=v1", "--untracked-files=all"]) !== "") {
    throw new Error("ACTION_REQUIRED: DIRTY_WORKTREE. No files were changed.");
  }
  const remote = git(["remote", "get-url", "--push", "origin"]);
  if (!expectedRemote.test(remote)) throw new Error(`Refusing unexpected origin push URL: ${remote}`);
  git(["fetch", "--quiet", "origin", "main"]);
  const remoteHead = git(["rev-parse", "refs/remotes/origin/main"]);
  if (git(["rev-parse", "HEAD"]) !== remoteHead) {
    git(["switch", "--detach", "refs/remotes/origin/main"]);
  }
  if (git(["rev-parse", "HEAD"]) !== remoteHead || git(["status", "--porcelain=v1", "--untracked-files=all"]) !== "") {
    throw new Error("ACTION_REQUIRED: WORKTREE_SYNC_FAILED. No publication was attempted.");
  }
  console.log(`READY: clean scheduled worktree at origin/main ${remoteHead}.`);
} catch (error) {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
}
