import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  statfsSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const MAX_CODEX_RUNTIME_BYTES = 1024 * 1024 * 1024;
export const CODEX_RUNTIME_FREE_SPACE_RESERVE_BYTES = 64 * 1024 * 1024;

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const VERSION_PATTERN = /^codex-cli \S+$/u;
const COPY_BUFFER_BYTES = 1024 * 1024;
const MAX_INSTALLER_FILE_BYTES = 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function currentUid() {
  if (typeof process.getuid !== "function") fail("Cannot determine the current user for the Codex runtime.");
  return process.getuid();
}

function validateSha256(sha256) {
  if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) {
    fail("Reviewed Codex SHA-256 must be 64 lowercase hexadecimal characters.");
  }
  return sha256;
}

function validateReviewedIdentity(identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    fail("Reviewed Codex identity must be an object.");
  }
  if (typeof identity.path !== "string" || !isAbsolute(identity.path)) {
    fail("Reviewed Codex source path must be absolute.");
  }
  validateSha256(identity.sha256);
  if (typeof identity.version !== "string" || !VERSION_PATTERN.test(identity.version)) {
    fail("Reviewed Codex version has an unexpected format.");
  }
  return identity;
}

function runtimeDirectories(controlRoot) {
  if (typeof controlRoot !== "string" || !isAbsolute(controlRoot)) {
    fail("Daily arXiv control root must be an absolute path.");
  }
  const control = resolve(controlRoot);
  return Object.freeze({
    controlRoot: control,
    runtimesRoot: join(control, "runtimes"),
    codexRoot: join(control, "runtimes", "codex"),
  });
}

export function plannedCodexRuntimePath({ controlRoot, sha256 }) {
  const paths = runtimeDirectories(controlRoot);
  return join(paths.codexRoot, validateSha256(sha256), "codex");
}

function assertPrivateOwnedDirectory(path, label, uid) {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    fail(`${label} must be a real directory: ${path}`);
  }
  if (entry.uid !== uid) fail(`${label} is owned by another user: ${path}`);
  if ((entry.mode & 0o077) !== 0) fail(`${label} must use private 0700 permissions: ${path}`);
}

function ensurePrivateOwnedDirectory(path, label, uid, { recursive = false } = {}) {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700, recursive });
  assertPrivateOwnedDirectory(path, label, uid);
}

function assertSourceMetadata(entry, path, uid, maxBytes) {
  const owner = BigInt(entry.uid);
  const mode = BigInt(entry.mode);
  const size = BigInt(entry.size);
  if (!entry.isFile()) fail(`Reviewed Codex source must be a regular file: ${path}`);
  if (owner !== BigInt(uid)) fail(`Reviewed Codex source is owned by another user: ${path}`);
  if ((mode & 0o022n) !== 0n) {
    fail(`Reviewed Codex source must not be group/world writable: ${path}`);
  }
  if ((mode & 0o100n) === 0n) fail(`Reviewed Codex source is not owner-executable: ${path}`);
  if (size <= 0n || size > BigInt(maxBytes)) {
    fail(`Reviewed Codex source size is outside the allowed range: ${path}`);
  }
}

export function captureReviewedCodexSource({
  path,
  uid = currentUid(),
  maxBinaryBytes = MAX_CODEX_RUNTIME_BYTES,
}) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    fail("Reviewed Codex source path must be absolute.");
  }
  if (!Number.isSafeInteger(uid) || uid < 0) fail("Codex source uid must be a non-negative integer.");
  if (!Number.isSafeInteger(maxBinaryBytes) || maxBinaryBytes <= 0) {
    fail("Codex source byte limit must be a positive safe integer.");
  }
  const entry = lstatSync(path, { bigint: true });
  if (entry.isSymbolicLink()) fail(`Reviewed Codex source must not be a symlink: ${path}`);
  assertSourceMetadata(entry, path, uid, maxBinaryBytes);
  return Object.freeze({
    path,
    dev: entry.dev,
    ino: entry.ino,
    uid: entry.uid,
    mode: entry.mode,
    size: entry.size,
    mtimeNs: entry.mtimeNs,
    ctimeNs: entry.ctimeNs,
  });
}

export function assertReviewedCodexSourceUnchanged({
  review,
  uid = currentUid(),
  maxBinaryBytes = MAX_CODEX_RUNTIME_BYTES,
}) {
  if (!review || typeof review !== "object" || Array.isArray(review)) {
    fail("Reviewed Codex source snapshot must be an object.");
  }
  const current = captureReviewedCodexSource({
    path: review.path,
    uid,
    maxBinaryBytes,
  });
  for (const key of ["path", "dev", "ino", "uid", "mode", "size", "mtimeNs", "ctimeNs"]) {
    if (review[key] !== current[key]) {
      fail(`Reviewed Codex source identity changed during inspection: ${review.path}`);
    }
  }
  return current;
}

