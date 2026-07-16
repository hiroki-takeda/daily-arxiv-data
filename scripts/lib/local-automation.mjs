import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import {
  classifySnapshotDate,
  fetchOfficialListingSnapshot,
  fetchOfficialPastweekWindow,
  probeOfficialFullTextReadiness,
  revalidatePastweekSnapshot,
  selectBackfillSnapshot,
  validateReportsAgainstSnapshot,
} from "./arxiv-source.mjs";
import { parseJsonFile, validateProductionReportSet } from "./pipeline.mjs";

export const MODEL_ID = "gpt-5.6-sol";
export const MODEL_DISPLAY_NAME = "GPT-5.6-Sol";
export const REASONING_EFFORT = "high";
export const CATEGORIES = Object.freeze(["quant-ph", "gr-qc", "hep-th"]);
export const MANIFEST_SCHEMA = "1.0";
export const EXPECTED_REMOTE = /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)(?:hiroki-takeda\/daily-arxiv-data)(?:\.git)?$/;

const RUN_ID_PATTERN = /^run-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_REPORT_BYTES = 10 * 1024 * 1024;
const MAX_LOCK_BYTES = 64 * 1024;
const MAX_CODEX_LOG_BYTES = 20 * 1024 * 1024;
const STALE_LOCK_MS = 5 * 60 * 60 * 1000;
export const AUTOMATION_RUNTIME_PATHS = Object.freeze([
  ".codex/rules/daily-arxiv.rules",
  "AGENTS.md",
  "data/distinguished-authors.json",
  "data/model-policy.json",
  "docs/SCHEDULED_TASK_PROMPT.md",
  "package.json",
  "scripts/audit-staged-language.mjs",
  "scripts/extract-arxiv-source.mjs",
  "scripts/lib/arxiv-source.mjs",
  "scripts/lib/local-automation.mjs",
  "scripts/lib/macos-schedule.mjs",
  "scripts/lib/pipeline.mjs",
  "scripts/publish-edition.mjs",
  "scripts/run-local-automation.mjs",
  "scripts/validate-staged-reports.mjs",
]);

function fail(message) {
  throw new Error(message);
}

export function parseMode(argv) {
  if (argv.length === 0) return "run";
  if (argv.length === 1 && argv[0] === "--check") return "check";
  fail("Usage: node scripts/run-local-automation.mjs [--check]");
}

export function validateRunId(runId) {
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    fail("Invalid automation runId.");
  }
  return runId;
}

export function makeRunId(now = new Date(), randomHex = randomBytes(6).toString("hex")) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) fail("Cannot create runId from an invalid date.");
  if (!/^[a-f0-9]{12}$/.test(randomHex)) fail("runId random suffix must be 12 lowercase hexadecimal characters.");
  const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return validateRunId(`run-${timestamp}-${randomHex}`);
}

export function classifyFullTextReadiness(readiness, { isLatestAnnouncement }) {
  if (readiness === null || typeof readiness !== "object" || Array.isArray(readiness)) {
    fail("Full-text readiness result must be an object.");
  }
  if (typeof isLatestAnnouncement !== "boolean") {
    fail("Full-text readiness classification requires isLatestAnnouncement.");
  }
  if (readiness.ready === true) return "ready";
  const status = readiness.unavailable?.status;
  if (status !== null && !Number.isInteger(status)) {
    fail("Full-text readiness result has an invalid HTTP status.");
  }
  if (status === null || [408, 425, 429, 500, 502, 503, 504].includes(status)) return "defer";
  if (status === 404 && isLatestAnnouncement) return "defer";
  return "fail";
}

export function validateDate(value) {
  const match = typeof value === "string" ? DATE_PATTERN.exec(value) : null;
  if (!match) fail("Manifest reportDate must use YYYY-MM-DD.");
  const date = new Date(`${value}T00:00:00Z`);
  if (
    Number.isNaN(date.getTime())
    || date.getUTCFullYear() !== Number(match[1])
    || date.getUTCMonth() + 1 !== Number(match[2])
    || date.getUTCDate() !== Number(match[3])
  ) {
    fail("Manifest reportDate is not a real calendar date.");
  }
  return value;
}

function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function extensionCandidates({ home, platform, arch }) {
  if (platform !== "darwin") return [];
  const preferredArchitecture = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : arch;
  // An Intel Node.js process can run under Rosetta on Apple Silicon. In that
  // case process.arch is x64 while the installed ChatGPT extension correctly
  // contains only the native aarch64 Codex binary.
  const architectures = [...new Set([preferredArchitecture, "aarch64", "x86_64"])];
  const extensionRoots = [
    join(home, ".vscode", "extensions"),
    join(home, ".vscode-insiders", "extensions"),
  ];
  const candidates = [];
  for (const extensionRoot of extensionRoots) {
    if (!existsSync(extensionRoot)) continue;
    const versions = readdirSync(extensionRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("openai.chatgpt-"))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
    for (const version of versions) {
      for (const architecture of architectures) {
        candidates.push(join(extensionRoot, version, "bin", `macos-${architecture}`, "codex"));
      }
    }
  }
  return candidates;
}

export function discoverCodex({
  env = process.env,
  home = homedir(),
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const candidates = [];
  if (env.CODEX_BIN) {
    if (!isAbsolute(env.CODEX_BIN)) fail("CODEX_BIN must be an absolute path.");
    if (!executable(env.CODEX_BIN)) fail(`Pinned CODEX_BIN is not executable: ${env.CODEX_BIN}`);
    return realpathSync(env.CODEX_BIN);
  }
  for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    candidates.push(join(directory, "codex"));
  }
  candidates.push(...extensionCandidates({ home, platform, arch }));
  for (const candidate of candidates) {
    if (executable(candidate)) return realpathSync(candidate);
  }
  fail("Codex CLI was not found. Set CODEX_BIN to the absolute CLI path or install/update the ChatGPT VS Code extension.");
}

function codexBinarySha256(realPath, env) {
  const hashResult = runCommand("/usr/bin/shasum", ["-a", "256", realPath], {
    env: sanitizedChildEnv(env),
    timeout: 120_000,
  });
  const sha256 = /^([a-f0-9]{64})\s/u.exec(hashResult.stdout)?.[1];
  if (!sha256) fail(`Could not calculate the Codex binary SHA-256: ${realPath}`);
  return sha256;
}

function codexBinaryVersion(realPath, env) {
  const versionResult = runCommand(realPath, ["--version"], {
    env: sanitizedChildEnv(env),
    timeout: 30_000,
  });
  const version = versionResult.stdout.trim();
  if (!/^codex-cli \S+$/u.test(version)) fail(`Unexpected Codex version output: ${version}`);
  return version;
}

export function codexBinaryIdentity(codexBin, env = process.env) {
  const realPath = realpathSync(codexBin);
  const sha256 = codexBinarySha256(realPath, env);
  const version = codexBinaryVersion(realPath, env);
  return Object.freeze({ path: realPath, sha256, version });
}

