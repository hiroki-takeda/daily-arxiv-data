import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CATEGORIES,
  AUTOMATION_RUNTIME_PATHS,
  MODEL_ID,
  acquireLock,
  assertChatGptLogin,
  assertPinnedCodexIdentity,
  buildAutomationPrompt,
  buildCodexArgs,
  codexBinaryIdentity,
  classifyFullTextReadiness,
  copyReportsToHostStaging,
  discoverCodex,
  makeRunId,
  parseMode,
  removeSuccessfulRunArtifacts,
  resolveAgentWorktreeBase,
  runCommand,
  runPaths,
  sanitizedChildEnv,
  validateCodexCompletionResponse,
  validateManifest,
  validateModelOutputLayout,
} from "../scripts/lib/local-automation.mjs";

const RUN_ID = "run-20990105T123456Z-abcdef123456";
const DATE = "2099-01-05";
const SNAPSHOT = Object.freeze({
  announcementDate: DATE,
  categories: {
    "quant-ph": { slug: "quant-ph", sourceUrl: "https://arxiv.org/list/quant-ph/new?skip=0&show=2000", newCount: 1, crosslistCount: 0, newIds: ["2099.00003"] },
    "gr-qc": { slug: "gr-qc", sourceUrl: "https://arxiv.org/list/gr-qc/new?skip=0&show=2000", newCount: 1, crosslistCount: 0, newIds: ["2099.00002"] },
    "hep-th": { slug: "hep-th", sourceUrl: "https://arxiv.org/list/hep-th/new?skip=0&show=2000", newCount: 1, crosslistCount: 0, newIds: ["2099.00001"] },
  },
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-runner-test-"));
  const staging = join(root, "staging");
  const outbox = join(root, "outbox");
  mkdirSync(staging);
  mkdirSync(outbox);
  return { root, staging, manifest: join(outbox, "manifest.json") };
}

function manifestObject(staging, overrides = {}) {
  return {
    schemaVersion: "1.0",
    runId: RUN_ID,
    status: "ready",
    reportDate: DATE,
    stagingDirectory: staging,
    reportFiles: CATEGORIES.map((category) => `${DATE}-${category}.json`),
    message: "Three complete reports are ready.",
    ...overrides,
  };
}

test("mode parser exposes only run and one pure diagnostic mode", () => {
  assert.equal(parseMode([]), "run");
  assert.equal(parseMode(["--check"]), "check");
  assert.throws(() => parseMode(["--dry-run"]), /Usage/);
  assert.throws(() => parseMode(["--check", "extra"]), /Usage/);
});

test("runtime update barrier covers every scheduled runtime dependency", () => {
  for (const path of [
    "AGENTS.md",
    "docs/SCHEDULED_TASK_PROMPT.md",
    "scripts/extract-arxiv-source.mjs",
    "scripts/run-local-automation.mjs",
    "scripts/validate-staged-reports.mjs",
    "scripts/lib/local-automation.mjs",
    "scripts/lib/macos-schedule.mjs",
    "scripts/lib/arxiv-source.mjs",
    "scripts/lib/pipeline.mjs",
  ]) assert.ok(AUTOMATION_RUNTIME_PATHS.includes(path), path);
});

test("runId generation is stable-format and injectable for tests", () => {
  assert.equal(makeRunId(new Date("2099-01-05T12:34:56.789Z"), "abcdef123456"), RUN_ID);
});

test("full-text readiness defers fresh propagation and transient failures but rejects persistent invalid access", () => {
  assert.equal(classifyFullTextReadiness({ ready: true }, { isLatestAnnouncement: true }), "ready");
  assert.equal(classifyFullTextReadiness({ ready: false, unavailable: { status: 404 } }, { isLatestAnnouncement: true }), "defer");
  assert.equal(classifyFullTextReadiness({ ready: false, unavailable: { status: 404 } }, { isLatestAnnouncement: false }), "fail");
  assert.equal(classifyFullTextReadiness({ ready: false, unavailable: { status: 429 } }, { isLatestAnnouncement: false }), "defer");
  assert.equal(classifyFullTextReadiness({ ready: false, unavailable: { status: null } }, { isLatestAnnouncement: true }), "defer");
  assert.equal(classifyFullTextReadiness({ ready: false, unavailable: { status: 403 } }, { isLatestAnnouncement: true }), "fail");
});

test("Codex invocation fixes Sol, High reasoning, beta permissions, network, approvals, and web search", () => {
  const args = buildCodexArgs({ worktree: "/repo-automation", runRoot: "/tmp/run" });
  assert.deepEqual(args.slice(0, 2), ["--strict-config", "--search"]);
  assert.ok(args.includes(MODEL_ID));
  assert.ok(args.includes('model_reasoning_effort="high"'));
  assert.ok(args.includes('default_permissions="daily_arxiv_model"'));
  assert.ok(!args.some((value) => value.startsWith("permissions.daily_arxiv_model.extends=")));
  assert.ok(args.some((value) => value.includes('":root"="deny"') && value.includes('":slash_tmp"="deny"') && value.includes('"~/.codex"="deny"')));
  assert.ok(args.some((value) => value.includes('":workspace_roots"={"."="read"}') && value.includes('"/tmp/run"="write"')));
  assert.ok(!args.some((value) => value.startsWith("permissions.daily_arxiv_model.workspace_roots=")));
  assert.ok(args.includes("allow_login_shell=false"));
  assert.ok(args.includes("features.network_proxy.enabled=true"));
  assert.ok(args.some((value) => value.startsWith("permissions.daily_arxiv_model.network=") && value.includes('"arxiv.org"="allow"')));
  assert.ok(args.includes('tools.web_search={context_size="medium",allowed_domains=["arxiv.org","export.arxiv.org"]}'));
  assert.ok(args.includes('projects."/repo-automation".trust_level="trusted"'));
  assert.ok(args.includes('shell_environment_policy.set.HOME="/tmp/run/home"'));
  assert.ok(args.includes('shell_environment_policy.set.TMPDIR="/tmp/run"'));
  assert.ok(args.includes('shell_environment_policy.set.GIT_SSH_COMMAND="/usr/bin/false"'));
  assert.ok(args.some((value) => value.includes("SSH_AUTH_SOCK") && value.includes("*TOKEN*")));
  assert.equal(args.includes("--sandbox"), false);
  assert.equal(args.includes("--add-dir"), false);
  assert.deepEqual(args.slice(args.indexOf("--ask-for-approval"), args.indexOf("--ask-for-approval") + 2), ["--ask-for-approval", "never"]);
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.equal(args.at(-1), "-");
});

test("child environment removes API credentials without removing ChatGPT auth state", () => {
  const result = sanitizedChildEnv({
    HOME: "/Users/test",
    CODEX_HOME: "/Users/test/.codex",
    OPENAI_API_KEY: "secret",
    CODEX_API_KEY: "secret",
    GITHUB_TOKEN: "secret",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
  });
  assert.equal(result.HOME, "/Users/test");
  assert.equal(result.CODEX_HOME, "/Users/test/.codex");
  assert.equal(result.OPENAI_API_KEY, undefined);
  assert.equal(result.CODEX_API_KEY, undefined);
  assert.equal(result.GITHUB_TOKEN, undefined);
  assert.equal(result.SSH_AUTH_SOCK, undefined);
  assert.equal(result.GIT_TERMINAL_PROMPT, "0");
  assert.equal(result.GIT_CONFIG_KEY_0, "remote.origin.pushurl");
  assert.match(result.GIT_CONFIG_VALUE_0, /^disabled:/);
});

test("login preflight accepts ChatGPT login and rejects API-key login", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-login-test-"));
  const chatGpt = join(root, "chatgpt-login");
  const apiKey = join(root, "api-login");
  writeFileSync(chatGpt, "#!/bin/sh\necho 'Logged in using ChatGPT'\n");
  writeFileSync(apiKey, "#!/bin/sh\necho 'Logged in using an API key'\n");
  chmodSync(chatGpt, 0o700);
  chmodSync(apiKey, 0o700);
  assert.doesNotThrow(() => assertChatGptLogin(chatGpt));
  assert.throws(() => assertChatGptLogin(apiKey), /not authenticated with ChatGPT/);
});

