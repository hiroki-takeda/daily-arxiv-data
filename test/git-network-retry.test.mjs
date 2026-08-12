import assert from "node:assert/strict";
import test from "node:test";
import {
  GIT_NETWORK_RETRY_DELAYS_MS,
  isRetryableGitNetworkFailure,
  runGitPushWithRemoteConfirmation,
  runWithBoundedGitNetworkRetries,
} from "../scripts/lib/git-network-retry.mjs";

function processError(code, message) {
  return Object.assign(new Error(message), { code, errno: code });
}

test("Git network failure classification admits only bounded transient process errors", () => {
  for (const code of [
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ECONNRESET",
    "ECONNREFUSED",
    "ENETDOWN",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "EPIPE",
  ]) {
    assert.equal(isRetryableGitNetworkFailure(processError(code, `spawnSync git ${code}`)), true, code);
  }
  for (const code of ["ENOENT", "EACCES", "EPERM"]) {
    assert.equal(
      isRetryableGitNetworkFailure(processError(code, "fatal: unable to access remote: HTTP 503")),
      false,
      code,
    );
  }
  assert.equal(isRetryableGitNetworkFailure({
    status: 128,
    stderr: "ssh: connect to host github.com port 22: Undefined error: 0",
  }), true);
  assert.equal(isRetryableGitNetworkFailure({
    status: 128,
    stderr: [
      "ssh: connect to host github.com port 22: Operation timed out",
      "fatal: Could not read from remote repository.",
      "Please make sure you have the correct access rights and the repository exists.",
    ].join("\n"),
  }), true);
  assert.equal(isRetryableGitNetworkFailure({
    status: 128,
    stderr: "fatal: pathspec 'missing' did not match any files",
  }), false);
  for (const stderr of [
    "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
    "Host key verification failed.\nfatal: Could not read from remote repository.",
    "fatal: unable to access repository: SSL certificate problem: unable to get local issuer certificate",
    "remote: Repository not found.\nfatal: unable to access repository: The requested URL returned error: 403",
    "fatal: Authentication failed for repository",
  ]) {
    assert.equal(isRetryableGitNetworkFailure({ status: 128, stderr }), false, stderr);
  }
});

test("bounded Git network retry performs exactly five attempts with the production waits", () => {
  assert.deepEqual(GIT_NETWORK_RETRY_DELAYS_MS, [5_000, 30_000, 120_000, 300_000]);
  const waits = [];
  let attempts = 0;
  const timeout = processError("ETIMEDOUT", "spawnSync git ETIMEDOUT");
  assert.throws(() => runWithBoundedGitNetworkRetries(() => {
    attempts += 1;
    throw timeout;
  }, {
    retryDelays: GIT_NETWORK_RETRY_DELAYS_MS,
    wait: (delay) => waits.push(delay),
  }), (error) => error === timeout);

  assert.equal(attempts, 5);
  assert.deepEqual(waits, [5_000, 30_000, 120_000, 300_000]);
});

test("bounded Git network retry also retries returned network failures", () => {
  const waits = [];
  let attempts = 0;
  const result = runWithBoundedGitNetworkRetries(() => {
    attempts += 1;
    return attempts === 1
      ? { status: 128, stdout: "", stderr: "fatal: unable to access remote: HTTP 503" }
      : { status: 0, stdout: "fetched\n", stderr: "" };
  }, {
    retryDelays: [2_000],
    wait: (delay) => waits.push(delay),
  });

  assert.equal(result.status, 0);
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [2_000]);
});

test("bounded Git network retry preserves its limit and does not retry ordinary errors", () => {
  const timeout = processError("ETIMEDOUT", "spawnSync git ETIMEDOUT");
  let timeoutAttempts = 0;
  assert.throws(() => runWithBoundedGitNetworkRetries(() => {
    timeoutAttempts += 1;
    throw timeout;
  }, {
    retryDelays: [0, 0],
    wait: () => {},
  }), (error) => error === timeout);
  assert.equal(timeoutAttempts, 3);

  const ordinary = processError("EACCES", "spawnSync git EACCES");
  let ordinaryAttempts = 0;
  assert.throws(() => runWithBoundedGitNetworkRetries(() => {
    ordinaryAttempts += 1;
    throw ordinary;
  }, {
    retryDelays: [0, 0],
    wait: () => {},
  }), (error) => error === ordinary);
  assert.equal(ordinaryAttempts, 1);
});

test("ambiguous timed-out push is accepted only after the fetched remote matches", () => {
  const timeout = processError("ETIMEDOUT", "spawnSync git ETIMEDOUT");
  const calls = [];
  const outcome = runGitPushWithRemoteConfirmation({
    push: () => {
      calls.push("push");
      throw timeout;
    },
    fetch: () => {
      calls.push("fetch");
      return { status: 0, stdout: "", stderr: "" };
    },
    readRemoteHead: () => {
      calls.push("read");
      return "a".repeat(40);
    },
    expectedRemoteHead: "a".repeat(40),
  });

  assert.equal(outcome.pushResult, null);
  assert.equal(outcome.remoteConfirmed, true);
  assert.deepEqual(calls, ["push", "fetch", "read"]);
});

test("ambiguous timed-out push fails closed when the fetched remote does not match", () => {
  const timeout = processError("ETIMEDOUT", "spawnSync git ETIMEDOUT");
  let fetches = 0;
  assert.throws(() => runGitPushWithRemoteConfirmation({
    push: () => { throw timeout; },
    fetch: () => {
      fetches += 1;
      return { status: 0, stdout: "", stderr: "" };
    },
    readRemoteHead: () => "b".repeat(40),
    expectedRemoteHead: "a".repeat(40),
  }), (error) => error === timeout);
  assert.equal(fetches, 1);
});

test("non-transient thrown push errors never enter remote confirmation", () => {
  const denied = processError("EACCES", "spawnSync git EACCES");
  let fetches = 0;
  assert.throws(() => runGitPushWithRemoteConfirmation({
    push: () => { throw denied; },
    fetch: () => {
      fetches += 1;
      return { status: 0, stdout: "", stderr: "" };
    },
    readRemoteHead: () => "a".repeat(40),
    expectedRemoteHead: "a".repeat(40),
  }), (error) => error === denied);
  assert.equal(fetches, 0);
});