export function assertPinnedCodexIdentity(codexBin, env = process.env) {
  const expectedPath = env.CODEX_BIN;
  const expectedSha256 = env.DAILY_ARXIV_CODEX_SHA256;
  const expectedVersion = env.DAILY_ARXIV_CODEX_VERSION;
  if (!isAbsolute(expectedPath ?? "") || !/^[a-f0-9]{64}$/u.test(expectedSha256 ?? "") || !/^codex-cli \S+$/u.test(expectedVersion ?? "")) {
    fail("Scheduled Codex path, SHA-256, and version must all be pinned by the reviewed launchd plist.");
  }
  const actualPath = realpathSync(codexBin);
  const expectedRealPath = realpathSync(expectedPath);
  if (actualPath !== expectedRealPath) {
    fail("Pinned Codex binary identity changed. Re-run the reviewed scheduler installer before any model invocation.");
  }
  const actualSha256 = codexBinarySha256(actualPath, env);
  if (actualSha256 !== expectedSha256) {
    fail("Pinned Codex binary identity changed. Re-run the reviewed scheduler installer before any model invocation.");
  }
  // Never execute an updated or replaced binary merely to ask its version.
  // The reviewed digest must match before the first Codex process starts.
  const actualVersion = codexBinaryVersion(actualPath, env);
  if (actualVersion !== expectedVersion) {
    fail("Pinned Codex binary identity changed. Re-run the reviewed scheduler installer before any model invocation.");
  }
  const actual = Object.freeze({ path: actualPath, sha256: actualSha256, version: actualVersion });
  return actual;
}

function resolveSiblingPath(root, configuredPath, defaultName, label) {
  const expected = configuredPath
    ? resolve(configuredPath)
    : resolve(dirname(root), defaultName);
  if (expected === resolve(root)) fail(`${label} must not be the running checkout.`);
  if (dirname(expected) !== dirname(resolve(root))) {
    fail(`${label} must be a sibling of the running checkout.`);
  }
  return expected;
}

export function resolveAgentWorktreeBase(root, configuredPath) {
  const repositoryName = basename(root).replace(/-publisher$/, "");
  return resolveSiblingPath(root, configuredPath, `${repositoryName}-agent`, "Agent worktree");
}

export function resolvePublisherWorktreePath(root, configuredPath) {
  return resolveSiblingPath(root, configuredPath, `${basename(root)}-publisher`, "Publisher worktree");
}

export function automationControlRoot(home = homedir(), configuredPath) {
  const expected = resolve(home, "Library", "Application Support", "Daily arXiv");
  const path = configuredPath ? resolve(configuredPath) : expected;
  if (!isAbsolute(path)) fail("Automation control root must be absolute.");
  if (path !== expected) fail(`Automation control root must remain fixed at ${expected}.`);
  return path;
}

export function automationTempRoot(uid = typeof process.getuid === "function" ? process.getuid() : 0) {
  if (!Number.isSafeInteger(uid) || uid < 0) fail("Cannot determine a safe local uid for the automation temp root.");
  return `/tmp/daily-arxiv-automation-${uid}`;
}

export function runPaths(runId, {
  uid = typeof process.getuid === "function" ? process.getuid() : 0,
  controlRoot = automationControlRoot(),
} = {}) {
  validateRunId(runId);
  const base = automationTempRoot(uid);
  const runRoot = join(base, runId);
  return Object.freeze({
    base,
    controlRoot,
    lock: join(controlRoot, "active-run.lock"),
    lockHistory: join(controlRoot, "lock-history"),
    staleLocks: join(controlRoot, "stale-locks"),
    logDirectory: join(controlRoot, "logs"),
    codexLog: join(controlRoot, "logs", `${runId}.codex.log`),
    runRoot,
    staging: join(runRoot, "staging"),
    outbox: join(runRoot, "outbox"),
    manifest: join(runRoot, "outbox", "manifest.json"),
    agentHome: join(runRoot, "home"),
    hostStaging: join(controlRoot, "host-staging", runId),
  });
}

function exactKeys(object, expected, label) {
  if (!object || typeof object !== "object" || Array.isArray(object)) fail(`${label} must be a JSON object.`);
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (actual.join("\0") !== wanted.join("\0")) {
    fail(`${label} must contain exactly: ${wanted.join(", ")}.`);
  }
}

function assertPlainDirectory(path, label) {
  if (!existsSync(path)) fail(`${label} does not exist: ${path}`);
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) fail(`${label} must be a real directory, not a symlink: ${path}`);
}

function assertPlainFile(path, label) {
  if (!existsSync(path)) fail(`${label} does not exist: ${path}`);
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isFile()) fail(`${label} must be a real file, not a symlink: ${path}`);
}

export function validateManifest(manifestPath, { runId, stagingPath }) {
  validateRunId(runId);
  const outboxPath = dirname(manifestPath);
  const runRoot = dirname(outboxPath);
  assertPlainDirectory(runRoot, "Run directory");
  assertPlainDirectory(outboxPath, "Outbox directory");
  assertPlainDirectory(stagingPath, "Staging directory");
  assertPlainFile(manifestPath, "Automation manifest");
  const outboxFiles = readdirSync(outboxPath).sort();
  if (outboxFiles.join("\0") !== "manifest.json") {
    fail("Outbox directory must contain only manifest.json.");
  }
  if (statSync(manifestPath).size > MAX_MANIFEST_BYTES) fail("Automation manifest is unexpectedly large.");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(`Automation manifest is not valid JSON: ${error.message}`);
  }
  exactKeys(
    manifest,
    ["schemaVersion", "runId", "status", "reportDate", "stagingDirectory", "reportFiles", "message"],
    "Automation manifest",
  );
  if (manifest.schemaVersion !== MANIFEST_SCHEMA) fail(`Manifest schemaVersion must be ${MANIFEST_SCHEMA}.`);
  if (manifest.runId !== runId) fail("Manifest runId does not match the host-generated runId.");
  if (typeof manifest.message !== "string" || manifest.message.length < 1 || manifest.message.length > 2_000) {
    fail("Manifest message must contain 1 to 2000 characters.");
  }
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(manifest.message)) {
    fail("Manifest message must be a single line without control characters.");
  }
  if (manifest.stagingDirectory !== stagingPath) fail("Manifest stagingDirectory does not match the fixed host path.");
  if (!Array.isArray(manifest.reportFiles)) fail("Manifest reportFiles must be an array.");

  if (manifest.status !== "ready") fail("Manifest status must be ready.");

  const date = validateDate(manifest.reportDate);
  const expectedFiles = CATEGORIES.map((category) => `${date}-${category}.json`);
  if (manifest.reportFiles.join("\0") !== expectedFiles.join("\0")) {
    fail(`Manifest reportFiles must be exactly: ${expectedFiles.join(", ")}.`);
  }
  const actualFiles = readdirSync(stagingPath).sort();
  const sortedExpected = [...expectedFiles].sort();
  if (actualFiles.join("\0") !== sortedExpected.join("\0")) {
    fail(`Staging directory must contain exactly: ${sortedExpected.join(", ")}.`);
  }
  for (const file of expectedFiles) {
    const path = join(stagingPath, file);
    assertPlainFile(path, `Staged report ${file}`);
    if (statSync(path).size > MAX_REPORT_BYTES) fail(`Staged report ${file} exceeds the 10 MiB safety limit.`);
  }
  return Object.freeze({ status: "ready", date, stagingPath, message: manifest.message });
}