test("automation prompt binds host runId and requires validator-last output without a manifest", () => {
  const prompt = buildAutomationPrompt({
    runId: RUN_ID,
    staging: "/tmp/run/staging",
    snapshot: SNAPSHOT,
  });
  assert.match(prompt, new RegExp(RUN_ID));
  assert.match(prompt, /modelId: gpt-5\.6-sol/);
  assert.match(prompt, /reasoningEffort: high/);
  assert.match(prompt, /provisional top 12 papers in each category/);
  assert.match(prompt, /extract-arxiv-source\.mjs helper/);
  assert.match(prompt, /do not inspect historical reports, public data, pipeline implementation, or tests/);
  assert.match(prompt, /no category report may mark more than 12 papers/);
  assert.match(prompt, /rubric 3\.0 scoring/);
  assert.match(prompt, /natural-Japanese writing/);
  assert.match(prompt, /schema 1\.4/);
  assert.match(prompt, /Do not run git add, git commit, git push/);
  assert.match(prompt, /host process alone publishes/);
  assert.match(prompt, /STAGED_REPORTS_VALID/);
  assert.match(prompt, /final response exactly STAGED_REPORTS_VALID/);
  assert.match(prompt, /outbox directory to remain empty/);
  assert.match(prompt, /Never create or write a manifest/);
  assert.doesNotMatch(prompt, /final manifest:/);
  assert.doesNotMatch(prompt, /manifest\.json/);
  assert.match(prompt, /2099\.00001/);
});

