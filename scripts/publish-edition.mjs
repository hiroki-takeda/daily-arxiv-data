import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CATEGORIES,
  assertExactStagingReports,
  buildEdition,
  editionOutputEntries,
  findForbiddenRepositoryArtifacts,
  parseJsonFile,
  pathIsWithin,
  publicationAllowlist,
  relativePosix,
  restoreFileSnapshot,
  serializeJson,
  snapshotFiles,
  transactionalWriteFiles,
  validateDate,
  validateProductionReportSet,
  validateRepository,
} from "./lib/pipeline.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const EXPECTED_REMOTE = /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)(?:hiroki-takeda\/daily-arxiv-data)(?:\.git)?$/;
const NETWORK_RETRY_DELAYS_MS = Object.freeze([2_000, 10_000]);

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args[0]} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`);
  }
  return result;
}

function retryableGitNetworkFailure(result) {
  const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  return /(?:ssh: connect to host .* port \d+:|Could not resolve (?:host|hostname)|Could not read from remote repository|Connection (?:timed out|reset|refused|closed)|Operation timed out|Network is unreachable|remote end hung up|RPC failed|fatal: unable to access|HTTP 408|HTTP 425|HTTP 429|HTTP 5\d\d)/iu.test(output);
}

function waitSynchronously(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function gitNetwork(args) {
  let result;
  for (let attempt = 0; attempt <= NETWORK_RETRY_DELAYS_MS.length; attempt += 1) {
    result = git(args, { allowFailure: true });
    if (result.status === 0) return result;
    if (attempt >= NETWORK_RETRY_DELAYS_MS.length || !retryableGitNetworkFailure(result)) return result;
    waitSynchronously(NETWORK_RETRY_DELAYS_MS[attempt]);
  }
  return result;
}

function nulList(args) {
  const output = git(args).stdout;
  return output.split("\0").filter(Boolean);
}

function statusPaths() {
  return {
    staged: nulList(["diff", "--cached", "--name-only", "-z"]),
    unstaged: nulList(["diff", "--name-only", "-z"]),
    untracked: nulList(["ls-files", "--others", "--exclude-standard", "-z"]),
  };
}

function sameSet(left, right) {
  return [...left].sort().join("\0") === [...right].sort().join("\0");
}

function assertInitialWorktreeSafe(stagingDir) {
  const status = statusPaths();
  if (status.staged.length || status.unstaged.length) {
    throw new Error("Refusing to publish with pre-existing staged or tracked working-tree changes.");
  }
  const permittedStagingFiles = pathIsWithin(root, stagingDir)
    ? new Set(CATEGORIES.map((slug) => relativePosix(root, resolve(stagingDir, `${date}-${slug}.json`))))
    : new Set();
  const unrelated = status.untracked.filter((path) => !permittedStagingFiles.has(path));
  if (unrelated.length) throw new Error(`Refusing unrelated untracked files: ${unrelated.join(", ")}`);
}

function verifyRepositoryAndRemote() {
  if (!lstatSync(resolve(root, ".git")).isFile()) {
    throw new Error("Refusing unattended publication from the main checkout; use the dedicated publisher worktree.");
  }
  const top = git(["rev-parse", "--show-toplevel"]).stdout.trim();
  if (resolve(top) !== root) throw new Error(`Expected Git root ${root}, got ${top}`);
  const remote = git(["remote", "get-url", "--push", "origin"]).stdout.trim();
  if (!EXPECTED_REMOTE.test(remote)) throw new Error(`Refusing unexpected origin push URL: ${remote}`);
}

function fetchOriginMain() {
  const fetched = gitNetwork(["fetch", "--quiet", "origin", "main"]);
  if (fetched.status !== 0) {
    throw new Error(`git fetch failed (${fetched.status}): ${(fetched.stderr || fetched.stdout).trim()}`);
  }
  return git(["rev-parse", "refs/remotes/origin/main"]).stdout.trim();
}

function rollback({ snapshot, preHead, committed }) {
  if (committed) {
    git(["reset", "--mixed", preHead]);
  } else {
    git(["reset", "--quiet", "HEAD", "--", ...allowlist], { allowFailure: true });
  }
  restoreFileSnapshot(snapshot);
}

const [dateArgument, stagingArgument, ...extra] = process.argv.slice(2);
let date;
let allowlist = [];

try {
  if (!dateArgument || !stagingArgument || extra.length) {
    throw new Error("Usage: npm run publish -- YYYY-MM-DD STAGING_DIRECTORY");
  }
  date = validateDate(dateArgument);
  const stagingDir = resolve(stagingArgument);
  if (!existsSync(stagingDir)) throw new Error(`Staging directory does not exist: ${stagingDir}`);
  if (pathIsWithin(resolve(root, ".git"), stagingDir)) throw new Error("Staging inside .git is forbidden.");
  const stagingPaths = assertExactStagingReports(stagingDir, date);
  const stageSafetyProblems = findForbiddenRepositoryArtifacts(stagingDir);
  if (stageSafetyProblems.length) throw new Error(`Unsafe staging directory: ${stageSafetyProblems.join("; ")}`);

  const { policy } = validateRepository(root);
  const stagedReports = Object.fromEntries(CATEGORIES.map((slug) => [slug, parseJsonFile(stagingPaths[slug])]));
  validateProductionReportSet(stagedReports, { date, policy, paths: stagingPaths });
  const built = buildEdition({ root, date, reportsDir: stagingDir });
  allowlist = publicationAllowlist(date);
  const entries = [
    ...CATEGORIES.map((slug) => ({
      path: resolve(root, `data/reports/${date}-${slug}.json`),
      content: serializeJson(stagedReports[slug]),
    })),
    ...editionOutputEntries({ root, date, ...built }),
  ];
  const datedEntries = [entries[0], entries[1], entries[2], entries[3]];
  for (const entry of datedEntries) {
    if (existsSync(entry.path) && readFileSync(entry.path, "utf8") !== entry.content) {
      throw new Error(`Immutable dated file already exists with different content: ${entry.path}`);
    }
  }
  const noChanges = entries.every((entry) => existsSync(entry.path) && readFileSync(entry.path, "utf8") === entry.content);
  verifyRepositoryAndRemote();
  assertInitialWorktreeSafe(stagingDir);
  const preHead = git(["rev-parse", "HEAD"]).stdout.trim();
  const baseRemoteHead = fetchOriginMain();
  if (preHead !== baseRemoteHead) {
    throw new Error(`origin/main race check failed: HEAD ${preHead} is not origin/main ${baseRemoteHead}`);
  }
  if (noChanges) {
    console.log(`NO_CHANGES: edition ${date} is already present and HEAD matches origin/main.`);
    process.exit(0);
  }

  const snapshot = snapshotFiles(entries.map((entry) => entry.path));
  let committed = false;
  let commitHash;
  try {
    transactionalWriteFiles(entries);
    validateRepository(root);
    const afterWrite = statusPaths();
    const changedOutsideStage = [
      ...afterWrite.staged,
      ...afterWrite.unstaged,
      ...afterWrite.untracked.filter((path) => !pathIsWithin(stagingDir, resolve(root, path))),
    ];
    if (!sameSet(new Set(changedOutsideStage), new Set(allowlist))) {
      throw new Error(`Expected exactly the six allowlisted changes; got: ${[...new Set(changedOutsideStage)].join(", ")}`);
    }
    git(["add", "--", ...allowlist]);
    const staged = nulList(["diff", "--cached", "--name-only", "-z"]);
    if (!sameSet(new Set(staged), new Set(allowlist))) {
      throw new Error(`Staging escaped the six-file allowlist: ${staged.join(", ")}`);
    }
    git(["diff", "--cached", "--check"]);

    const latestRemoteHead = fetchOriginMain();
    if (latestRemoteHead !== baseRemoteHead || git(["rev-parse", "HEAD"]).stdout.trim() !== preHead) {
      throw new Error("origin/main changed while preparing the edition; nothing was published.");
    }
    git(["commit", "--no-gpg-sign", "-m", `Publish Daily arXiv ${date}`]);
    committed = true;
    commitHash = git(["rev-parse", "HEAD"]).stdout.trim();
    const committedPaths = nulList(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", commitHash]);
    if (!sameSet(new Set(committedPaths), new Set(allowlist))) {
      throw new Error(`Commit escaped the six-file allowlist: ${committedPaths.join(", ")}`);
    }
    const pushed = gitNetwork(["push", "origin", "HEAD:main"]);
    if (pushed.status !== 0) {
      const fetched = gitNetwork(["fetch", "--quiet", "origin", "main"]);
      const remoteAfterFailure = fetched.status === 0
        ? git(["rev-parse", "refs/remotes/origin/main"], { allowFailure: true }).stdout.trim()
        : "";
      if (remoteAfterFailure !== commitHash) {
        throw new Error(`git push failed (${pushed.status}): ${(pushed.stderr || pushed.stdout).trim()}`);
      }
    }
    console.log(`PUBLISHED: ${date} at ${commitHash} (origin/main).`);
  } catch (error) {
    try {
      rollback({ snapshot, preHead, committed });
    } catch (rollbackError) {
      error.message += `; automatic rollback failed: ${rollbackError.message}`;
    }
    throw error;
  }
} catch (error) {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
}