export function permissionProfileOverrides(runRoot) {
  if (!isAbsolute(runRoot)) fail("Permission-profile runRoot must be absolute.");
  return Object.freeze([
    'default_permissions="daily_arxiv_model"',
    // Start from a closed custom profile instead of extending :workspace. The
    // model can inspect but not edit the agent checkout, and the only trusted
    // automation path it may edit is the exact host-created run root. Current
    // macOS Codex runtime defaults still retain writable system-temp scratch;
    // no secret or host-trusted automation state may be stored there.
    `permissions.daily_arxiv_model.filesystem={":root"="deny",":minimal"="read","/usr/local"="read","/opt/homebrew"="read",":slash_tmp"="deny","~/.codex"="deny",":workspace_roots"={"."="read"},${JSON.stringify(runRoot)}="write"}`,
    'permissions.daily_arxiv_model.network={enabled=true,allow_upstream_proxy=false,enable_socks5=false,enable_socks5_udp=false,domains={"arxiv.org"="allow","export.arxiv.org"="allow"}}',
  ]);
}

export function buildCodexArgs({ worktree, runRoot }) {
  const agentHome = join(runRoot, "home");
  return [
    "--strict-config",
    "--search",
    "--model", MODEL_ID,
    "--config", `model_reasoning_effort=\"${REASONING_EFFORT}\"`,
    "--config", "check_for_update_on_startup=false",
    "--config", "include_apps_instructions=false",
    "--config", "features.apps=false",
    "--config", "features.plugins=false",
    "--config", "features.remote_plugin=false",
    "--config", "features.connectors=false",
    "--config", "features.hooks=false",
    "--config", "features.codex_hooks=false",
    "--config", "features.browser_use=false",
    "--config", "features.in_app_browser=false",
    "--config", "features.computer_use=false",
    "--config", "features.image_generation=false",
    "--config", "features.tool_search=false",
    "--config", "features.multi_agent=false",
    "--config", "features.collab=false",
    "--config", "features.auth_elicitation=false",
    "--config", "features.request_permissions=false",
    "--config", "features.guardian_approval=false",
    ...permissionProfileOverrides(runRoot).flatMap((override) => ["--config", override]),
    "--config", "allow_login_shell=false",
    "--config", "features.network_proxy.enabled=true",
    "--config", "features.prevent_idle_sleep=true",
    "--config", 'tools.web_search={context_size="medium",allowed_domains=["arxiv.org","export.arxiv.org"]}',
    "--config", `projects.${JSON.stringify(worktree)}.trust_level=\"trusted\"`,
    "--config", 'shell_environment_policy.inherit="core"',
    "--config", 'shell_environment_policy.exclude=["SSH_AUTH_SOCK","CODEX_HOME","GITHUB_*","GH_*","*KEY*","*TOKEN*","*SECRET*","*PASSWORD*"]',
    "--config", `shell_environment_policy.set.HOME=${JSON.stringify(agentHome)}`,
    "--config", `shell_environment_policy.set.TMPDIR=${JSON.stringify(runRoot)}`,
    "--config", `shell_environment_policy.set.TMP=${JSON.stringify(runRoot)}`,
    "--config", `shell_environment_policy.set.TEMP=${JSON.stringify(runRoot)}`,
    "--config", 'shell_environment_policy.set.GIT_CONFIG_GLOBAL="/dev/null"',
    "--config", 'shell_environment_policy.set.GIT_CONFIG_SYSTEM="/dev/null"',
    "--config", 'shell_environment_policy.set.GIT_ASKPASS="/usr/bin/false"',
    "--config", 'shell_environment_policy.set.SSH_ASKPASS="/usr/bin/false"',
    "--config", 'shell_environment_policy.set.GIT_SSH_COMMAND="/usr/bin/false"',
    "--ask-for-approval", "never",
    "--cd", worktree,
    "exec",
    "--ignore-user-config",
    "--ephemeral",
    "--color", "never",
    "-",
  ];
}

export function buildAutomationPrompt({ runId, staging, snapshot }) {
  validateRunId(runId);
  if (!snapshot || typeof snapshot !== "object") fail("An official arXiv snapshot is required for the model prompt.");
  const snapshotJson = JSON.stringify(snapshot, null, 2);
  return `You are the content-generation stage of the Daily arXiv production automation.

Host-enforced runtime contract:
- modelId: ${MODEL_ID}
- modelDisplayName: ${MODEL_DISPLAY_NAME}
- reasoningEffort: ${REASONING_EFFORT}
- runId: ${runId}
- staging directory: ${staging}

The host independently fetched and parsed the official arXiv /new and, when needed, /pastweek listings before this run. This snapshot is authoritative for the edition date, exact primary-new arXiv IDs, and cross-list counts. Do not substitute another date or paper set:
${snapshotJson}

Read AGENTS.md and docs/SCHEDULED_TASK_PROMPT.md completely, then follow their research, selection, rubric 3.0 scoring, natural-Japanese writing, paper-specific score-reason, full-text review, schema 1.4, and safety requirements. Those two files are the complete contract: do not inspect historical reports, public data, pipeline implementation, or tests as examples, and do not reuse prior rankings or prose. Use the native web-search capability and official arXiv pages/PDFs. For reproducible full-text inspection, use the repository's dependency-free scripts/extract-arxiv-source.mjs helper exactly as specified; it retrieves version-fixed official e-print source and writes only bounded text under this run root. Do not use an API key. Never write a PDF, credential, cache, report, or generated data inside the Git worktree. Do not modify tracked files. Do not run git add, git commit, git push, npm run publish, or scripts/publish-edition.mjs. The host process alone publishes after validation.

Use ${runId} unchanged in evaluationRun.runId for all three category reports. Use exactly ${MODEL_ID}, ${MODEL_DISPLAY_NAME}, ${REASONING_EFFORT}, and modelSelectionVerified=true in the three evaluationRun objects; these values come from the host CLI invocation and must not be altered or inferred from prose. Keep the rubric and runId identical across all three categories.

Research and evaluate exactly the announcement date and paper IDs in the host snapshot. The host already confirmed that it is newer than the current public edition. Screen every abstract, but open full text only for the provisional top 12 papers in each category. Every final top-10 paper must be among those reviewed papers, and no category report may mark more than 12 papers as full-text evaluated. Keep each reader-facing field within the character budgets in docs/SCHEDULED_TASK_PROMPT.md. Write exactly these three files directly under ${staging}:
  <YYYY-MM-DD>-quant-ph.json
  <YYYY-MM-DD>-gr-qc.json
  <YYYY-MM-DD>-hep-th.json
Do not write any other file in the staging directory.

After all three reports are complete, run the fixed exhaustive language audit once and repair every listed field in one batch. Run the exhaustive audit only once more after that batch. Never use the final validator as a one-error-at-a-time repair loop. The exact commands and bounded failure rule are in docs/SCHEDULED_TASK_PROMPT.md. Run the fixed final validator exactly once after the second audit reports zero issues. If either audit or the final validator fails, do not keep iterating: exit with an error so the previous public edition remains unchanged.

The final validator is the last command in a successful model run. After it prints STAGED_REPORTS_VALID, stop immediately without any further filesystem action and make your final response exactly STAGED_REPORTS_VALID. Never create or write a manifest, completion marker, status file, or outbox entry; the host requires the outbox directory to remain empty and derives the expected date and filenames from its own snapshot. Do not claim success unless all three reports exactly cover the snapshot and are complete. On any research, model, network, date-alignment, or validation uncertainty, do not invent data; exit with an error.
`;
}

