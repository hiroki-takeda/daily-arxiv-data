#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
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
  assertExactOwnedInstallerFile,
  assertReviewedCodexSourceUnchanged,
  captureReviewedCodexSource,
  materializeReviewedCodexRuntime,
  plannedCodexRuntimePath,
  publishOwnedInstallerFileExclusive,
} from "./lib/codex-runtime.mjs";
import {
  LAUNCHD_LABEL,
  START_INTERVAL_SECONDS,
  assertJapanTimeZone,
  assertPrivateDirectoryMode,
  calendarIntervals,
  launchdPaths,
  renderLaunchdPlist,
} from "./lib/macos-schedule.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const homeDirectory = homedir();
const paths = launchdPaths({ repositoryRoot: root, homeDirectory });
const nodePath = stableNodePath();
const launchdPath = ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
const expectedRemote = /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)(?:hiroki-takeda\/daily-arxiv-data)(?:\.git)?$/;
const runtimePaths = Object.freeze([...new Set([
  ...AUTOMATION_RUNTIME_PATHS,
  "scripts/configure-macos-schedule.mjs",
  "scripts/lib/codex-runtime.mjs",
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

function uniqueTopLevelScalar(lines, key) {
  const prefix = `\t${key} = `;
  const matches = lines.filter((line) => line.startsWith(prefix));
  if (matches.length !== 1) {
    throw new Error(`launchctl print must contain exactly one top-level ${key} field.`);
  }
  const value = matches[0].slice(prefix.length);
  if (value.length === 0) throw new Error(`launchctl print ${key} field must not be empty.`);
  return value;
}

function uniqueTopLevelBlock(lines, key) {
  const opening = `\t${key} = {`;
  const indexes = lines
    .map((line, index) => (line === opening ? index : -1))
    .filter((index) => index >= 0);
  if (indexes.length !== 1) {
    throw new Error(`launchctl print must contain exactly one top-level ${key} block.`);
  }
  const start = indexes[0];
  const end = lines.indexOf("\t}", start + 1);
  if (end < 0) throw new Error(`launchctl print ${key} block is not closed.`);
  const entries = lines.slice(start + 1, end);
  if (entries.some((line) => !line.startsWith("\t\t"))) {
    throw new Error(`launchctl print ${key} block contains a malformed entry.`);
  }
  return entries;
}

function parseCanonicalUnsignedInteger(value, label) {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`launchctl print ${label} must be a canonical unsigned integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`launchctl print ${label} must be a safe integer.`);
  }
  return parsed;
}

function parseRunAtLoad(lines) {
  const value = uniqueTopLevelScalar(lines, "properties");
  const properties = value.split(" | ");
  const reviewedProperties = ["inferred program", "runatload"];
  if (
    properties.length === 0
    || properties.some((property) => !/^[a-z][a-z0-9 ]*$/u.test(property))
  ) {
    throw new Error("launchctl print properties field is malformed.");
  }
  if (new Set(properties).size !== properties.length) {
    throw new Error("launchctl print properties field contains duplicate properties.");
  }
  if (
    [...properties].sort().join("\0")
    !== [...reviewedProperties].sort().join("\0")
  ) {
    throw new Error(
      "launchctl print RunAtLoad does not exactly match the reviewed "
      + "runatload and inferred program property set.",
    );
  }
  return true;
}

function parseProcessType(lines) {
  const value = uniqueTopLevelScalar(lines, "spawn type");
  if (value !== "background (5)") {
    throw new Error(`launchctl print spawn type has an unsupported ProcessType mapping: ${value}`);
  }
  return "Background";
}

function parseStartInterval(lines) {
  const value = uniqueTopLevelScalar(lines, "run interval");
  const match = /^([1-9][0-9]*) seconds$/u.exec(value);
  if (!match) {
    throw new Error("launchctl print run interval must be a positive canonical number of seconds.");
  }
  return parseCanonicalUnsignedInteger(match[1], "run interval");
}

function calendarIntervalKey({ weekday, hour, minute }) {
  return `${weekday}\0${hour}\0${minute}`;
}

function assertCalendarIntervalShape(interval, label) {
  if (!interval || typeof interval !== "object" || Array.isArray(interval)) {
    throw new Error(`${label} must be an object.`);
  }
  const keys = Object.keys(interval).sort();
  if (keys.join("\0") !== "hour\0minute\0weekday") {
    throw new Error(`${label} must contain exactly weekday, hour, and minute.`);
  }
  for (const key of keys) {
    if (!Number.isSafeInteger(interval[key]) || interval[key] < 0) {
      throw new Error(`${label} ${key} must be a non-negative safe integer.`);
    }
  }
}

function parseCalendarEventTrigger(triggerLines, triggerId, serviceLabel) {
  const scalarValues = {};
  let descriptor = null;
  for (let index = 0; index < triggerLines.length; index += 1) {
    const line = triggerLines[index];
    if (line === "\t\t\tdescriptor = {") {
      if (descriptor !== null) {
        throw new Error(`launchctl print event trigger ${triggerId} contains duplicate descriptors.`);
      }
      descriptor = {};
      index += 1;
      for (; index < triggerLines.length && triggerLines[index] !== "\t\t\t}"; index += 1) {
        const match = /^\t\t\t\t"(Weekday|Hour|Minute)" => (.+)$/u.exec(triggerLines[index]);
        if (!match) {
          throw new Error(`launchctl print event trigger ${triggerId} descriptor is malformed.`);
        }
        const [, key, value] = match;
        if (Object.hasOwn(descriptor, key)) {
          throw new Error(`launchctl print event trigger ${triggerId} descriptor contains duplicate ${key}.`);
        }
        descriptor[key] = parseCanonicalUnsignedInteger(
          value,
          `event trigger ${triggerId} descriptor ${key}`,
        );
      }
      if (index >= triggerLines.length) {
        throw new Error(`launchctl print event trigger ${triggerId} descriptor is not closed.`);
      }
      continue;
    }
    const scalar = /^\t\t\t(keepalive|service|stream|monitor) = (.+)$/u.exec(line);
    if (!scalar) {
      throw new Error(`launchctl print event trigger ${triggerId} contains a malformed entry.`);
    }
    const [, key, value] = scalar;
    if (Object.hasOwn(scalarValues, key)) {
      throw new Error(`launchctl print event trigger ${triggerId} contains duplicate ${key}.`);
    }
    scalarValues[key] = value;
  }
  const scalarKeys = Object.keys(scalarValues).sort();
  if (scalarKeys.join("\0") !== "keepalive\0monitor\0service\0stream") {
    throw new Error(`launchctl print event trigger ${triggerId} metadata is incomplete.`);
  }
  if (
    scalarValues.keepalive !== "0"
    || scalarValues.service !== serviceLabel
    || scalarValues.stream !== "com.apple.launchd.calendarinterval"
    || scalarValues.monitor !== "com.apple.UserEventAgent-Aqua"
  ) {
    throw new Error(`launchctl print event trigger ${triggerId} is not the reviewed calendar trigger.`);
  }
  if (descriptor === null) {
    throw new Error(`launchctl print event trigger ${triggerId} is missing its descriptor.`);
  }
  const descriptorKeys = Object.keys(descriptor).sort();
  if (descriptorKeys.join("\0") !== "Hour\0Minute\0Weekday") {
    throw new Error(
      `launchctl print event trigger ${triggerId} descriptor must contain exactly Weekday, Hour, and Minute.`,
    );
  }
  return Object.freeze({
    weekday: descriptor.Weekday,
    hour: descriptor.Hour,
    minute: descriptor.Minute,
  });
}

function parseCalendarIntervals(lines, service) {
  const eventTriggerLines = uniqueTopLevelBlock(lines, "event triggers");
  const serviceLabel = service.split("/").at(-1);
  const intervals = [];
  const triggerIds = new Set();
  for (let index = 0; index < eventTriggerLines.length; index += 1) {
    const opening = /^\t\t([A-Za-z0-9._-]+) => \{$/u.exec(eventTriggerLines[index]);
    if (!opening) throw new Error("launchctl print event triggers block is malformed.");
    const triggerId = opening[1];
    if (triggerIds.has(triggerId)) {
      throw new Error(`launchctl print event triggers contains duplicate trigger ${triggerId}.`);
    }
    triggerIds.add(triggerId);
    const body = [];
    index += 1;
    for (; index < eventTriggerLines.length && eventTriggerLines[index] !== "\t\t}"; index += 1) {
      body.push(eventTriggerLines[index]);
    }
    if (index >= eventTriggerLines.length) {
      throw new Error(`launchctl print event trigger ${triggerId} is not closed.`);
    }
    intervals.push(parseCalendarEventTrigger(body, triggerId, serviceLabel));
  }
  const intervalKeys = intervals.map(calendarIntervalKey);
  if (new Set(intervalKeys).size !== intervalKeys.length) {
    throw new Error("launchctl print event triggers contains duplicate calendar intervals.");
  }
  return Object.freeze(intervals);
}

export function parseLaunchctlPrintService(output) {
  if (typeof output !== "string" || output.length === 0 || output.includes("\0")) {
    throw new Error("launchctl print output must be a non-empty string without NUL bytes.");
  }
  const lines = output.replaceAll("\r\n", "\n").replace(/\n+$/u, "").split("\n");
  const header = /^([^\s={}]+) = \{$/u.exec(lines[0]);
  if (!header || lines.at(-1) !== "}") {
    throw new Error("launchctl print output has an unexpected service boundary.");
  }
  const argumentLines = uniqueTopLevelBlock(lines, "arguments");
  const argumentsList = argumentLines.map((line) => {
    const value = line.slice(2);
    if (value.length === 0) throw new Error("launchctl print arguments must not contain an empty value.");
    return value;
  });
  const environmentLines = uniqueTopLevelBlock(lines, "environment");
  const environment = {};
  for (const line of environmentLines) {
    const match = /^\t\t([A-Z][A-Z0-9_]*) => (.+)$/u.exec(line);
    if (!match) throw new Error("launchctl print environment contains a malformed entry.");
    const [, key, value] = match;
    if (Object.hasOwn(environment, key)) {
      throw new Error(`launchctl print environment contains duplicate ${key}.`);
    }
    environment[key] = value;
  }
  const service = header[1];
  return Object.freeze({
    service,
    path: uniqueTopLevelScalar(lines, "path"),
    type: uniqueTopLevelScalar(lines, "type"),
    program: uniqueTopLevelScalar(lines, "program"),
    arguments: Object.freeze(argumentsList),
    workingDirectory: uniqueTopLevelScalar(lines, "working directory"),
    stdoutPath: uniqueTopLevelScalar(lines, "stdout path"),
    stderrPath: uniqueTopLevelScalar(lines, "stderr path"),
    environment: Object.freeze(environment),
    calendarIntervals: parseCalendarIntervals(lines, service),
    startInterval: parseStartInterval(lines),
    runAtLoad: parseRunAtLoad(lines),
    processType: parseProcessType(lines),
    throttleInterval: parseCanonicalUnsignedInteger(
      uniqueTopLevelScalar(lines, "minimum runtime"),
      "minimum runtime",
    ),
  });
}

function assertExactValue(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`Loaded ${LAUNCHD_LABEL} ${label} does not exactly match the reviewed plist.`);
  }
}

export function assertLaunchctlPrintServiceMatches(output, expected) {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    throw new Error("Expected launchctl service definition must be an object.");
  }
  const actual = parseLaunchctlPrintService(output);
  for (const [key, label] of [
    ["service", "service identity"],
    ["path", "plist path"],
    ["type", "service type"],
    ["program", "program"],
    ["workingDirectory", "working directory"],
    ["stdoutPath", "stdout path"],
    ["stderrPath", "stderr path"],
    ["startInterval", "StartInterval/run interval"],
    ["runAtLoad", "RunAtLoad"],
    ["processType", "ProcessType"],
    ["throttleInterval", "ThrottleInterval/minimum runtime"],
  ]) {
    assertExactValue(actual[key], expected[key], label);
  }
  if (
    !Array.isArray(expected.arguments)
    || actual.arguments.length !== expected.arguments.length
    || actual.arguments.some((value, index) => value !== expected.arguments[index])
  ) {
    throw new Error(`Loaded ${LAUNCHD_LABEL} arguments do not exactly match the reviewed plist.`);
  }
  if (!expected.environment || typeof expected.environment !== "object" || Array.isArray(expected.environment)) {
    throw new Error("Expected launchctl environment must be an object.");
  }
  const actualKeys = Object.keys(actual.environment).sort();
  const expectedKeys = Object.keys(expected.environment).sort();
  if (actualKeys.join("\0") !== expectedKeys.join("\0")) {
    throw new Error(`Loaded ${LAUNCHD_LABEL} environment keys do not exactly match the reviewed plist.`);
  }
  for (const key of expectedKeys) {
    assertExactValue(actual.environment[key], expected.environment[key], `environment ${key}`);
  }
  if (!Array.isArray(expected.calendarIntervals) || expected.calendarIntervals.length !== 10) {
    throw new Error("Expected StartCalendarInterval must contain exactly 10 entries.");
  }
  for (const [index, interval] of expected.calendarIntervals.entries()) {
    assertCalendarIntervalShape(interval, `Expected StartCalendarInterval entry ${index}`);
  }
  const expectedIntervalKeys = expected.calendarIntervals.map(calendarIntervalKey);
  if (new Set(expectedIntervalKeys).size !== expectedIntervalKeys.length) {
    throw new Error("Expected StartCalendarInterval must not contain duplicates.");
  }
  const actualSorted = actual.calendarIntervals.map(calendarIntervalKey).sort();
  const expectedSorted = expectedIntervalKeys.sort();
  if (
    actualSorted.length !== expectedSorted.length
    || actualSorted.some((value, index) => value !== expectedSorted[index])
  ) {
    throw new Error(
      `Loaded ${LAUNCHD_LABEL} StartCalendarInterval does not exactly match the reviewed plist.`,
    );
  }
  return actual;
}

function launchdEnvironment() {
  const environment = {
    HOME: homeDirectory,
    USER: process.env.USER ?? "",
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "",
    PATH: launchdPath,
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

function pinnedLaunchdEnvironment(codexIdentity) {
  return {
    ...launchdEnvironment(),
    CODEX_BIN: codexIdentity.path,
    DAILY_ARXIV_CODEX_SHA256: codexIdentity.sha256,
    DAILY_ARXIV_CODEX_VERSION: codexIdentity.version,
  };
}

function discoverReviewedCodex() {
  const environment = launchdEnvironment();
  const codexPath = discoverCodex({ env: environment, home: homeDirectory });
  const sourceReview = captureReviewedCodexSource({ path: codexPath });
  const identity = codexBinaryIdentity(codexPath, environment);
  assertReviewedCodexSourceUnchanged({ review: sourceReview });
  return identity;
}

function plannedStableCodex(reviewedSource) {
  return Object.freeze({
    path: plannedCodexRuntimePath({
      controlRoot: paths.controlRoot,
      sha256: reviewedSource.sha256,
    }),
    sha256: reviewedSource.sha256,
    version: reviewedSource.version,
  });
}

function renderedPlist(codexIdentity) {
  return renderLaunchdPlist({
    nodePath,
    homeDirectory,
    codexIdentity,
    ...paths,
  });
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

function preflightCodexIdentity(codexIdentity) {
  const sourceReview = captureReviewedCodexSource({ path: codexIdentity.path });
  const env = pinnedLaunchdEnvironment(codexIdentity);
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
  // Probe the reviewed checkout itself: the production agent worktree is a
  // sibling on the same filesystem, while system-temp roots have distinct
  // platform sandbox semantics and are not representative of that boundary.
  const deniedSentinel = resolve(root, "AGENTS.md");
  assertOwnedSafeFile(deniedSentinel, "Permission-probe read-only workspace sentinel");
  const permissionCheck = assertCodexPermissionEnforcement({
    codexBin,
    worktree: root,
    runRoot: preflightRoot,
    deniedSentinel,
    authPath: resolve(homeDirectory, ".codex", "auth.json"),
    env,
  });
  assertReviewedCodexSourceUnchanged({ review: sourceReview });
  return Object.freeze({ codexBin, configCheck, permissionCheck });
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

  const reviewedSourceCodex = discoverReviewedCodex();
  const plannedCodex = plannedStableCodex(reviewedSourceCodex);
  const env = pinnedLaunchdEnvironment(reviewedSourceCodex);
  const remoteHead = remoteMainHead(env);
  const localHead = git(["-C", root, "rev-parse", "HEAD"]).stdout.trim();
  if (localHead !== remoteHead) {
    throw new Error(`Main checkout HEAD ${localHead} must exactly match authenticated origin/main ${remoteHead}.`);
  }
  const publisher = inspectPublisherWorktree(remoteHead);
  const sourcePreflight = preflightCodexIdentity(reviewedSourceCodex);
  return {
    remoteHead,
    publisher,
    reviewedSourceCodex,
    plannedCodex,
    sourcePreflight,
    summary: [
      "READY: launchd-equivalent prerequisites passed.",
      `origin/main: ${remoteHead}`,
      `Reviewed Codex source: ${reviewedSourceCodex.path} (${reviewedSourceCodex.version}; SHA-256 ${reviewedSourceCodex.sha256})`,
      `Planned stable Codex runtime: ${plannedCodex.path}`,
      "Codex auth/model: ChatGPT login; gpt-5.6-sol / high fixed by runner",
      `Publisher: ${publisher.state}`,
      "Codex permission probe: repo read-only; runRoot write allowed; auth reads denied; arXiv network allowed; external network denied",
      "macOS system-temp scratch is treated as model-writable and contains no host-trusted automation state",
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

function assertLoadedServiceMatches(output, codexIdentity) {
  return assertLaunchctlPrintServiceMatches(output, {
    service: `gui/${process.getuid()}/${LAUNCHD_LABEL}`,
    path: paths.plistPath,
    type: "LaunchAgent",
    program: nodePath,
    arguments: [nodePath, paths.runnerPath],
    workingDirectory: paths.publisherRoot,
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
    calendarIntervals: calendarIntervals(),
    startInterval: START_INTERVAL_SECONDS,
    runAtLoad: true,
    processType: "Background",
    throttleInterval: 300,
    environment: {
      DAILY_ARXIV_CODEX_VERSION: codexIdentity.version,
      CODEX_BIN: codexIdentity.path,
      DAILY_ARXIV_AGENT_WORKTREE_BASE: paths.agentWorktreeBase,
      DAILY_ARXIV_CONTROL_ROOT: paths.controlRoot,
      DAILY_ARXIV_CODEX_SHA256: codexIdentity.sha256,
      LANG: "en_US.UTF-8",
      PATH: launchdPath,
      HOME: homeDirectory,
      XPC_SERVICE_NAME: LAUNCHD_LABEL,
    },
  });
}

function assertReviewedPlist(path, content) {
  return assertExactOwnedInstallerFile({ path, content, mode: 0o644 });
}

function install() {
  const diagnostic = checkPrerequisites();
  const plannedPlist = renderedPlist(diagnostic.plannedCodex);
  const domain = `gui/${process.getuid()}`;
  const service = `${domain}/${LAUNCHD_LABEL}`;
  const loaded = run("/bin/launchctl", ["print", service], { allowFailure: true });
  inspectExistingArtifacts();
  const plistWasPresent = existsSync(paths.plistPath);
  if (plistWasPresent) {
    try {
      assertReviewedPlist(paths.plistPath, plannedPlist);
    } catch (error) {
      throw new Error(
        `Refusing to overwrite existing ${paths.plistPath}. Review it and request an explicit replacement.`,
        { cause: error },
      );
    }
  }

  if (loaded.status === 0) {
    if (!plistWasPresent) throw new Error(`A different ${LAUNCHD_LABEL} service is loaded; no files were changed.`);
    if (!diagnostic.publisher.exists || diagnostic.publisher.head !== diagnostic.remoteHead) {
      throw new Error("Loaded scheduler publisher is not current. Stop it and review an explicit update before changing files.");
    }
    assertLoadedServiceMatches(loaded.stdout, diagnostic.plannedCodex);
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

  const materialized = materializeReviewedCodexRuntime({
    controlRoot: paths.controlRoot,
    sourceIdentity: diagnostic.reviewedSourceCodex,
  });
  const stableEnvironment = pinnedLaunchdEnvironment(materialized);
  const stableReview = captureReviewedCodexSource({ path: materialized.path });
  const stableCodex = codexBinaryIdentity(materialized.path, stableEnvironment);
  assertReviewedCodexSourceUnchanged({ review: stableReview });
  if (
    stableCodex.path !== diagnostic.plannedCodex.path
    || stableCodex.sha256 !== diagnostic.plannedCodex.sha256
    || stableCodex.version !== diagnostic.plannedCodex.version
  ) {
    throw new Error("Materialized Codex runtime does not match the fully reviewed source identity.");
  }
  preflightCodexIdentity(stableCodex);
  const stablePlist = renderedPlist(stableCodex);
  if (stablePlist !== plannedPlist) {
    throw new Error("Stable Codex plist changed after materialization; no service was loaded.");
  }

  let created = false;
  if (!plistWasPresent) {
    publishOwnedInstallerFileExclusive({
      path: paths.plistPath,
      content: stablePlist,
      mode: 0o644,
    });
    created = true;
  }
  console.log("STARTING_INITIAL_CATCH_UP: loading the user service will immediately check and may publish the latest missing edition.");
  assertReviewedPlist(paths.plistPath, stablePlist);
  run("/bin/launchctl", ["bootstrap", domain, paths.plistPath]);
  const registered = run("/bin/launchctl", ["print", service]);
  assertLoadedServiceMatches(registered.stdout, stableCodex);
  console.log([
    created ? `CREATED: ${paths.plistPath}` : `UNCHANGED: ${paths.plistPath}`,
    `CREATED_OR_REUSED_PUBLISHER: ${paths.publisherRoot}`,
    `${materialized.reused ? "REUSED" : "CREATED"}_STABLE_CODEX_RUNTIME: ${stableCodex.path}`,
    `LOADED: ${service}`,
    diagnostic.summary,
    "Schedule: hourly while the user service is available, weekdays at 11:30 and 16:30 Asia/Tokyo, plus one catch-up check when it loads.",
  ].join("\n"));
}

function runCli(argv = process.argv.slice(2)) {
  const [command = "check", ...extra] = argv;
  try {
    if (extra.length || !["check", "print", "install"].includes(command)) {
      throw new Error("Usage: node scripts/configure-macos-schedule.mjs [check|print|install]");
    }
    if (command === "print") {
      const reviewedSourceCodex = discoverReviewedCodex();
      process.stdout.write(renderedPlist(plannedStableCodex(reviewedSourceCodex)));
    }
    if (command === "check") console.log(checkPrerequisites().summary);
    if (command === "install") install();
  } catch (error) {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  }
}

function isInvokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isInvokedDirectly()) runCli();