function assertSameOpenFile(before, after, path, label = "Reviewed Codex source") {
  for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) {
    if (before[key] !== after[key]) {
      fail(`${label} changed while it was being verified: ${path}`);
    }
  }
}

function writeAll(descriptor, buffer, length, label = "reviewed Codex runtime") {
  let offset = 0;
  while (offset < length) {
    const written = writeSync(descriptor, buffer, offset, length - offset);
    if (written <= 0) fail(`Could not finish writing the ${label}.`);
    offset += written;
  }
}

function hashOpenFile(descriptor, expectedSize, path) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let total = 0n;
  for (;;) {
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    total += BigInt(bytesRead);
    if (total > expectedSize) fail(`Codex runtime changed while it was being verified: ${path}`);
    hash.update(buffer.subarray(0, bytesRead));
  }
  if (total !== expectedSize) fail(`Codex runtime size changed while it was being verified: ${path}`);
  return hash.digest("hex");
}

function assertMaterializedRuntime(path, expectedSha256, uid, maxBytes) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) fail(`Materialized Codex runtime must be a regular file: ${path}`);
    if (before.uid !== BigInt(uid)) fail(`Materialized Codex runtime is owned by another user: ${path}`);
    if ((before.mode & 0o777n) !== 0o500n) {
      fail(`Materialized Codex runtime must use exact 0500 permissions: ${path}`);
    }
    if (before.size <= 0n || before.size > BigInt(maxBytes)) {
      fail(`Materialized Codex runtime size is outside the allowed range: ${path}`);
    }
    const sha256 = hashOpenFile(descriptor, before.size, path);
    const after = fstatSync(descriptor, { bigint: true });
    assertSameOpenFile(before, after, path, "Materialized Codex runtime");
    if (sha256 !== expectedSha256) {
      fail(`Materialized Codex runtime does not match its content-addressed SHA-256: ${path}`);
    }
    return Object.freeze({ path, sha256, size: Number(after.size) });
  } finally {
    closeSync(descriptor);
  }
}

export function verifyMaterializedCodexRuntime({
  controlRoot,
  sha256,
  uid = currentUid(),
  maxBinaryBytes = MAX_CODEX_RUNTIME_BYTES,
}) {
  if (!Number.isSafeInteger(uid) || uid < 0) fail("Codex runtime uid must be a non-negative integer.");
  if (!Number.isSafeInteger(maxBinaryBytes) || maxBinaryBytes <= 0) {
    fail("Codex runtime byte limit must be a positive safe integer.");
  }
  const paths = runtimeDirectories(controlRoot);
  const path = plannedCodexRuntimePath({ controlRoot, sha256 });
  const digestDirectory = join(paths.codexRoot, validateSha256(sha256));
  assertPrivateOwnedDirectory(paths.controlRoot, "Daily arXiv control root", uid);
  assertPrivateOwnedDirectory(paths.runtimesRoot, "Daily arXiv runtimes root", uid);
  assertPrivateOwnedDirectory(paths.codexRoot, "Daily arXiv Codex runtimes root", uid);
  assertPrivateOwnedDirectory(digestDirectory, "Content-addressed Codex runtime directory", uid);
  const entries = readdirSync(digestDirectory).sort();
  if (entries.join("\0") !== "codex") {
    fail(`Content-addressed Codex runtime directory must contain only codex: ${digestDirectory}`);
  }
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    fail(`Materialized Codex runtime must be a real regular file: ${path}`);
  }
  return assertMaterializedRuntime(path, sha256, uid, maxBinaryBytes);
}

function availableBytes(path) {
  const filesystem = statfsSync(path, { bigint: true });
  return filesystem.bavail * filesystem.bsize;
}

function fsyncDirectory(path) {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function validateInstallerFileInput({ path, content, uid, mode, maxBytes }) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    fail("Installer file path must be absolute.");
  }
  if (typeof content !== "string") fail("Installer file content must be a string.");
  if (!Number.isSafeInteger(uid) || uid < 0) fail("Installer file uid must be a non-negative integer.");
  if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777 || (mode & 0o022) !== 0) {
    fail("Installer file mode must not be group/world writable.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    fail("Installer file byte limit must be a positive safe integer.");
  }
  const expected = Buffer.from(content, "utf8");
  if (expected.length === 0 || expected.length > maxBytes) {
    fail("Installer file content is outside the allowed size range.");
  }
  return expected;
}

function assertOwnedSafeInstallerDirectory(path, uid) {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    fail(`Installer parent must be a real directory: ${path}`);
  }
  if (entry.uid !== uid) fail(`Installer parent is owned by another user: ${path}`);
  if ((entry.mode & 0o022) !== 0) {
    fail(`Installer parent must not be group/world writable: ${path}`);
  }
}

