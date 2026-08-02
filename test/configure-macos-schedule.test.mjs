import assert from "node:assert/strict";
import test from "node:test";
import {
  assertLaunchctlPrintServiceMatches,
  parseLaunchctlPrintService,
} from "../scripts/configure-macos-schedule.mjs";

const EXPECTED = Object.freeze({
  service: "gui/501/com.hiroki.daily-arxiv",
  path: "/Users/test/Library/LaunchAgents/com.hiroki.daily-arxiv.plist",
  type: "LaunchAgent",
  program: "/usr/local/bin/node",
  arguments: [
    "/usr/local/bin/node",
    "/Users/test/Daily arXiv/daily-arxiv-data-publisher/scripts/run-local-automation.mjs",
  ],
  workingDirectory: "/Users/test/Daily arXiv/daily-arxiv-data-publisher",
  stdoutPath: "/Users/test/Library/Application Support/Daily arXiv/logs/launchd.stdout.log",
  stderrPath: "/Users/test/Library/Application Support/Daily arXiv/logs/launchd.stderr.log",
  calendarIntervals: [
    { weekday: 1, hour: 11, minute: 30 },
    { weekday: 1, hour: 16, minute: 30 },
    { weekday: 2, hour: 11, minute: 30 },
    { weekday: 2, hour: 16, minute: 30 },
    { weekday: 3, hour: 11, minute: 30 },
    { weekday: 3, hour: 16, minute: 30 },
    { weekday: 4, hour: 11, minute: 30 },
    { weekday: 4, hour: 16, minute: 30 },
    { weekday: 5, hour: 11, minute: 30 },
    { weekday: 5, hour: 16, minute: 30 },
  ],
  runAtLoad: true,
  processType: "Background",
  throttleInterval: 300,
  environment: {
    DAILY_ARXIV_CODEX_VERSION: "codex-cli 1.2.3",
    CODEX_BIN: "/Users/test/Library/Application Support/Daily arXiv/runtimes/codex/abc/codex",
    DAILY_ARXIV_AGENT_WORKTREE_BASE: "/Users/test/Daily arXiv/daily-arxiv-data-agent",
    DAILY_ARXIV_CONTROL_ROOT: "/Users/test/Library/Application Support/Daily arXiv",
    DAILY_ARXIV_CODEX_SHA256: "a".repeat(64),
    LANG: "en_US.UTF-8",
    PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: "/Users/test",
    XPC_SERVICE_NAME: "com.hiroki.daily-arxiv",
  },
});

function launchctlFixture() {
  const triggers = EXPECTED.calendarIntervals
    .map(({ weekday, hour, minute }, index) => `\t\tcom.hiroki.daily-arxiv.${1000 + index} => {
\t\t\tkeepalive = 0
\t\t\tservice = com.hiroki.daily-arxiv
\t\t\tstream = com.apple.launchd.calendarinterval
\t\t\tmonitor = com.apple.UserEventAgent-Aqua
\t\t\tdescriptor = {
\t\t\t\t"Minute" => ${minute}
\t\t\t\t"Hour" => ${hour}
\t\t\t\t"Weekday" => ${weekday}
\t\t\t}
\t\t}`)
    .reverse()
    .join("\n");
  return `${EXPECTED.service} = {
\tactive count = 0
\tpath = ${EXPECTED.path}
\ttype = ${EXPECTED.type}
\tstate = not running

\tprogram = ${EXPECTED.program}
\targuments = {
\t\t${EXPECTED.arguments[0]}
\t\t${EXPECTED.arguments[1]}
\t}

\tworking directory = ${EXPECTED.workingDirectory}

\tstdout path = ${EXPECTED.stdoutPath}
\tstderr path = ${EXPECTED.stderrPath}
\tinherited environment = {
\t\tSSH_AUTH_SOCK => /private/tmp/Listeners
\t}

\tdefault environment = {
\t\tPATH => /usr/bin:/bin:/usr/sbin:/sbin
\t}

\tenvironment = {
\t\tDAILY_ARXIV_CODEX_VERSION => ${EXPECTED.environment.DAILY_ARXIV_CODEX_VERSION}
\t\tCODEX_BIN => ${EXPECTED.environment.CODEX_BIN}
\t\tDAILY_ARXIV_AGENT_WORKTREE_BASE => ${EXPECTED.environment.DAILY_ARXIV_AGENT_WORKTREE_BASE}
\t\tDAILY_ARXIV_CONTROL_ROOT => ${EXPECTED.environment.DAILY_ARXIV_CONTROL_ROOT}
\t\tDAILY_ARXIV_CODEX_SHA256 => ${EXPECTED.environment.DAILY_ARXIV_CODEX_SHA256}
\t\tLANG => ${EXPECTED.environment.LANG}
\t\tPATH => ${EXPECTED.environment.PATH}
\t\tHOME => ${EXPECTED.environment.HOME}
\t\tXPC_SERVICE_NAME => ${EXPECTED.environment.XPC_SERVICE_NAME}
\t}

\tdomain = gui/501 [100016]
\tminimum runtime = ${EXPECTED.throttleInterval}
\tevent triggers = {
${triggers}
\t}
\tspawn type = background (5)
\truns = 16
\tproperties = runatload | inferred program
}
`;
}