export function sanitizedChildEnv(env = process.env) {
  const clean = {};
  for (const key of [
    "HOME",
    "USER",
    "LOGNAME",
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SHELL",
    "TERM",
    "TMPDIR",
    "TZ",
    "CODEX_HOME",
    "__CF_USER_TEXT_ENCODING",
  ]) {
    if (typeof env[key] === "string") clean[key] = env[key];
  }
  Object.assign(clean, {
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "remote.origin.pushurl",
    GIT_CONFIG_VALUE_0: "disabled://daily-arxiv-model-cannot-push",
  });
  return clean;
}

function hostChildEnv(env = process.env) {
  const clean = { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
  for (const key of ["OPENAI_API_KEY", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID", "CODEX_API_KEY"]) delete clean[key];
  return clean;
}

export function notifyMac(kind) {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/osascript")) return false;
  const bodies = {
    published: "Daily arXiv data was pushed. GitHub Pages validation is pending.",
    failed: "Daily arXiv needs attention; nothing was published.",
  };
  const body = bodies[kind];
  if (!body) return false;
  const result = spawnSync("/usr/bin/osascript", [
    "-e",
    `display notification "${body}" with title "Daily arXiv"`,
  ], {
    encoding: "utf8",
    env: sanitizedChildEnv(),
    timeout: 10_000,
    stdio: "ignore",
  });
  return !result.error && result.status === 0;
}

export function runCommand(command, args, {
  cwd,
  env = hostChildEnv(),
  input,
  inherit = false,
  outputPath,
  timeout = 120_000,
  allowFailure = false,
  isolatedProcessGroup = false,
  maxOutputBytes = MAX_CODEX_LOG_BYTES,
} = {}) {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 256) fail("maxOutputBytes must be an integer of at least 256 bytes.");
  let outputDescriptor;
  let result;
  let capturedOutputOverflow = false;
  try {
    if (outputPath) outputDescriptor = openSync(outputPath, "wx", 0o600);
    result = spawnSync(command, args, {
      cwd,
      env,
      encoding: "utf8",
      input,
      stdio: outputDescriptor !== undefined
        ? ["pipe", "pipe", "pipe"]
        : inherit
          ? ["pipe", "inherit", "inherit"]
          : ["pipe", "pipe", "pipe"],
      maxBuffer: maxOutputBytes,
      timeout,
      detached: isolatedProcessGroup,
    });
    if (outputDescriptor !== undefined) {
      const captured = Buffer.from([
        "--- STDOUT ---\n",
        result.stdout ?? "",
        "\n--- STDERR ---\n",
        result.stderr ?? "",
        result.error ? `\n--- PROCESS ERROR ---\n${result.error.message}\n` : "",
      ].join(""), "utf8");
      const notice = Buffer.from("\n--- LOG TRUNCATED AT HOST LIMIT ---\n", "utf8");
      capturedOutputOverflow = captured.length > maxOutputBytes;
      const bounded = captured.length <= maxOutputBytes
        ? captured
        : Buffer.concat([captured.subarray(0, maxOutputBytes - notice.length), notice]);
      writeFileSync(outputDescriptor, bounded);
    }
  } finally {
    if (outputDescriptor !== undefined) closeSync(outputDescriptor);
  }
  if (isolatedProcessGroup && Number.isSafeInteger(result?.pid) && result.pid > 0) {
    let groupExists = false;
    try {
      process.kill(-result.pid, "SIGTERM");
      groupExists = true;
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    if (groupExists) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      try {
        process.kill(-result.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }
  if (result.error) throw result.error;
  if (capturedOutputOverflow) fail(`Captured command output exceeded the ${maxOutputBytes}-byte host limit.`);
  if (result.status !== 0 && !allowFailure) {
    const detail = inherit || outputPath ? "" : `: ${(result.stderr || result.stdout || "").trim()}`;
    fail(`${basename(command)} ${args[0] ?? ""} failed (${result.status})${detail}`);
  }
  return result;
}

export function git(root, args, options = {}) {
  const gitBin = existsSync("/usr/bin/git") ? "/usr/bin/git" : "git";
  return runCommand(gitBin, ["-C", root, ...args], options).stdout?.trim() ?? "";
}

function assertExpectedRemote(root) {
  const fetchRemote = git(root, ["remote", "get-url", "origin"]);
  const pushRemote = git(root, ["remote", "get-url", "--push", "origin"]);
  if (!EXPECTED_REMOTE.test(fetchRemote)) fail(`Refusing unexpected origin fetch URL: ${fetchRemote}`);
  if (!EXPECTED_REMOTE.test(pushRemote)) fail(`Refusing unexpected origin push URL: ${pushRemote}`);
  return Object.freeze({ fetchRemote, pushRemote });
}

function assertRepository(root) {
  if (!existsSync(join(root, ".git"))) fail(`Git metadata is missing from ${root}.`);
  const top = resolve(git(root, ["rev-parse", "--show-toplevel"]));
  if (top !== resolve(root)) fail(`Expected Git root ${resolve(root)}, got ${top}.`);
  assertExpectedRemote(root);
}

function commonGitDirectory(root) {
  const value = git(root, ["rev-parse", "--git-common-dir"]);
  return realpathSync(resolve(root, value));
}

function assertCleanWorktree(worktree) {
  const status = git(worktree, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status !== "") fail(`Dedicated automation worktree is not clean: ${worktree}`);
}

export function inspectExistingWorktree(root, worktree, { requireClean = true } = {}) {
  if (!existsSync(worktree)) return Object.freeze({ exists: false });
  const entry = lstatSync(worktree);
  if (entry.isSymbolicLink() || !entry.isDirectory()) fail(`Automation worktree path is not a real directory: ${worktree}`);
  if (!existsSync(join(worktree, ".git")) || !lstatSync(join(worktree, ".git")).isFile()) {
    fail(`Refusing to reuse an existing non-worktree directory: ${worktree}`);
  }
  assertRepository(worktree);
  if (commonGitDirectory(root) !== commonGitDirectory(worktree)) {
    fail(`Existing worktree belongs to another Git repository: ${worktree}`);
  }
  const status = git(worktree, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (requireClean && status !== "") fail(`Dedicated automation worktree is not clean: ${worktree}`);
  return Object.freeze({
    exists: true,
    head: git(worktree, ["rev-parse", "HEAD"]),
    clean: status === "",
    status,
  });
}

export function readOnlyDiagnostics({ root, worktree, codexBin }) {
  assertRepository(root);
  assertChatGptLogin(codexBin);
  const originMain = git(root, ["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"]);
  let worktreeState = "absent-would-create-on-run";
  if (existsSync(worktree)) {
    try {
      const existing = inspectExistingWorktree(root, worktree, { requireClean: false });
      worktreeState = existing.clean
        ? `existing-clean:${existing.head}`
        : `existing-dirty-will-quarantine:${existing.head}`;
    } catch (error) {
      worktreeState = `occupied-will-use-run-specific-path:${error.message}`;
    }
  }
  return Object.freeze({
    status: "CHECK_OK",
    repository: resolve(root),
    originMain,
    codexBin,
    authentication: "ChatGPT",
    worktree,
    worktreeState,
    modelId: MODEL_ID,
    reasoningEffort: REASONING_EFFORT,
  });
}

function ensureSecureDirectory(path, label, { recursive = false } = {}) {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700, recursive });
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) fail(`${label} is not a safe real directory: ${path}`);
  if (typeof process.getuid === "function" && statSync(path).uid !== process.getuid()) {
    fail(`${label} is owned by another user: ${path}`);
  }
  if ((statSync(path).mode & 0o077) !== 0) fail(`${label} permissions are too broad: ${path}`);
}

export function prepareControlDirectories(paths) {
  ensureSecureDirectory(paths.controlRoot, "Automation control root", { recursive: true });
  ensureSecureDirectory(paths.logDirectory, "Automation log directory");
  ensureSecureDirectory(paths.lockHistory, "Automation lock history");
  ensureSecureDirectory(paths.staleLocks, "Automation stale-lock directory");
}

export function prepareRunDirectories(paths) {
  ensureSecureDirectory(paths.base, "Automation temp root");
  const hostStagingParent = dirname(paths.hostStaging);
  ensureSecureDirectory(hostStagingParent, "Host staging parent");
  if (existsSync(paths.runRoot)) fail(`Run directory already exists; refusing to reuse it: ${paths.runRoot}`);
  if (existsSync(paths.hostStaging)) fail(`Host staging directory already exists; refusing to reuse it: ${paths.hostStaging}`);
  mkdirSync(paths.runRoot, { mode: 0o700 });
  mkdirSync(paths.staging, { mode: 0o700 });
  mkdirSync(paths.outbox, { mode: 0o700 });
  mkdirSync(paths.agentHome, { mode: 0o700 });
  mkdirSync(paths.hostStaging, { mode: 0o700 });
  assertPlainDirectory(paths.runRoot, "Run directory");
  assertPlainDirectory(paths.staging, "Staging directory");
  assertPlainDirectory(paths.outbox, "Outbox directory");
  assertPlainDirectory(paths.agentHome, "Agent home directory");
  assertPlainDirectory(paths.hostStaging, "Host staging directory");
}

export function removeSuccessfulRunArtifacts(paths, {
  removeDirectory = (path) => rmSync(path, { recursive: true, force: false }),
  removeFile = unlinkSync,
} = {}) {
  const runId = basename(paths.runRoot);
  validateRunId(runId);
  if (
    resolve(paths.runRoot) !== resolve(join(paths.base, runId))
    || resolve(paths.hostStaging) !== resolve(join(paths.controlRoot, "host-staging", runId))
    || resolve(paths.codexLog) !== resolve(join(paths.logDirectory, `${runId}.codex.log`))
  ) {
    fail("Refusing to clean automation artifacts outside the exact successful run paths.");
  }
  assertPlainDirectory(paths.runRoot, "Successful run directory");
  assertPlainDirectory(paths.hostStaging, "Successful host staging directory");
  assertPlainFile(paths.codexLog, "Successful Codex log");
  removeDirectory(paths.runRoot);
  removeDirectory(paths.hostStaging);
  removeFile(paths.codexLog);
}

function lockOwnerIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    return true;
  }
}

function validateLockOwner(value) {
  exactKeys(value, ["schemaVersion", "pid", "uid", "hostname", "runId", "nonce", "startedAt"], "Automation lock");
  if (value.schemaVersion !== "1.0") fail("Automation lock schemaVersion must be 1.0.");
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) fail("Automation lock pid is invalid.");
  if (!Number.isSafeInteger(value.uid) || value.uid < 0) fail("Automation lock uid is invalid.");
  validateRunId(value.runId);
  if (!/^[a-f0-9]{32}$/.test(value.nonce)) fail("Automation lock nonce is invalid.");
  if (typeof value.hostname !== "string" || value.hostname.length < 1 || value.hostname.length > 255) {
    fail("Automation lock hostname is invalid.");
  }
  if (typeof value.startedAt !== "string" || Number.isNaN(Date.parse(value.startedAt))) {
    fail("Automation lock startedAt is invalid.");
  }
  return value;
}