test("Codex completion gate accepts only the exact validated response", () => {
  assert.equal(validateCodexCompletionResponse("STAGED_REPORTS_VALID\n"), "STAGED_REPORTS_VALID");
  assert.throws(
    () => validateCodexCompletionResponse("ACTION_REQUIRED: STAGED_LANGUAGE_AUDIT_FAILED"),
    /exact validated-completion response/,
  );
  assert.throws(
    () => validateCodexCompletionResponse("ready\nSTAGED_REPORTS_VALID"),
    /exact validated-completion response/,
  );
});

test("the scheduled specification keeps rubric 3.0 anchors and Japanese quality requirements", () => {
  const specification = readFileSync(join(process.cwd(), "docs", "SCHEDULED_TASK_PROMPT.md"), "utf8");
  for (const key of ["broadImpact", "categoryImpact", "originality", "technicalStrength"]) {
    assert.match(specification, new RegExp(`scoreReasons\\.${key}`));
  }
  for (const band of ["0〜5", "6〜10", "11〜14", "15〜17", "18〜20", "21〜23", "24〜25"]) {
    assert.ok((specification.match(new RegExp(band, "g")) ?? []).length >= 4, band);
  }
  assert.match(specification, /Daily arXiv rubric 3\.0/);
  assert.match(specification, /technicalStrength`の18点以上は全文確認/);
  assert.match(specification, /node scripts\/extract-arxiv-source\.mjs/);
  assert.match(specification, /node scripts\/validate-staged-reports\.mjs YYYY-MM-DD/);
  assert.match(specification, /manifest、completion marker、status fileを作らず/);
  assert.match(specification, /outboxは空のまま/);
  assert.match(specification, /`STAGED_REPORTS_VALID`になった場合は、それを最後のコマンドとして直ちに終了/);
  assert.match(specification, /最終応答を正確に`STAGED_REPORTS_VALID`の1行だけ/);
  assert.match(specification, /全文未確認論文の各軸が24点未満かつ`technicalStrength`が17点以下/);
  assert.match(specification, /`scope: "category"`/);
  assert.match(specification, /`data\/reports\/`、`public\/data\/`、`scripts\/lib\/pipeline\.mjs`、testsを例として読みません/);
  assert.match(specification, /取得成功、ファイルサイズ、節名の検索だけを全文確認の代用にしてはいけません/);
  assert.match(specification, /暫定候補全件へ一括`HEAD`/);
  assert.match(specification, /同じ全件へ`Range GET`を重ねたりして/);
  assert.match(specification, /他候補の可用性検査を続けず/);
  assert.match(specification, /`titleJa`:[^\n]*日本語として自然に読める表示題名/);
  assert.match(specification, /固有名・数式・標準略語だけを英字で残し/);
  assert.match(specification, /`title`にはarXivの原題を一字一句そのまま保存/);
  assert.match(specification, /画面は`titleJa`、`title`、著者名の順/);
  assert.match(specification, /Kerr black hole[^。\n]{0,40}Kerrブラックホール/);
  assert.match(specification, /一般語を英単語のまま日本語の助詞や「する」へ接続しません/);
  assert.match(specification, /`fullTextReviewStatus`は、固有名・数式・標準略語だけを英字で残し/);
  assert.match(specification, /英字で残すのは固有名・数式・標準略語に限り/);
  assert.match(specification, /別論文へそのまま移せる定型文を禁止/);
  assert.match(specification, /abstractLines\[0\].*言い換えにはしません/);
  assert.match(specification, /assessment.*点数や`scoreReasons`の反復/);
});

test("Codex discovery honors an absolute CODEX_BIN", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-codex-test-"));
  const binary = join(root, "codex");
  writeFileSync(binary, "#!/bin/sh\nexit 0\n");
  chmodSync(binary, 0o700);
  assert.equal(discoverCodex({ env: { CODEX_BIN: binary, PATH: "" }, home: root }), realpathSync(binary));
  assert.throws(() => discoverCodex({ env: { CODEX_BIN: "codex", PATH: "" }, home: root }), /absolute/);
});

test("scheduled Codex binary is pinned by realpath, SHA-256, and version", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-codex-pin-test-"));
  const binary = join(root, "codex");
  const executedAfterChange = join(root, "changed-binary-executed");
  writeFileSync(binary, "#!/bin/sh\necho 'codex-cli 1.2.3'\n");
  chmodSync(binary, 0o700);
  const identity = codexBinaryIdentity(binary, { HOME: root, PATH: "/usr/bin:/bin" });
  const env = {
    HOME: root,
    PATH: "/usr/bin:/bin",
    CODEX_BIN: identity.path,
    DAILY_ARXIV_CODEX_SHA256: identity.sha256,
    DAILY_ARXIV_CODEX_VERSION: identity.version,
  };
  assert.deepEqual(assertPinnedCodexIdentity(binary, env), identity);
  writeFileSync(binary, `#!/bin/sh\ntouch ${JSON.stringify(executedAfterChange)}\necho 'codex-cli 9.9.9'\n`);
  assert.throws(() => assertPinnedCodexIdentity(binary, env), /identity changed/);
  assert.equal(existsSync(executedAfterChange), false, "a changed Codex binary must not execute before its digest is rejected");
});

test("Codex discovery finds the newest current VS Code extension", async () => {
  const home = await mkdtemp(join(tmpdir(), "daily-arxiv-vscode-test-"));
  const oldBinary = join(home, ".vscode", "extensions", "openai.chatgpt-26.7.9-darwin-arm64", "bin", "macos-aarch64", "codex");
  const newBinary = join(home, ".vscode", "extensions", "openai.chatgpt-26.10.1-darwin-arm64", "bin", "macos-aarch64", "codex");
  mkdirSync(join(oldBinary, ".."), { recursive: true });
  mkdirSync(join(newBinary, ".."), { recursive: true });
  writeFileSync(oldBinary, "#!/bin/sh\nexit 0\n");
  writeFileSync(newBinary, "#!/bin/sh\nexit 0\n");
  chmodSync(oldBinary, 0o700);
  chmodSync(newBinary, 0o700);
  assert.equal(discoverCodex({ env: { PATH: "" }, home, platform: "darwin", arch: "arm64" }), realpathSync(newBinary));
  assert.equal(discoverCodex({ env: { PATH: "" }, home, platform: "darwin", arch: "x64" }), realpathSync(newBinary));
});

test("worktree path is dedicated and constrained to a sibling", () => {
  assert.equal(resolveAgentWorktreeBase("/project/daily-arxiv-data"), "/project/daily-arxiv-data-agent");
  assert.throws(() => resolveAgentWorktreeBase("/project/daily-arxiv-data", "/project/daily-arxiv-data"), /must not/);
  assert.throws(() => resolveAgentWorktreeBase("/project/daily-arxiv-data", "/elsewhere/automation"), /sibling/);
});

test("single-run lock refuses overlap and releases only its own lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-lock-test-"));
  const lock = join(root, "active-run.lock");
  const first = {
    schemaVersion: "1.0",
    pid: 4242,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    hostname: hostname(),
    runId: RUN_ID,
    nonce: "a".repeat(32),
    startedAt: "2099-01-05T12:34:56.000Z",
  };
  const release = acquireLock(lock, first);
  assert.throws(() => acquireLock(lock, { ...first, nonce: "b".repeat(32) }, {
    now: new Date("2099-01-05T12:35:00.000Z"),
    processAlive: () => true,
  }), /active/);
  release();
  assert.equal(existsSync(lock), false);
  const releaseAgain = acquireLock(lock, { ...first, nonce: "c".repeat(32) });
  releaseAgain();
});