export function assertExactOwnedInstallerFile({
  path,
  content,
  uid = currentUid(),
  mode = 0o644,
  maxBytes = MAX_INSTALLER_FILE_BYTES,
}) {
  const expected = validateInstallerFileInput({ path, content, uid, mode, maxBytes });
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) fail(`Installer file must be a regular file: ${path}`);
    if (before.uid !== BigInt(uid)) fail(`Installer file is owned by another user: ${path}`);
    if ((before.mode & 0o022n) !== 0n) {
      fail(`Installer file must not be group/world writable: ${path}`);
    }
    if (before.size !== BigInt(expected.length)) {
      fail(`Installer file does not exactly match the reviewed content: ${path}`);
    }
    const actual = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    assertSameOpenFile(before, after, path, "Installer file");
    if (actual.length !== expected.length || !actual.equals(expected)) {
      fail(`Installer file does not exactly match the reviewed content: ${path}`);
    }
    const pathEntry = lstatSync(path, { bigint: true });
    if (
      pathEntry.isSymbolicLink()
      || !pathEntry.isFile()
      || pathEntry.dev !== after.dev
      || pathEntry.ino !== after.ino
    ) {
      fail(`Installer file path changed while it was being verified: ${path}`);
    }
    return Object.freeze({ path, size: actual.length });
  } finally {
    closeSync(descriptor);
  }
}

export function publishOwnedInstallerFileExclusive({
  path,
  content,
  uid = currentUid(),
  mode = 0o644,
  maxBytes = MAX_INSTALLER_FILE_BYTES,
}) {
  const expected = validateInstallerFileInput({ path, content, uid, mode, maxBytes });
  const parent = dirname(path);
  assertOwnedSafeInstallerDirectory(parent, uid);
  const temporary = `${path}.new-${process.pid}-${randomBytes(12).toString("hex")}`;
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let descriptor;
  let temporaryCreated = false;
  let primaryError;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
      mode,
    );
    temporaryCreated = true;
    writeAll(descriptor, expected, expected.length, "installer file");
    fsyncSync(descriptor);
    fchmodSync(descriptor, mode);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    try {
      linkSync(temporary, path);
    } catch (error) {
      if (error?.code === "EEXIST") {
        fail(`Refusing to replace an installer file that appeared during installation: ${path}`);
      }
      throw error;
    }
  } catch (error) {
    primaryError = error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (temporaryCreated) {
      try {
        unlinkSync(temporary);
      } catch (cleanupError) {
        if (primaryError === undefined) primaryError = cleanupError;
      }
    }
    try {
      fsyncDirectory(parent);
    } catch (durabilityError) {
      if (primaryError === undefined) primaryError = durabilityError;
    }
  }
  if (primaryError !== undefined) throw primaryError;
  return assertExactOwnedInstallerFile({ path, content, uid, mode, maxBytes });
}

function copyReviewedSourceToTemporary({
  sourceIdentity,
  temporaryPath,
  uid,
  maxBinaryBytes,
  onDestinationCreated,
}) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const sourceDescriptor = openSync(sourceIdentity.path, constants.O_RDONLY | noFollow);
  let destinationDescriptor;
  try {
    const sourceBefore = fstatSync(sourceDescriptor, { bigint: true });
    assertSourceMetadata(sourceBefore, sourceIdentity.path, uid, maxBinaryBytes);
    destinationDescriptor = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
      0o600,
    );
    onDestinationCreated();
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let total = 0n;
    for (;;) {
      const bytesRead = readSync(sourceDescriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += BigInt(bytesRead);
      if (total > sourceBefore.size) {
        fail(`Reviewed Codex source changed while it was being copied: ${sourceIdentity.path}`);
      }
      hash.update(buffer.subarray(0, bytesRead));
      writeAll(destinationDescriptor, buffer, bytesRead);
    }
    if (total !== sourceBefore.size) {
      fail(`Reviewed Codex source changed while it was being copied: ${sourceIdentity.path}`);
    }
    const sourceAfter = fstatSync(sourceDescriptor, { bigint: true });
    assertSameOpenFile(sourceBefore, sourceAfter, sourceIdentity.path);
    const copiedSha256 = hash.digest("hex");
    if (copiedSha256 !== sourceIdentity.sha256) {
      fail("Reviewed Codex source no longer matches the approved SHA-256.");
    }
    fsyncSync(destinationDescriptor);
    fchmodSync(destinationDescriptor, 0o500);
    fsyncSync(destinationDescriptor);
  } finally {
    if (destinationDescriptor !== undefined) closeSync(destinationDescriptor);
    closeSync(sourceDescriptor);
  }
}