function archiveLock(lockPath, directory, owner, label) {
  ensureSecureDirectory(directory, label);
  const destination = join(directory, `${owner.runId}-${owner.nonce}.lock`);
  if (existsSync(destination)) fail(`Refusing to overwrite archived automation lock: ${destination}`);
  renameSync(lockPath, destination);
  return destination;
}

export function acquireLock(lockPath, owner, {
  now = new Date(),
  staleAfterMs = STALE_LOCK_MS,
  processAlive = lockOwnerIsAlive,
  writeOwner = (descriptor, content) => writeFileSync(descriptor, content, "utf8"),
} = {}) {
  validateLockOwner(owner);
  const tryCreate = () => {
    let descriptor;
    let created = false;
    try {
      descriptor = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      created = true;
      writeOwner(descriptor, `${JSON.stringify(owner)}\n`);
      closeSync(descriptor);
      descriptor = undefined;
      return true;
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (error.code === "EEXIST") return false;
      if (created && existsSync(lockPath)) {
        const incomplete = join(dirname(lockPath), `incomplete-${owner.runId}-${owner.nonce}.lock`);
        if (existsSync(incomplete)) fail(`Refusing to overwrite archived incomplete lock: ${incomplete}`);
        try {
          renameSync(lockPath, incomplete);
          error.message += `; incomplete lock preserved at ${incomplete}`;
        } catch (archiveError) {
          error.message += `; could not archive incomplete lock (${archiveError.message})`;
        }
      }
      throw error;
    }
  };

  if (!tryCreate()) {
    const entry = lstatSync(lockPath);
    if (entry.isSymbolicLink() || !entry.isFile() || entry.size > MAX_LOCK_BYTES) {
      fail(`Unsafe automation lock requires manual inspection: ${lockPath}`);
    }
    if (typeof process.getuid === "function" && entry.uid !== process.getuid()) {
      fail(`Automation lock is owned by another user: ${lockPath}`);
    }
    const previous = validateLockOwner(JSON.parse(readFileSync(lockPath, "utf8")));
    const age = now.getTime() - Date.parse(previous.startedAt);
    if (previous.hostname !== hostname() || previous.uid !== owner.uid) {
      fail(`Automation lock belongs to another host or user; inspect it manually: ${lockPath}`);
    }
    if (processAlive(previous.pid)) {
      fail(`Another Daily arXiv run is active with pid ${previous.pid}.`);
    }
    if (!Number.isFinite(age) || age < staleAfterMs) {
      fail(`A recently interrupted run lock remains; retry after ${Math.ceil(staleAfterMs / 3_600_000)} hours or inspect ${lockPath}.`);
    }
    archiveLock(lockPath, join(dirname(lockPath), "stale-locks"), previous, "Automation stale-lock directory");
    if (!tryCreate()) fail("Automation lock changed during stale-lock recovery.");
  }

  return () => {
    const current = validateLockOwner(JSON.parse(readFileSync(lockPath, "utf8")));
    if (current.runId !== owner.runId || current.nonce !== owner.nonce) {
      fail("Automation lock ownership changed before release; preserving it for inspection.");
    }
    return archiveLock(lockPath, join(dirname(lockPath), "lock-history"), owner, "Automation lock history");
  };
}