test("a dead old lock is preserved as stale and does not permanently stop automation", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-stale-lock-test-"));
  const lock = join(root, "active-run.lock");
  const first = {
    schemaVersion: "1.0",
    pid: 4242,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    hostname: hostname(),
    runId: RUN_ID,
    nonce: "d".repeat(32),
    startedAt: "2099-01-05T00:00:00.000Z",
  };
  acquireLock(lock, first);
  const second = {
    ...first,
    pid: 4343,
    runId: "run-20990105T183456Z-fedcba654321",
    nonce: "e".repeat(32),
    startedAt: "2099-01-05T18:34:56.000Z",
  };
  const release = acquireLock(lock, second, {
    now: new Date("2099-01-05T18:34:56.000Z"),
    processAlive: () => false,
  });
  assert.equal(readdirSync(join(root, "stale-locks")).length, 1);
  release();
});

test("a failed new lock write archives only its own incomplete inode", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-incomplete-lock-test-"));
  const lock = join(root, "active-run.lock");
  const owner = {
    schemaVersion: "1.0",
    pid: 4242,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    hostname: hostname(),
    runId: RUN_ID,
    nonce: "f".repeat(32),
    startedAt: "2099-01-05T00:00:00.000Z",
  };
  assert.throws(() => acquireLock(lock, owner, {
    writeOwner: () => { throw new Error("injected lock write failure"); },
  }), /incomplete lock preserved/);
  assert.equal(existsSync(lock), false);
  assert.equal(readdirSync(root).filter((name) => name.startsWith("incomplete-")).length, 1);
});