export function materializeReviewedCodexRuntime({
  controlRoot,
  sourceIdentity,
  uid = currentUid(),
  maxBinaryBytes = MAX_CODEX_RUNTIME_BYTES,
  freeSpaceReserveBytes = CODEX_RUNTIME_FREE_SPACE_RESERVE_BYTES,
}) {
  validateReviewedIdentity(sourceIdentity);
  if (!Number.isSafeInteger(uid) || uid < 0) fail("Codex runtime uid must be a non-negative integer.");
  if (!Number.isSafeInteger(maxBinaryBytes) || maxBinaryBytes <= 0) {
    fail("Codex runtime byte limit must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(freeSpaceReserveBytes) || freeSpaceReserveBytes < 0) {
    fail("Codex runtime free-space reserve must be a non-negative safe integer.");
  }

  const paths = runtimeDirectories(controlRoot);
  const digestDirectory = join(paths.codexRoot, sourceIdentity.sha256);
  const finalPath = plannedCodexRuntimePath({
    controlRoot: paths.controlRoot,
    sha256: sourceIdentity.sha256,
  });
  ensurePrivateOwnedDirectory(paths.controlRoot, "Daily arXiv control root", uid, { recursive: true });
  ensurePrivateOwnedDirectory(paths.runtimesRoot, "Daily arXiv runtimes root", uid);
  ensurePrivateOwnedDirectory(paths.codexRoot, "Daily arXiv Codex runtimes root", uid);

  if (existsSync(digestDirectory)) {
    assertPrivateOwnedDirectory(
      digestDirectory,
      "Content-addressed Codex runtime directory",
      uid,
    );
    const entries = readdirSync(digestDirectory).sort();
    if (entries.length !== 0 && entries.join("\0") !== "codex") {
      fail(`Content-addressed Codex runtime directory contains unexpected entries: ${digestDirectory}`);
    }
  }

  if (existsSync(finalPath)) {
    const verified = verifyMaterializedCodexRuntime({
      controlRoot: paths.controlRoot,
      sha256: sourceIdentity.sha256,
      uid,
      maxBinaryBytes,
    });
    return Object.freeze({
      path: verified.path,
      sha256: sourceIdentity.sha256,
      version: sourceIdentity.version,
      reused: true,
    });
  }

  const sourceEntry = lstatSync(sourceIdentity.path, { bigint: true });
  if (sourceEntry.isSymbolicLink()) {
    fail(`Reviewed Codex source must not be a symlink: ${sourceIdentity.path}`);
  }
  assertSourceMetadata(sourceEntry, sourceIdentity.path, uid, maxBinaryBytes);
  const requiredBytes = sourceEntry.size + BigInt(freeSpaceReserveBytes);
  if (availableBytes(paths.codexRoot) < requiredBytes) {
    fail("Insufficient free disk space to preserve the reviewed Codex runtime.");
  }

  const temporaryPath = join(
    paths.codexRoot,
    `.install-${process.pid}-${randomBytes(12).toString("hex")}`,
  );
  let temporaryCreated = false;
  let reused = false;
  try {
    copyReviewedSourceToTemporary({
      sourceIdentity,
      temporaryPath,
      uid,
      maxBinaryBytes,
      onDestinationCreated() {
        temporaryCreated = true;
      },
    });
    assertMaterializedRuntime(temporaryPath, sourceIdentity.sha256, uid, maxBinaryBytes);
    if (!existsSync(digestDirectory)) {
      try {
        mkdirSync(digestDirectory, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    assertPrivateOwnedDirectory(
      digestDirectory,
      "Content-addressed Codex runtime directory",
      uid,
    );
    const entriesBeforeLink = readdirSync(digestDirectory).sort();
    if (entriesBeforeLink.length !== 0 && entriesBeforeLink.join("\0") !== "codex") {
      fail(`Content-addressed Codex runtime directory contains unexpected entries: ${digestDirectory}`);
    }
    try {
      linkSync(temporaryPath, finalPath);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      reused = true;
      verifyMaterializedCodexRuntime({
        controlRoot: paths.controlRoot,
        sha256: sourceIdentity.sha256,
        uid,
        maxBinaryBytes,
      });
    }
    fsyncDirectory(digestDirectory);
    fsyncDirectory(paths.codexRoot);
    const verified = verifyMaterializedCodexRuntime({
      controlRoot: paths.controlRoot,
      sha256: sourceIdentity.sha256,
      uid,
      maxBinaryBytes,
    });
    return Object.freeze({
      path: verified.path,
      sha256: sourceIdentity.sha256,
      version: sourceIdentity.version,
      reused,
    });
  } finally {
    if (temporaryCreated && existsSync(temporaryPath)) {
      unlinkSync(temporaryPath);
      fsyncDirectory(paths.codexRoot);
    }
  }
}