function listedWorktrees(root) {
  return git(root, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => resolve(line.slice("worktree ".length)));
}

function runtimeChangedBetween(root, left, right) {
  const result = runCommand(existsSync("/usr/bin/git") ? "/usr/bin/git" : "git", [
    "-C", root, "diff", "--quiet", left, right, "--", ...AUTOMATION_RUNTIME_PATHS,
  ], { allowFailure: true });
  if (![0, 1].includes(result.status)) fail("Cannot compare installed automation runtime with origin/main.");
  return result.status === 1;
}

export function preparePublisherRuntime(root) {
  assertRepository(root);
  if (!lstatSync(join(root, ".git")).isFile()) {
    fail("Unattended publication must run from the installed publisher worktree, not the main checkout.");
  }
  assertCleanWorktree(root);
  git(root, ["fetch", "--quiet", "origin", "main"], { timeout: 120_000 });
  const originMain = git(root, ["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  if (head !== originMain) {
    if (runtimeChangedBetween(root, head, originMain)) {
      fail("Automation runtime changed on origin/main. Re-run the reviewed scheduler installer before the next unattended run.");
    }
    git(root, ["switch", "--detach", originMain], { timeout: 120_000 });
  }
  assertCleanWorktree(root);
  if (git(root, ["rev-parse", "HEAD"]) !== originMain) fail("Publisher worktree is not exactly at origin/main.");
  return originMain;
}

export function prepareAgentWorktree(root, worktreeBase, originMain, runId) {
  assertRepository(root);
  validateRunId(runId);
  const prefix = `${worktreeBase}-run-`;
  const candidates = listedWorktrees(root)
    .filter((path) => path === worktreeBase || path.startsWith(prefix))
    .sort();
  for (const candidate of candidates.reverse()) {
    let existing;
    try {
      existing = inspectExistingWorktree(root, candidate, { requireClean: false });
    } catch {
      continue;
    }
    if (!existing.clean) continue;
    if (existing.head !== originMain) git(candidate, ["switch", "--detach", originMain], { timeout: 120_000 });
    assertCleanWorktree(candidate);
    if (git(candidate, ["rev-parse", "HEAD"]) !== originMain) continue;
    return Object.freeze({ worktree: candidate, originMain, reused: true });
  }

  const candidate = existsSync(worktreeBase) ? `${worktreeBase}-${runId}` : worktreeBase;
  if (existsSync(candidate)) fail(`Fresh agent worktree path is unexpectedly occupied: ${candidate}`);
  if (dirname(candidate) !== dirname(resolve(root))) fail("Fresh agent worktree must remain a sibling of the publisher worktree.");
  git(root, ["worktree", "add", "--detach", candidate, originMain], { timeout: 120_000 });
  const created = inspectExistingWorktree(root, candidate);
  if (!created.exists || created.head !== originMain) fail("Fresh agent worktree is not exactly at origin/main.");
  return Object.freeze({ worktree: candidate, originMain, reused: false });
}

export function assertChatGptLogin(codexBin, env = process.env) {
  const result = runCommand(codexBin, ["login", "status"], {
    env: sanitizedChildEnv(env),
    timeout: 30_000,
    allowFailure: true,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status !== 0 || !/Logged in using ChatGPT/i.test(output)) {
    fail("Codex CLI is not authenticated with ChatGPT. Run `codex login` interactively; API-key login is not accepted.");
  }
}

export function buildCodexDoctorArgs({ worktree, runRoot }) {
  const args = buildCodexArgs({ worktree, runRoot });
  const execIndex = args.indexOf("exec");
  if (execIndex < 0) fail("Cannot build Codex configuration preflight arguments.");
  return [...args.slice(0, execIndex), "doctor", "--json"];
}

export function assertCodexConfiguration({ codexBin, worktree, runRoot, env = process.env }) {
  ensureSecureDirectory(runRoot, "Codex configuration preflight root", { recursive: true });
  const doctorHome = join(runRoot, "doctor-codex-home");
  ensureSecureDirectory(doctorHome, "Codex configuration preflight home");
  const doctorEnv = sanitizedChildEnv(env);
  doctorEnv.CODEX_HOME = doctorHome;
  const result = runCommand(codexBin, buildCodexDoctorArgs({ worktree, runRoot }), {
    cwd: worktree,
    env: doctorEnv,
    timeout: 60_000,
    allowFailure: true,
  });
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    fail(`Codex strict configuration preflight produced no valid report (${result.status}): ${`${result.stderr}\n${result.stdout}`.trim()}`);
  }
  const config = report?.checks?.["config.load"];
  const sandbox = report?.checks?.["sandbox.helpers"];
  if (config?.status !== "ok" || sandbox?.status !== "ok") {
    fail(`Codex could not load the isolated config or sandbox: ${`${result.stderr}\n${result.stdout}`.trim()}`);
  }
  if (config.details?.model !== MODEL_ID || !String(config.details?.["feature flag overrides"] ?? "").includes("network_proxy=true")) {
    fail("Codex doctor did not report the fixed model and managed network proxy.");
  }
  if (sandbox.details?.["filesystem sandbox"] !== "restricted" || sandbox.details?.["network sandbox"] !== "enabled") {
    fail("Codex doctor did not report restricted filesystem and enabled network sandboxing.");
  }
  return Object.freeze({
    codexVersion: report.codexVersion,
    model: config.details.model,
    filesystemSandbox: sandbox.details["filesystem sandbox"],
    networkSandbox: sandbox.details["network sandbox"],
  });
}

export function assertCodexPermissionEnforcement({
  codexBin,
  worktree,
  runRoot,
  deniedSentinel,
  authPath,
  env = process.env,
}) {
  for (const [value, label] of [
    [worktree, "Permission-probe worktree"],
    [runRoot, "Permission-probe runRoot"],
    [deniedSentinel, "Permission-probe denied sentinel"],
    [authPath, "Permission-probe auth path"],
  ]) {
    if (!isAbsolute(value)) fail(`${label} must be absolute.`);
  }
  ensureSecureDirectory(runRoot, "Codex permission preflight root", { recursive: true });
  const doctorHome = join(runRoot, "doctor-codex-home");
  ensureSecureDirectory(doctorHome, "Codex permission preflight home");
  assertPlainFile(deniedSentinel, "Permission-probe denied sentinel");
  assertPlainFile(authPath, "Codex authentication file");
  const allowedOutput = join(runRoot, `permission-write-${process.pid}-${randomBytes(6).toString("hex")}.txt`);
  const helper = join(worktree, "scripts", "probe-codex-sandbox.mjs");
  assertPlainFile(helper, "Codex permission-probe helper");
  const args = [
    ...permissionProfileOverrides(runRoot).flatMap((override) => ["--config", override]),
    "--config", "features.network_proxy.enabled=true",
    "--permission-profile", "daily_arxiv_model",
    "--cd", worktree,
    process.execPath,
    helper,
    allowedOutput,
    deniedSentinel,
    authPath,
  ];
  const childEnv = sanitizedChildEnv(env);
  childEnv.CODEX_HOME = doctorHome;
  const result = runCommand(codexBin, ["sandbox", ...args], {
    cwd: worktree,
    env: childEnv,
    timeout: 60_000,
    allowFailure: true,
  });
  if (result.status !== 0) {
    fail(`Codex macOS permission enforcement probe failed (${result.status}): ${`${result.stderr}\n${result.stdout}`.trim()}`);
  }
  let report;
  try {
    report = JSON.parse(result.stdout.trim().split("\n").at(-1));
  } catch {
    fail(`Codex permission probe returned invalid output: ${result.stdout}`);
  }
  if (
    report.status !== "PERMISSION_PROBE_OK"
    || report.repositoryRead !== true
    || report.runRootWrite !== true
    || report.arxivNetworkAllowed !== true
    || report.externalNetworkDenied !== true
    || !["EACCES", "EPERM", "ENOENT"].includes(report.deniedWrite)
    || !["EACCES", "EPERM", "ENOENT"].includes(report.authRead)
  ) {
    fail("Codex permission probe did not confirm the complete expected policy.");
  }
  return Object.freeze(report);
}

export function validateCodexCompletionResponse(stdout) {
  if (typeof stdout !== "string" || stdout.trim() !== "STAGED_REPORTS_VALID") {
    fail("Codex did not return the exact validated-completion response; no publication was attempted.");
  }
  return "STAGED_REPORTS_VALID";
}

export function invokeCodex({ codexBin, worktree, paths, prompt }) {
  const result = runCommand(codexBin, buildCodexArgs({ worktree, runRoot: paths.runRoot }), {
    cwd: worktree,
    env: sanitizedChildEnv(),
    input: prompt,
    outputPath: paths.codexLog,
    timeout: 4 * 60 * 60 * 1000,
    allowFailure: true,
    isolatedProcessGroup: true,
  });
  if (result.status !== 0) {
    fail(`Codex generation failed (${result.status}); no publication was attempted. Inspect ${paths.codexLog}.`);
  }
  validateCodexCompletionResponse(result.stdout);
}

function readStableRegularFile(path, maxBytes) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) fail(`Source report is not a regular file: ${path}`);
    if (before.size > maxBytes) fail(`Source report exceeds the ${maxBytes}-byte limit: ${path}`);
    const content = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || content.length !== before.size
    ) {
      fail(`Source report changed while the host copied it: ${path}`);
    }
    return content;
  } finally {
    closeSync(descriptor);
  }
}