test("lock/control state and host staging stay outside model-writable system temp", () => {
  const paths = runPaths(RUN_ID, { uid: 501, controlRoot: "/Users/test/Library/Application Support/Daily arXiv" });
  assert.equal(paths.lock, "/Users/test/Library/Application Support/Daily arXiv/active-run.lock");
  assert.ok(paths.runRoot.startsWith("/tmp/daily-arxiv-automation-501/"));
  assert.equal(paths.hostStaging, `/Users/test/Library/Application Support/Daily arXiv/host-staging/${RUN_ID}`);
  assert.ok(!paths.hostStaging.startsWith("/tmp/"));
  assert.ok(!paths.lock.startsWith("/tmp/"));
});

test("reports are copied into an initially empty host-only staging directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-copy-test-"));
  const source = join(root, "model");
  const host = join(root, "host");
  mkdirSync(source);
  mkdirSync(host);
  for (const [index, category] of CATEGORIES.entries()) {
    writeFileSync(join(source, `${DATE}-${category}.json`), `${JSON.stringify({ slug: category, value: index })}\n`);
  }
  const reports = copyReportsToHostStaging({ sourceDirectory: source, hostDirectory: host, date: DATE });
  assert.deepEqual(Object.keys(reports), CATEGORIES);
  assert.deepEqual(readdirSync(host).sort(), CATEGORIES.map((category) => `${DATE}-${category}.json`).sort());
  assert.throws(
    () => copyReportsToHostStaging({ sourceDirectory: source, hostDirectory: host, date: DATE }),
    /start empty/,
  );
});

