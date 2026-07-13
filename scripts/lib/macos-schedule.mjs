import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

export const LAUNCHD_LABEL = "com.hiroki.daily-arxiv";

export function assertPrivateDirectoryMode(mode, label = "Directory") {
  if (!Number.isInteger(mode) || (mode & 0o077) !== 0) {
    throw new Error(`${label} must use private 0700 permissions.`);
  }
  return mode;
}

export function macosSystemTimeZone(localtimePath = "/etc/localtime") {
  const target = realpathSync(localtimePath);
  const marker = "/zoneinfo/";
  const index = target.indexOf(marker);
  if (index < 0 || index + marker.length >= target.length) {
    throw new Error(`Cannot determine macOS system timezone from ${target}.`);
  }
  return target.slice(index + marker.length);
}

export function assertJapanTimeZone({ platform = process.platform, localtimePath } = {}) {
  if (platform !== "darwin") throw new Error("Daily arXiv local scheduling is supported only on macOS.");
  const timeZone = macosSystemTimeZone(localtimePath);
  if (timeZone !== "Asia/Tokyo") {
    throw new Error(`Expected macOS system timezone Asia/Tokyo, got ${timeZone}.`);
  }
  return timeZone;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function calendarIntervals() {
  const intervals = [];
  for (const weekday of [1, 2, 3, 4, 5]) {
    for (const hour of [11, 16]) intervals.push({ weekday, hour, minute: 30 });
  }
  return intervals;
}

function calendarXml() {
  return calendarIntervals()
    .map(({ weekday, hour, minute }) => `    <dict>
      <key>Weekday</key><integer>${weekday}</integer>
      <key>Hour</key><integer>${hour}</integer>
      <key>Minute</key><integer>${minute}</integer>
    </dict>`)
    .join("\n");
}

export function launchdPaths({
  repositoryRoot,
  homeDirectory,
  publisherRoot = resolve(dirname(repositoryRoot), `${basename(repositoryRoot)}-publisher`),
  agentWorktreeBase = resolve(dirname(repositoryRoot), `${basename(repositoryRoot)}-agent`),
  controlRoot = resolve(homeDirectory, "Library", "Application Support", "Daily arXiv"),
}) {
  const root = resolve(repositoryRoot);
  const publisher = resolve(publisherRoot);
  const logDirectory = resolve(controlRoot, "logs");
  return {
    sourceRepositoryRoot: root,
    publisherRoot: publisher,
    agentWorktreeBase: resolve(agentWorktreeBase),
    controlRoot: resolve(controlRoot),
    runnerPath: resolve(publisher, "scripts", "run-local-automation.mjs"),
    logDirectory,
    stdoutPath: resolve(logDirectory, "launchd.stdout.log"),
    stderrPath: resolve(logDirectory, "launchd.stderr.log"),
    plistPath: resolve(homeDirectory, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
  };
}

export function renderLaunchdPlist({
  nodePath,
  publisherRoot,
  agentWorktreeBase,
  controlRoot,
  codexIdentity,
  homeDirectory,
  runnerPath,
  stdoutPath,
  stderrPath,
}) {
  const environmentPath = [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
  const values = {
    nodePath: escapeXml(resolve(nodePath)),
    publisherRoot: escapeXml(resolve(publisherRoot)),
    agentWorktreeBase: escapeXml(resolve(agentWorktreeBase)),
    controlRoot: escapeXml(resolve(controlRoot)),
    homeDirectory: escapeXml(resolve(homeDirectory)),
    runnerPath: escapeXml(resolve(runnerPath)),
    stdoutPath: escapeXml(resolve(stdoutPath)),
    stderrPath: escapeXml(resolve(stderrPath)),
    environmentPath: escapeXml(environmentPath),
    codexPath: escapeXml(resolve(codexIdentity.path)),
    codexSha256: escapeXml(codexIdentity.sha256),
    codexVersion: escapeXml(codexIdentity.version),
  };

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${values.nodePath}</string>
    <string>${values.runnerPath}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${values.publisherRoot}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${values.homeDirectory}</string>
    <key>PATH</key><string>${values.environmentPath}</string>
    <key>LANG</key><string>en_US.UTF-8</string>
    <key>DAILY_ARXIV_AGENT_WORKTREE_BASE</key><string>${values.agentWorktreeBase}</string>
    <key>DAILY_ARXIV_CONTROL_ROOT</key><string>${values.controlRoot}</string>
    <key>CODEX_BIN</key><string>${values.codexPath}</string>
    <key>DAILY_ARXIV_CODEX_SHA256</key><string>${values.codexSha256}</string>
    <key>DAILY_ARXIV_CODEX_VERSION</key><string>${values.codexVersion}</string>
  </dict>
  <key>StartCalendarInterval</key>
  <array>
${calendarXml()}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>300</integer>
  <key>StandardOutPath</key>
  <string>${values.stdoutPath}</string>
  <key>StandardErrorPath</key>
  <string>${values.stderrPath}</string>
</dict>
</plist>
`;
}