function expectedReportFiles(date) {
  validateDate(date);
  return CATEGORIES.map((category) => `${date}-${category}.json`);
}

export function validateModelOutputLayout({ stagingDirectory, outboxDirectory, date }) {
  assertPlainDirectory(stagingDirectory, "Model staging directory");
  assertPlainDirectory(outboxDirectory, "Model outbox directory");
  const outboxFiles = readdirSync(outboxDirectory).sort();
  if (outboxFiles.length !== 0) {
    fail("Model outbox directory must remain empty.");
  }
  const expectedFiles = expectedReportFiles(date);
  const actualFiles = readdirSync(stagingDirectory).sort();
  const sortedExpected = [...expectedFiles].sort();
  if (actualFiles.join("\0") !== sortedExpected.join("\0")) {
    fail(`Model staging directory must contain exactly: ${sortedExpected.join(", ")}.`);
  }
  for (const file of expectedFiles) {
    const path = join(stagingDirectory, file);
    assertPlainFile(path, `Model report ${file}`);
    if (statSync(path).size > MAX_REPORT_BYTES) fail(`Model report ${file} exceeds the 10 MiB safety limit.`);
  }
  return Object.freeze({ date, files: Object.freeze(expectedFiles) });
}

export function copyReportsToHostStaging({ sourceDirectory, hostDirectory, date }) {
  assertPlainDirectory(sourceDirectory, "Model staging directory");
  assertPlainDirectory(hostDirectory, "Host staging directory");
  if (readdirSync(hostDirectory).length !== 0) fail("Host staging directory must start empty.");
  const expectedFiles = expectedReportFiles(date);
  const actualFiles = readdirSync(sourceDirectory).sort();
  const sortedExpected = [...expectedFiles].sort();
  if (actualFiles.join("\0") !== sortedExpected.join("\0")) {
    fail(`Model staging directory must contain exactly: ${sortedExpected.join(", ")}.`);
  }
  const copied = {};
  for (const [index, category] of CATEGORIES.entries()) {
    const file = expectedFiles[index];
    const source = join(sourceDirectory, file);
    assertPlainFile(source, `Model report ${file}`);
    const content = readStableRegularFile(source, MAX_REPORT_BYTES);
    const destination = join(hostDirectory, file);
    const descriptor = openSync(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      writeFileSync(descriptor, content);
    } finally {
      closeSync(descriptor);
    }
    copied[category] = parseJsonFile(destination);
  }
  return Object.freeze(copied);
}