test("host output layout requires exact regular reports and an empty outbox", async () => {
  const valid = await fixture();
  for (const category of CATEGORIES) writeFileSync(join(valid.staging, `${DATE}-${category}.json`), "{}\n");
  assert.deepEqual(
    validateModelOutputLayout({
      stagingDirectory: valid.staging,
      outboxDirectory: join(valid.root, "outbox"),
      date: DATE,
    }),
    { date: DATE, files: CATEGORIES.map((category) => `${DATE}-${category}.json`) },
  );

  const nonemptyOutbox = await fixture();
  for (const category of CATEGORIES) writeFileSync(join(nonemptyOutbox.staging, `${DATE}-${category}.json`), "{}\n");
  writeFileSync(nonemptyOutbox.manifest, "");
  assert.throws(
    () => validateModelOutputLayout({
      stagingDirectory: nonemptyOutbox.staging,
      outboxDirectory: join(nonemptyOutbox.root, "outbox"),
      date: DATE,
    }),
    /outbox directory must remain empty/,
  );

  const extra = await fixture();
  for (const category of CATEGORIES) writeFileSync(join(extra.staging, `${DATE}-${category}.json`), "{}\n");
  writeFileSync(join(extra.staging, "extra.json"), "{}\n");
  assert.throws(
    () => validateModelOutputLayout({
      stagingDirectory: extra.staging,
      outboxDirectory: join(extra.root, "outbox"),
      date: DATE,
    }),
    /staging directory must contain exactly/,
  );

  const linked = await fixture();
  for (const category of CATEGORIES.slice(1)) writeFileSync(join(linked.staging, `${DATE}-${category}.json`), "{}\n");
  const target = join(linked.root, "target.json");
  writeFileSync(target, "{}\n");
  symlinkSync(target, join(linked.staging, `${DATE}-${CATEGORIES[0]}.json`));
  assert.throws(
    () => validateModelOutputLayout({
      stagingDirectory: linked.staging,
      outboxDirectory: join(linked.root, "outbox"),
      date: DATE,
    }),
    /symlink/,
  );
});

test("a successful run removes only its own temporary directories and Codex log", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-success-cleanup-test-"));
  const base = join(root, "temp");
  const controlRoot = join(root, "control");
  const logDirectory = join(controlRoot, "logs");
  const paths = {
    base,
    controlRoot,
    logDirectory,
    runRoot: join(base, RUN_ID),
    hostStaging: join(controlRoot, "host-staging", RUN_ID),
    codexLog: join(logDirectory, `${RUN_ID}.codex.log`),
  };
  mkdirSync(paths.runRoot, { recursive: true });
  mkdirSync(paths.hostStaging, { recursive: true });
  mkdirSync(logDirectory, { recursive: true });
  writeFileSync(join(paths.runRoot, "temporary.pdf"), "temporary");
  writeFileSync(join(paths.hostStaging, "report.json"), "{}\n");
  writeFileSync(paths.codexLog, "completed\n");
  const unrelated = join(root, "keep.txt");
  writeFileSync(unrelated, "keep\n");

  removeSuccessfulRunArtifacts(paths);

  assert.equal(existsSync(paths.runRoot), false);
  assert.equal(existsSync(paths.hostStaging), false);
  assert.equal(existsSync(paths.codexLog), false);
  assert.equal(readFileSync(unrelated, "utf8"), "keep\n");
});

