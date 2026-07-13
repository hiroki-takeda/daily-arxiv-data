import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  LAUNCHD_LABEL,
  assertJapanTimeZone,
  assertPrivateDirectoryMode,
  calendarIntervals,
  launchdPaths,
  renderLaunchdPlist,
} from "../scripts/lib/macos-schedule.mjs";

const CODEX_IDENTITY = {
  path: "/Applications/Codex/bin/codex",
  sha256: "a".repeat(64),
  version: "codex-cli 1.2.3",
};

test("system timezone check reads the macOS localtime target instead of TZ", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-timezone-test-"));
  const zone = join(root, "zoneinfo", "Asia", "Tokyo");
  mkdirSync(zone, { recursive: true });
  const localtime = join(root, "localtime");
  symlinkSync(zone, localtime);
  assert.equal(assertJapanTimeZone({ platform: "darwin", localtimePath: localtime }), "Asia/Tokyo");
  assert.throws(() => assertJapanTimeZone({ platform: "linux", localtimePath: localtime }), /only on macOS/);
});

test("host control directories require private 0700-style permissions", () => {
  assert.equal(assertPrivateDirectoryMode(0o40700), 0o40700);
  assert.throws(() => assertPrivateDirectoryMode(0o40750), /0700/);
  assert.throws(() => assertPrivateDirectoryMode(0o40755), /0700/);
});

test("launchd schedule covers both weekday runs and no weekends", () => {
  const intervals = calendarIntervals();
  assert.equal(intervals.length, 10);
  assert.deepEqual(new Set(intervals.map(({ weekday }) => weekday)), new Set([1, 2, 3, 4, 5]));
  for (const weekday of [1, 2, 3, 4, 5]) {
    assert.deepEqual(
      intervals.filter((entry) => entry.weekday === weekday).map(({ hour, minute }) => [hour, minute]),
      [[11, 30], [16, 30]],
    );
  }
});

test("launchd plist uses absolute paths and checks for missed work when loaded", () => {
  const repositoryRoot = "/Users/example/Daily arXiv/repo";
  const homeDirectory = "/Users/example";
  const paths = launchdPaths({ repositoryRoot, homeDirectory });
  const plist = renderLaunchdPlist({
    nodePath: "/usr/local/bin/node",
    homeDirectory,
    codexIdentity: CODEX_IDENTITY,
    ...paths,
  });

  assert.match(plist, new RegExp(`<string>${LAUNCHD_LABEL}</string>`));
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(plist, /Daily arXiv\/repo-publisher\/scripts\/run-local-automation\.mjs/);
  assert.match(plist, /DAILY_ARXIV_AGENT_WORKTREE_BASE/);
  assert.match(plist, /Daily arXiv\/repo-agent/);
  assert.match(plist, /DAILY_ARXIV_CONTROL_ROOT/);
  assert.match(plist, /CODEX_BIN/);
  assert.match(plist, new RegExp(CODEX_IDENTITY.sha256));
  assert.match(plist, /codex-cli 1\.2\.3/);
  assert.match(plist, /Library\/Application Support\/Daily arXiv\/logs/);
  assert.match(plist, /<key>StartCalendarInterval<\/key>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.doesNotMatch(plist, /<key>KeepAlive<\/key>/);
  assert.doesNotMatch(plist, /OPENAI_API_KEY|GITHUB_TOKEN|SSH_AUTH_SOCK/);
});

test("launchd plist XML-escapes paths", () => {
  const plist = renderLaunchdPlist({
    nodePath: "/tmp/node",
    publisherRoot: "/tmp/a&b-publisher",
    agentWorktreeBase: "/tmp/a&b-agent",
    controlRoot: "/tmp/a&b-control",
    codexIdentity: CODEX_IDENTITY,
    homeDirectory: "/tmp/home",
    runnerPath: "/tmp/a&b/runner.mjs",
    stdoutPath: "/tmp/a&b/out.log",
    stderrPath: "/tmp/a&b/err.log",
  });
  assert.match(plist, /a&amp;b/);
  assert.doesNotMatch(plist, /a&b/);
});