export function invokePublisher({ worktree, date, stagingPath }) {
  const publisher = join(worktree, "scripts", "publish-edition.mjs");
  assertPlainFile(publisher, "Publisher script");
  runCommand(process.execPath, [publisher, date, stagingPath], {
    cwd: worktree,
    inherit: true,
    timeout: 10 * 60 * 1000,
  });
}

export async function runAutomation({ root, env = process.env, fetchImpl = globalThis.fetch, now = new Date() }) {
  const agentWorktreeBase = resolveAgentWorktreeBase(
    root,
    env.DAILY_ARXIV_AGENT_WORKTREE_BASE,
  );
  const runId = makeRunId();
  const controlRoot = automationControlRoot(env.HOME ?? homedir(), env.DAILY_ARXIV_CONTROL_ROOT);
  const paths = runPaths(runId, { controlRoot });
  prepareControlDirectories(paths);
  const nonce = randomBytes(16).toString("hex");
  const releaseLock = acquireLock(paths.lock, {
    schemaVersion: "1.0",
    pid: process.pid,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    hostname: hostname(),
    runId,
    nonce,
    startedAt: now.toISOString(),
  });
  let runError;
  try {
    const originMain = preparePublisherRuntime(root);
    const index = parseJsonFile(join(root, "public", "data", "index.json"));
    const latestDate = validateDate(index.latestDate);
    const currentSnapshot = await fetchOfficialListingSnapshot({ fetchImpl });
    const classification = classifySnapshotDate(currentSnapshot, { latestDate, now });
    if (classification === "current") {
      console.log(`NO_CHANGE: official arXiv announcement ${currentSnapshot.announcementDate} is already public (runId ${runId}).`);
      return Object.freeze({ status: "no_change", runId, date: currentSnapshot.announcementDate });
    }
    const pastweekWindow = await fetchOfficialPastweekWindow({ fetchImpl });
    const selection = selectBackfillSnapshot({ currentSnapshot, pastweekWindow, latestDate, now });
    if (selection === null) {
      console.log(`NO_CHANGE: every unpublished announcement through ${currentSnapshot.announcementDate} has zero eligible primary-new papers (runId ${runId}).`);
      return Object.freeze({ status: "no_change", runId, date: currentSnapshot.announcementDate });
    }
    const { snapshot, pendingCount } = selection;
    console.log(`BACKFILL_SELECTED: ${snapshot.announcementDate} is the oldest of ${pendingCount} unpublished non-empty edition(s) (runId ${runId}).`);
    const totalNew = CATEGORIES.reduce((sum, slug) => sum + snapshot.categories[slug].newCount, 0);
    if (totalNew === 0) {
      fail("Backfill selector returned an empty publication snapshot.");
    }

    const readiness = await probeOfficialFullTextReadiness(snapshot, { fetchImpl });
    const readinessDisposition = classifyFullTextReadiness(readiness, {
      isLatestAnnouncement: snapshot.announcementDate === currentSnapshot.announcementDate,
    });
    if (readinessDisposition !== "ready") {
      const unavailable = readiness.unavailable;
      const status = unavailable.status === null ? "network error" : `HTTP ${unavailable.status}`;
      if (readinessDisposition === "defer") {
        console.log(
          `AUTOMATION_DEFERRED: official ${unavailable.kind} for ${readiness.arxivId}v1 is not ready (${status}); `
          + `Codex was not started (runId ${runId}).`,
        );
        return Object.freeze({
          status: "deferred",
          runId,
          date: snapshot.announcementDate,
          reason: "full_text_not_ready",
          arxivId: readiness.arxivId,
        });
      }
      fail(
        `Official ${unavailable.kind} for ${readiness.arxivId}v1 is unavailable (${status}) `
        + `after its announcement propagation window.`,
      );
    }
    console.log(`FULL_TEXT_READY: official v1 PDF and e-print canary ${readiness.arxivId} passed before Codex start (runId ${runId}).`);

    prepareRunDirectories(paths);
    const codexBin = discoverCodex({ env });
    assertPinnedCodexIdentity(codexBin, env);
    assertChatGptLogin(codexBin, env);
    const agent = prepareAgentWorktree(root, agentWorktreeBase, originMain, runId);
    const prompt = buildAutomationPrompt({
      runId,
      staging: paths.staging,
      snapshot,
    });
    invokeCodex({ codexBin, worktree: agent.worktree, paths, prompt });
    const postCodexWorktree = inspectExistingWorktree(root, agent.worktree);
    if (!postCodexWorktree.exists || postCodexWorktree.head !== originMain) {
      fail("Agent worktree identity, cleanliness, or HEAD changed during Codex generation; no publication was attempted.");
    }
    validateModelOutputLayout({
      stagingDirectory: paths.staging,
      outboxDirectory: paths.outbox,
      date: snapshot.announcementDate,
    });
    const reports = copyReportsToHostStaging({
      sourceDirectory: paths.staging,
      hostDirectory: paths.hostStaging,
      date: snapshot.announcementDate,
    });
    const policy = parseJsonFile(join(root, "data", "model-policy.json"));
    validateProductionReportSet(reports, {
      date: snapshot.announcementDate,
      policy,
      expectedRunId: runId,
    });
    validateReportsAgainstSnapshot(reports, snapshot, { date: snapshot.announcementDate });

    const freshPastweekWindow = await fetchOfficialPastweekWindow({ fetchImpl });
    revalidatePastweekSnapshot(snapshot, freshPastweekWindow);
    if (git(root, ["rev-parse", "HEAD"]) !== originMain) {
      fail("Publisher worktree HEAD changed during generation; no publication was attempted.");
    }
    assertCleanWorktree(root);
    invokePublisher({ worktree: root, date: snapshot.announcementDate, stagingPath: paths.hostStaging });
    console.log(`AUTOMATION_PUBLISHED: ${snapshot.announcementDate} (runId ${runId}).`);
    notifyMac("published");
    try {
      removeSuccessfulRunArtifacts(paths);
    } catch (cleanupError) {
      console.error(`ARTIFACT_CLEANUP_WARNING: ${cleanupError.message}`);
    }
    return Object.freeze({ status: "published", runId, date: snapshot.announcementDate });
  } catch (error) {
    runError = error;
    throw error;
  } finally {
    try {
      releaseLock();
    } catch (lockError) {
      console.error(`LOCK_ARCHIVE_WARNING: ${lockError.message}`);
      if (runError) console.error("The primary automation error above remains authoritative.");
    }
  }
}