test("launchctl service parser extracts exact top-level structure", () => {
  const parsed = parseLaunchctlPrintService(launchctlFixture());
  assert.equal(parsed.service, EXPECTED.service);
  assert.equal(parsed.program, EXPECTED.program);
  assert.deepEqual(parsed.arguments, EXPECTED.arguments);
  assert.equal(parsed.workingDirectory, EXPECTED.workingDirectory);
  assert.deepEqual(parsed.environment, EXPECTED.environment);
  assert.deepEqual(
    [...parsed.calendarIntervals].sort((a, b) => (
      a.weekday - b.weekday || a.hour - b.hour || a.minute - b.minute
    )),
    EXPECTED.calendarIntervals,
  );
  assert.equal(parsed.runAtLoad, true);
  assert.equal(parsed.processType, "Background");
  assert.equal(parsed.throttleInterval, 300);
  assert.deepEqual(assertLaunchctlPrintServiceMatches(launchctlFixture(), EXPECTED), parsed);
});

test("loaded service comparison rejects substring, argument, and environment substitutions", async (context) => {
  await context.test("program substring elsewhere cannot hide a different program", () => {
    const changed = launchctlFixture().replace(
      `\tprogram = ${EXPECTED.program}`,
      `\tprogram = ${EXPECTED.program}.unreviewed`,
    );
    assert.throws(
      () => assertLaunchctlPrintServiceMatches(changed, EXPECTED),
      /program does not exactly match/,
    );
  });

  await context.test("argument order and count are exact", () => {
    const changed = launchctlFixture().replace(
      `\t\t${EXPECTED.arguments[1]}\n\t}`,
      `\t\t/extra/argument\n\t\t${EXPECTED.arguments[1]}\n\t}`,
    );
    assert.throws(
      () => assertLaunchctlPrintServiceMatches(changed, EXPECTED),
      /arguments do not exactly match/,
    );
  });

  await context.test("environment values and keys are exact", () => {
    const changedValue = launchctlFixture().replace(
      `\t\tCODEX_BIN => ${EXPECTED.environment.CODEX_BIN}`,
      `\t\tCODEX_BIN => ${EXPECTED.environment.CODEX_BIN}.unreviewed`,
    );
    assert.throws(
      () => assertLaunchctlPrintServiceMatches(changedValue, EXPECTED),
      /environment CODEX_BIN does not exactly match/,
    );
    const extraKey = launchctlFixture().replace(
      "\t\tXPC_SERVICE_NAME => com.hiroki.daily-arxiv",
      "\t\tUNREVIEWED => value\n\t\tXPC_SERVICE_NAME => com.hiroki.daily-arxiv",
    );
    assert.throws(
      () => assertLaunchctlPrintServiceMatches(extraKey, EXPECTED),
      /environment keys do not exactly match/,
    );
  });

  await context.test("duplicate top-level fields fail closed", () => {
    const duplicate = launchctlFixture().replace(
      `\tprogram = ${EXPECTED.program}`,
      `\tprogram = ${EXPECTED.program}\n\tprogram = ${EXPECTED.program}`,
    );
    assert.throws(
      () => parseLaunchctlPrintService(duplicate),
      /exactly one top-level program/,
    );
  });

  await context.test("calendar interval mutations are rejected regardless of trigger order", () => {
    const changed = launchctlFixture().replace(
      '\t\t\t\t"Hour" => 16',
      '\t\t\t\t"Hour" => 15',
    );
    assert.throws(
      () => assertLaunchctlPrintServiceMatches(changed, EXPECTED),
      /StartCalendarInterval does not exactly match/,
    );
  });

  await context.test("duplicate calendar intervals fail closed", () => {
    const changed = launchctlFixture().replace(
      '\t\t\t\t"Weekday" => 5',
      '\t\t\t\t"Weekday" => 4',
    );
    assert.throws(
      () => parseLaunchctlPrintService(changed),
      /duplicate calendar intervals/,
    );
  });

  await context.test("duplicate and malformed calendar descriptor fields fail closed", () => {
    const duplicate = launchctlFixture().replace(
      '\t\t\t\t"Minute" => 30',
      '\t\t\t\t"Minute" => 30\n\t\t\t\t"Minute" => 30',
    );
    assert.throws(
      () => parseLaunchctlPrintService(duplicate),
      /descriptor contains duplicate Minute/,
    );
    const malformed = launchctlFixture().replace(
      '\t\t\t\t"Hour" => 16',
      '\t\t\t\t"Hour" = 16',
    );
    assert.throws(
      () => parseLaunchctlPrintService(malformed),
      /descriptor is malformed/,
    );
  });

  await context.test("RunAtLoad properties are an exact order-independent set", () => {
    const reversed = launchctlFixture().replace(
      "\tproperties = runatload | inferred program",
      "\tproperties = inferred program | runatload",
    );
    assert.equal(parseLaunchctlPrintService(reversed).runAtLoad, true);
    assert.deepEqual(assertLaunchctlPrintServiceMatches(reversed, EXPECTED).runAtLoad, true);

    const disabled = launchctlFixture().replace(
      "\tproperties = runatload | inferred program",
      "\tproperties = inferred program",
    );
    assert.throws(
      () => assertLaunchctlPrintServiceMatches(disabled, EXPECTED),
      /RunAtLoad does not exactly match/,
    );
    const missingInferredProgram = launchctlFixture().replace(
      "\tproperties = runatload | inferred program",
      "\tproperties = runatload",
    );
    assert.throws(
      () => assertLaunchctlPrintServiceMatches(missingInferredProgram, EXPECTED),
      /RunAtLoad does not exactly match/,
    );
    const duplicate = launchctlFixture().replace(
      "\tproperties = runatload | inferred program",
      "\tproperties = runatload | inferred program | runatload",
    );
    assert.throws(
      () => parseLaunchctlPrintService(duplicate),
      /duplicate properties/,
    );

    const unknown = launchctlFixture().replace(
      "\tproperties = runatload | inferred program",
      "\tproperties = runatload | inferred program | keepalive",
    );
    assert.throws(
      () => assertLaunchctlPrintServiceMatches(unknown, EXPECTED),
      /RunAtLoad does not exactly match/,
    );
  });

  await context.test("ProcessType mutation fails closed", () => {
    const changed = launchctlFixture().replace(
      "\tspawn type = background (5)",
      "\tspawn type = foreground (4)",
    );
    assert.throws(
      () => parseLaunchctlPrintService(changed),
      /unsupported ProcessType mapping/,
    );
  });

  await context.test("ThrottleInterval minimum runtime mutation and duplicate fail closed", () => {
    const changed = launchctlFixture().replace(
      "\tminimum runtime = 300",
      "\tminimum runtime = 299",
    );
    assert.throws(
      () => assertLaunchctlPrintServiceMatches(changed, EXPECTED),
      /ThrottleInterval\/minimum runtime does not exactly match/,
    );
    const duplicate = launchctlFixture().replace(
      "\tminimum runtime = 300",
      "\tminimum runtime = 300\n\tminimum runtime = 300",
    );
    assert.throws(
      () => parseLaunchctlPrintService(duplicate),
      /exactly one top-level minimum runtime/,
    );
  });
});
