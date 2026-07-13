#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTOMATION_RUNTIME_PATHS,
  assertChatGptLogin,
  assertCodexConfiguration,
  assertCodexPermissionEnforcement,
  assertPinnedCodexIdentity,
  codexBinaryIdentity,
  discoverCodex,
} from "./lib/local-automation.mjs";
import {
  LAUNCHD_LABEL,
  assertJapanTimeZone,
  assertPrivateDirectoryMode,
  launchdPaths,
  renderLaunchdPlist,
} from "./lib/macos-schedule.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const homeDirectory = homedir();
const paths = launchdPaths({ repositoryRoot: root, homeDirectory });
const nodePath = stableNodePath();
const codexDiscoveryEnvironment = launchdEnvironment();
const reviewedCodex = codexBinaryIdentity(
  discoverCodex({ env: codexDiscoveryEnvironment, home: homeDirectory }),
  codexDiscoveryEnvironment,
);
const plist = renderLaunchdPlist({ nodePath, homeDirectory, codexIdentity: reviewedCodex, ...paths });
const expectedRemote = /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)(?:hiroki-takeda\/daily-arxiv-data)(?:\.git)?$/;
const runtimePaths = Object.freeze([...new Set([
  ...AUTOMATION_RUNTIME_PATHS,
  "scripts/configure-macos-schedule.mjs",
  "scripts/probe-codex-sandbox.mjs",
])].sort());

function stableNodePath() {
  for (const candidate of ["/usr/local/bin/node", "/opt/homebrew/bin/node", process.execPath]) {
    try {
      accessSync(candidate, constants.X_OK);
      if (realpathSync(candidate) === realpathSync(process.execPath)) return candidate;
    } catch {
      // Try the next stable executable path.
    }
  }
  throw new Error(`Cannot find a stable path for the running Node.js executable ${process.execPath}.`);
}

