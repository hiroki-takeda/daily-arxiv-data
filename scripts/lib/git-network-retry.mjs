const RETRYABLE_PROCESS_CODES = new Set([
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENETDOWN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
]);
const RETRYABLE_GIT_NETWORK_OUTPUT = /(?:ssh: connect to host .* port \d+: (?:Operation timed out|Connection timed out|Connection reset|Connection refused|Network is unreachable|No route to host|Undefined error: ?0)|Could not resolve (?:host|hostname)|Connection (?:timed out|reset|refused|closed)|Operation timed out|Network is unreachable|No route to host|remote end hung up|RPC failed|HTTP 408|HTTP 425|HTTP 429|HTTP 5\d\d)/iu;

export const GIT_NETWORK_RETRY_DELAYS_MS = Object.freeze([
  5_000,
  30_000,
  120_000,
  300_000,
]);

function isRetryableProcessCode(value) {
  return typeof value === "string" && RETRYABLE_PROCESS_CODES.has(value.toUpperCase());
}

function gitOutput(failure) {
  if (failure === null || typeof failure !== "object") return String(failure ?? "");
  return [failure.stderr, failure.stdout]
    .filter((value) => value !== undefined && value !== null)
    .join("\n");
}

export function isRetryableGitNetworkFailure(failure) {
  if (failure !== null && typeof failure === "object") {
    if (
      isRetryableProcessCode(failure.code)
      || isRetryableProcessCode(failure.errno)
      || isRetryableProcessCode(failure.error?.code)
      || isRetryableProcessCode(failure.error?.errno)
    ) return true;
  }
  const output = gitOutput(failure);
  return RETRYABLE_GIT_NETWORK_OUTPUT.test(output);
}

function waitSynchronously(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function runWithBoundedGitNetworkRetries(operation, {
  retryDelays,
  wait = waitSynchronously,
} = {}) {
  if (typeof operation !== "function") throw new TypeError("Git network operation must be a function.");
  if (!Array.isArray(retryDelays) || retryDelays.some((delay) => !Number.isSafeInteger(delay) || delay < 0)) {
    throw new TypeError("Git network retry delays must be non-negative safe integers.");
  }
  if (typeof wait !== "function") throw new TypeError("Git network retry wait must be a function.");

  let result;
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      result = operation();
    } catch (error) {
      if (attempt >= retryDelays.length || !isRetryableGitNetworkFailure(error)) throw error;
      wait(retryDelays[attempt]);
      continue;
    }
    if (result?.status === 0) return result;
    if (attempt >= retryDelays.length || !isRetryableGitNetworkFailure(result)) return result;
    wait(retryDelays[attempt]);
  }
  return result;
}

export function runGitPushWithRemoteConfirmation({
  push,
  fetch,
  readRemoteHead,
  expectedRemoteHead,
}) {
  for (const [name, operation] of Object.entries({ push, fetch, readRemoteHead })) {
    if (typeof operation !== "function") throw new TypeError(`Git ${name} operation must be a function.`);
  }
  if (typeof expectedRemoteHead !== "string" || expectedRemoteHead.length === 0) {
    throw new TypeError("Expected remote Git head must be a non-empty string.");
  }

  let pushResult = null;
  let ambiguousPushError = null;
  try {
    pushResult = push();
  } catch (error) {
    if (!isRetryableGitNetworkFailure(error)) throw error;
    ambiguousPushError = error;
  }
  if (pushResult?.status === 0) {
    return Object.freeze({ pushResult, remoteConfirmed: false });
  }

  const fetchResult = fetch();
  const remoteConfirmed = fetchResult?.status === 0 && readRemoteHead() === expectedRemoteHead;
  if (remoteConfirmed) return Object.freeze({ pushResult, remoteConfirmed: true });
  if (ambiguousPushError !== null) throw ambiguousPushError;
  return Object.freeze({ pushResult, remoteConfirmed: false });
}