test("successful-run cleanup rejects paths outside the exact run scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-cleanup-guard-test-"));
  const base = join(root, "temp");
  const controlRoot = join(root, "control");
  const logDirectory = join(controlRoot, "logs");
  const outside = join(root, "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "keep.txt"), "keep\n");
  assert.throws(() => removeSuccessfulRunArtifacts({
    base,
    controlRoot,
    logDirectory,
    runRoot: outside,
    hostStaging: join(controlRoot, "host-staging", RUN_ID),
    codexLog: join(logDirectory, `${RUN_ID}.codex.log`),
  }), /Invalid automation runId|outside the exact/);
  assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "keep\n");
});

test("captured Codex-style logs are bounded and oversize output fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-log-limit-test-"));
  const log = join(root, "captured.log");
  assert.throws(() => runCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096))"], {
    cwd: root,
    outputPath: log,
    maxOutputBytes: 1024,
    allowFailure: true,
  }), /ENOBUFS|maxBuffer|buffer|host limit/i);
  assert.ok(statSync(log).size <= 1024);
  assert.match(readFileSync(log, "utf8"), /LOG TRUNCATED|PROCESS ERROR/);
});

test("ready manifest requires the exact three regular report files", async () => {
  const paths = await fixture();
  for (const category of CATEGORIES) writeFileSync(join(paths.staging, `${DATE}-${category}.json`), "{}\n");
  writeFileSync(paths.manifest, `${JSON.stringify(manifestObject(paths.staging))}\n`);
  assert.deepEqual(
    validateManifest(paths.manifest, { runId: RUN_ID, stagingPath: paths.staging }),
    { status: "ready", date: DATE, stagingPath: paths.staging, message: "Three complete reports are ready." },
  );
});

test("manifest rejects runId substitution, extra staging files, and symlink reports", async () => {
  const wrongRun = await fixture();
  writeFileSync(wrongRun.manifest, `${JSON.stringify(manifestObject(wrongRun.staging, { runId: "run-20990105T123456Z-deadbeefcafe" }))}\n`);
  assert.throws(() => validateManifest(wrongRun.manifest, { runId: RUN_ID, stagingPath: wrongRun.staging }), /runId/);

  const extra = await fixture();
  for (const category of CATEGORIES) writeFileSync(join(extra.staging, `${DATE}-${category}.json`), "{}\n");
  writeFileSync(join(extra.staging, "extra.json"), "{}\n");
  writeFileSync(extra.manifest, `${JSON.stringify(manifestObject(extra.staging))}\n`);
  assert.throws(() => validateManifest(extra.manifest, { runId: RUN_ID, stagingPath: extra.staging }), /exactly/);

  const linked = await fixture();
  for (const category of CATEGORIES.slice(1)) writeFileSync(join(linked.staging, `${DATE}-${category}.json`), "{}\n");
  const target = join(linked.root, "target.json");
  writeFileSync(target, "{}\n");
  symlinkSync(target, join(linked.staging, `${DATE}-${CATEGORIES[0]}.json`));
  writeFileSync(linked.manifest, `${JSON.stringify(manifestObject(linked.staging))}\n`);
  assert.throws(() => validateManifest(linked.manifest, { runId: RUN_ID, stagingPath: linked.staging }), /symlink/);
});

test("manifest message cannot inject extra log lines or terminal controls", async () => {
  const paths = await fixture();
  for (const category of CATEGORIES) writeFileSync(join(paths.staging, `${DATE}-${category}.json`), "{}\n");
  writeFileSync(paths.manifest, `${JSON.stringify(manifestObject(paths.staging, { message: "ready\nFAKE_SUCCESS" }))}\n`);
  assert.throws(
    () => validateManifest(paths.manifest, { runId: RUN_ID, stagingPath: paths.staging }),
    /single line/,
  );
});

test("no_change manifest is rejected after the host has fixed a new snapshot", async () => {
  const paths = await fixture();
  writeFileSync(paths.manifest, `${JSON.stringify(manifestObject(paths.staging, {
    status: "no_change",
    reportDate: null,
    reportFiles: [],
    message: "No complete new common announcement.",
  }))}\n`);
  assert.throws(
    () => validateManifest(paths.manifest, { runId: RUN_ID, stagingPath: paths.staging }),
    /status must be ready/,
  );
});