function run(command, args, {
  allowFailure = false,
  timeout = 30_000,
  cwd = root,
  env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
} = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env, timeout });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} ${args[0] ?? ""} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`);
  }
  return result;
}

function launchdEnvironment() {
  const environment = {
    HOME: homeDirectory,
    USER: process.env.USER ?? "",
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "",
    PATH: ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    LANG: "en_US.UTF-8",
    SHELL: "/bin/zsh",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    DAILY_ARXIV_AGENT_WORKTREE_BASE: paths.agentWorktreeBase,
    DAILY_ARXIV_CONTROL_ROOT: paths.controlRoot,
  };
  for (const key of ["TMPDIR", "LC_CTYPE", "__CF_USER_TEXT_ENCODING"]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  const socket = run("/bin/launchctl", ["getenv", "SSH_AUTH_SOCK"], { allowFailure: true }).stdout.trim();
  if (socket) environment.SSH_AUTH_SOCK = socket;
  return environment;
}

function pinnedLaunchdEnvironment() {
  return {
    ...launchdEnvironment(),
    CODEX_BIN: reviewedCodex.path,
    DAILY_ARXIV_CODEX_SHA256: reviewedCodex.sha256,
    DAILY_ARXIV_CODEX_VERSION: reviewedCodex.version,
  };
}

function git(args, options = {}) {
  return run("/usr/bin/git", args, options);
}

function commonGitDirectory(worktree) {
  const value = git(["-C", worktree, "rev-parse", "--git-common-dir"]).stdout.trim();
  return realpathSync(resolve(worktree, value));
}

function inspectPublisherWorktree(remoteHead) {
  if (!existsSync(paths.publisherRoot)) return { exists: false, state: "absent-would-create-on-install" };
  assertOwnedSafeDirectory(paths.publisherRoot, "Publisher worktree");
  const gitEntry = resolve(paths.publisherRoot, ".git");
  if (!existsSync(gitEntry) || !lstatSync(gitEntry).isFile()) {
    throw new Error(`Refusing existing non-worktree publisher path: ${paths.publisherRoot}`);
  }
  if (commonGitDirectory(paths.publisherRoot) !== commonGitDirectory(root)) {
    throw new Error(`Publisher worktree belongs to another repository: ${paths.publisherRoot}`);
  }
  const status = git(["-C", paths.publisherRoot, "status", "--porcelain=v1", "--untracked-files=all"]).stdout.trim();
  if (status) throw new Error(`Publisher worktree is not clean: ${paths.publisherRoot}`);
  const head = git(["-C", paths.publisherRoot, "rev-parse", "HEAD"]).stdout.trim();
  return {
    exists: true,
    head,
    state: head === remoteHead ? `installed-current:${head}` : `installed-clean-would-update:${head}`,
  };
}

function remoteMainHead(env) {
  const result = git(["ls-remote", "--exit-code", "origin", "refs/heads/main"], { env, timeout: 120_000 });
  const hash = result.stdout.trim().split(/\s+/u)[0];
  if (!/^[a-f0-9]{40}$/u.test(hash)) throw new Error("Could not parse origin/main from git ls-remote.");
  return hash;
}

function ensureExactProbeFile(path, content, label) {
  if (!existsSync(path)) {
    const descriptor = openSync(path, "wx", 0o600);
    try {
      writeFileSync(descriptor, content, "utf8");
    } finally {
      closeSync(descriptor);
    }
  }
  assertOwnedSafeFile(path, label);
  if (readFileSync(path, "utf8") !== content) {
    throw new Error(`${label} has unexpected content: ${path}`);
  }
}

function checkPrerequisites() {
  if (process.getuid() === 0 || process.env.SUDO_USER) {
    throw new Error("Run this command as the logged-in user, never with sudo.");
  }
  assertJapanTimeZone();
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 22) throw new Error("Node.js 22 or newer is required.");
  const sourceRunner = resolve(root, "scripts", "run-local-automation.mjs");
  if (!existsSync(sourceRunner)) throw new Error(`Missing source runner: ${sourceRunner}`);
  const top = git(["-C", root, "rev-parse", "--show-toplevel"]).stdout.trim();
  if (resolve(top) !== root) throw new Error(`Expected Git root ${root}, got ${top}`);
  for (const direction of [[], ["--push"]]) {
    const remote = git(["-C", root, "remote", "get-url", ...direction, "origin"]).stdout.trim();
    if (!expectedRemote.test(remote)) throw new Error(`Unexpected origin URL: ${remote}`);
  }
  git(["-C", root, "ls-files", "--error-unmatch", ...runtimePaths]);
  const status = git(["-C", root, "status", "--porcelain=v1", "--untracked-files=all"]).stdout.trim();
  if (status !== "") throw new Error("Refusing scheduler setup from a dirty main checkout.");

  const env = pinnedLaunchdEnvironment();
  const remoteHead = remoteMainHead(env);
  const localHead = git(["-C", root, "rev-parse", "HEAD"]).stdout.trim();
  if (localHead !== remoteHead) {
    throw new Error(`Main checkout HEAD ${localHead} must exactly match authenticated origin/main ${remoteHead}.`);
  }
  const publisher = inspectPublisherWorktree(remoteHead);
  const codexBin = discoverCodex({ env, home: homeDirectory });
  assertPinnedCodexIdentity(codexBin, env);
  assertChatGptLogin(codexBin, env);
  const preflightRoot = `/tmp/daily-arxiv-config-preflight-${process.getuid()}`;
  const configCheck = assertCodexConfiguration({
    codexBin,
    worktree: root,
    runRoot: preflightRoot,
    env,
  });
  const workspaceMarker = "Daily arXiv disposable read-only permission-probe workspace.\n";
  const probeHelper = readFileSync(resolve(root, "scripts", "probe-codex-sandbox.mjs"), "utf8");
  const probeVersion = createHash("sha256")
    .update(workspaceMarker)
    .update("\0")
    .update(probeHelper)
    .digest("hex")
    .slice(0, 16);
  const probeNonce = randomBytes(6).toString("hex");
  const permissionWorkspace = `/tmp/daily-arxiv-permission-workspace-${process.getuid()}-${probeVersion}-${process.pid}-${probeNonce}`;
  const permissionScripts = join(permissionWorkspace, "scripts");
  ensureDirectory(permissionWorkspace, "Permission-probe workspace", { privateDirectory: true });
  ensureDirectory(permissionScripts, "Permission-probe scripts", { privateDirectory: true });
  ensureExactProbeFile(
    join(permissionWorkspace, "AGENTS.md"),
    workspaceMarker,
    "Permission-probe workspace marker",
  );
  ensureExactProbeFile(
    join(permissionScripts, "probe-codex-sandbox.mjs"),
    probeHelper,
    "Permission-probe helper copy",
  );
  const deniedSentinel = join(permissionWorkspace, "repo-write-sentinel.txt");
  const sentinelContent = "Daily arXiv permission probe: this workspace must remain read-only to the model sandbox.\n";
  ensureExactProbeFile(deniedSentinel, sentinelContent, "Permission-probe read-only workspace sentinel");
  if (existsSync(`${deniedSentinel}.write-attempt`)) {
    throw new Error(`A prior denied-write probe unexpectedly created ${deniedSentinel}.write-attempt; inspect it manually.`);
  }
  const permissionCheck = assertCodexPermissionEnforcement({
    codexBin,
    worktree: permissionWorkspace,
    runRoot: preflightRoot,
    deniedSentinel,
    authPath: resolve(homeDirectory, ".codex", "auth.json"),
    env,
  });
  return {
    remoteHead,
    publisher,
    codexBin,
    configCheck,
    permissionCheck,
    summary: [
      "READY: launchd-equivalent prerequisites passed.",
      `origin/main: ${remoteHead}`,
      `Codex: ${codexBin} (${reviewedCodex.version}; SHA-256 ${reviewedCodex.sha256})`,
      "Codex auth/model: ChatGPT login; gpt-5.6-sol / ultra fixed by runner",
      `Publisher: ${publisher.state}`,
      "Codex permission probe: repo read-only/runRoot write allowed; out-of-run writes and auth reads denied; arXiv network allowed; external network denied",
    ].join("\n"),
  };
}

function assertOwnedSafeDirectory(path, label, { privateDirectory = false } = {}) {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`${label} must be a real directory: ${path}`);
  if (entry.uid !== process.getuid()) throw new Error(`${label} is owned by another user: ${path}`);
  if ((entry.mode & 0o022) !== 0) throw new Error(`${label} must not be group/world writable: ${path}`);
  if (privateDirectory) assertPrivateDirectoryMode(entry.mode, `${label}: ${path}`);
}

function assertOwnedSafeFile(path, label) {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`${label} must be a regular file: ${path}`);
  if (entry.uid !== process.getuid()) throw new Error(`${label} is owned by another user: ${path}`);
  if ((entry.mode & 0o022) !== 0) throw new Error(`${label} must not be group/world writable: ${path}`);
}

function inspectExistingArtifacts() {
  const launchAgents = resolve(homeDirectory, "Library", "LaunchAgents");
  if (existsSync(launchAgents)) assertOwnedSafeDirectory(launchAgents, "LaunchAgents directory");
  if (existsSync(paths.plistPath)) assertOwnedSafeFile(paths.plistPath, "LaunchAgent plist");
  if (existsSync(paths.controlRoot)) assertOwnedSafeDirectory(paths.controlRoot, "Automation control root", { privateDirectory: true });
  if (existsSync(paths.logDirectory)) assertOwnedSafeDirectory(paths.logDirectory, "Automation log directory", { privateDirectory: true });
  for (const logPath of [paths.stdoutPath, paths.stderrPath]) {
    if (existsSync(logPath)) assertOwnedSafeFile(logPath, "Automation log file");
  }
}

function preparePublisherWorktree(remoteHead) {
  const existing = inspectPublisherWorktree(remoteHead);
  if (!existing.exists) {
    git(["-C", root, "worktree", "add", "--detach", paths.publisherRoot, remoteHead], { timeout: 120_000 });
  } else if (existing.head !== remoteHead) {
    git(["-C", paths.publisherRoot, "switch", "--detach", remoteHead], { timeout: 120_000 });
  }
  const finalState = inspectPublisherWorktree(remoteHead);
  if (!finalState.exists || finalState.head !== remoteHead || !existsSync(paths.runnerPath)) {
    throw new Error("Installed publisher worktree is not exactly at reviewed origin/main.");
  }
}

function ensureDirectory(path, label, { privateDirectory = false } = {}) {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700, recursive: true });
  assertOwnedSafeDirectory(path, label, { privateDirectory });
}

function assertLoadedServiceMatches(output) {
  for (const expected of [
    nodePath,
    paths.runnerPath,
    paths.publisherRoot,
    paths.agentWorktreeBase,
    paths.controlRoot,
    reviewedCodex.path,
    reviewedCodex.sha256,
    reviewedCodex.version,
  ]) {
    if (!output.includes(expected)) throw new Error(`Loaded ${LAUNCHD_LABEL} does not match the reviewed plist (${expected}).`);
  }
}

function writePlistExclusive(path, content) {
  const temporary = `${path}.new-${process.pid}-${randomBytes(6).toString("hex")}`;
  const descriptor = openSync(temporary, "wx", 0o644);
  try {
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  // link(2) fails with EEXIST instead of replacing a plist created by a race.
  linkSync(temporary, path);
  unlinkSync(temporary);
}

function install() {
  const diagnostic = checkPrerequisites();
  const domain = `gui/${process.getuid()}`;
  const service = `${domain}/${LAUNCHD_LABEL}`;
  const loaded = run("/bin/launchctl", ["print", service], { allowFailure: true });
  inspectExistingArtifacts();
  if (existsSync(paths.plistPath) && readFileSync(paths.plistPath, "utf8") !== plist) {
    throw new Error(`Refusing to overwrite existing ${paths.plistPath}. Review it and request an explicit replacement.`);
  }

  if (loaded.status === 0) {
    if (!existsSync(paths.plistPath)) throw new Error(`A different ${LAUNCHD_LABEL} service is loaded; no files were changed.`);
    if (!diagnostic.publisher.exists || diagnostic.publisher.head !== diagnostic.remoteHead) {
      throw new Error("Loaded scheduler publisher is not current. Stop it and review an explicit update before changing files.");
    }
    assertLoadedServiceMatches(loaded.stdout);
    throw new Error(
      `${service} is already loaded. No install files were changed; use launchctl print for status. `
      + "This installer never assumes that an in-memory launchd schedule matches the plist on disk.",
    );
  }

  if (existsSync(resolve(paths.controlRoot, "active-run.lock"))) {
    throw new Error("An existing Daily arXiv manual run owns the active lock; wait for it to finish before install.");
  }

  preparePublisherWorktree(diagnostic.remoteHead);
  ensureDirectory(paths.controlRoot, "Automation control root", { privateDirectory: true });
  ensureDirectory(paths.logDirectory, "Automation log directory", { privateDirectory: true });
  const launchAgentsDirectory = dirname(paths.plistPath);
  ensureDirectory(launchAgentsDirectory, "LaunchAgents directory");

  let created = false;
  if (!existsSync(paths.plistPath)) {
    writePlistExclusive(paths.plistPath, plist);
    created = true;
  }
  console.log("STARTING_INITIAL_CATCH_UP: loading the user service will immediately check and may publish the latest missing edition.");
  run("/bin/launchctl", ["bootstrap", domain, paths.plistPath]);
  const registered = run("/bin/launchctl", ["print", service]);
  assertLoadedServiceMatches(registered.stdout);
  console.log([
    created ? `CREATED: ${paths.plistPath}` : `UNCHANGED: ${paths.plistPath}`,
    `CREATED_OR_REUSED_PUBLISHER: ${paths.publisherRoot}`,
    `LOADED: ${service}`,
    diagnostic.summary,
    "Schedule: weekdays at 11:30 and 16:30 Asia/Tokyo, plus one catch-up check when the user service loads.",
  ].join("\n"));
}

const [command = "check", ...extra] = process.argv.slice(2);

try {
  if (extra.length || !["check", "print", "install"].includes(command)) {
    throw new Error("Usage: node scripts/configure-macos-schedule.mjs [check|print|install]");
  }
  if (command === "print") process.stdout.write(plist);
  if (command === "check") console.log(checkPrerequisites().summary);
  if (command === "install") install();
} catch (error) {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
}
