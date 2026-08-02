import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  assertExactOwnedInstallerFile,
  assertReviewedCodexSourceUnchanged,
  captureReviewedCodexSource,
  materializeReviewedCodexRuntime,
  plannedCodexRuntimePath,
  publishOwnedInstallerFileExclusive,
  verifyMaterializedCodexRuntime,
} from "../scripts/lib/codex-runtime.mjs";

const VERSION = "codex-cli 1.2.3";
const BINARY = `#!/bin/sh\nprintf '%s\\n' '${VERSION}'\n`;

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function reviewedIdentity(path, content = BINARY) {
  return Object.freeze({
    path,
    sha256: sha256(content),
    version: VERSION,
  });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-codex-runtime-test-"));
  const controlRoot = join(root, "control");
  const source = join(root, "codex-source");
  writeFileSync(source, BINARY, { mode: 0o700 });
  chmodSync(source, 0o700);
  return Object.freeze({ root, controlRoot, source, identity: reviewedIdentity(source) });
}

function materialize(input) {
  return materializeReviewedCodexRuntime({
    ...input,
    freeSpaceReserveBytes: 0,
  });
}

test("planned runtime path is pure and content-addressed", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-codex-plan-test-"));
  const controlRoot = join(root, "not-created");
  const digest = "a".repeat(64);
  assert.equal(
    plannedCodexRuntimePath({ controlRoot, sha256: digest }),
    join(controlRoot, "runtimes", "codex", digest, "codex"),
  );
  assert.equal(existsSync(controlRoot), false, "planning must not create Application Support artifacts");
  assert.throws(
    () => plannedCodexRuntimePath({ controlRoot: "relative", sha256: digest }),
    /absolute/,
  );
  assert.throws(
    () => plannedCodexRuntimePath({ controlRoot, sha256: "A".repeat(64) }),
    /64 lowercase/,
  );
});

test("Codex source is safe before execution and unchanged across identity inspection", async (context) => {
  await context.test("stable owner-only executable is accepted and later mutation is detected", async () => {
    const item = await fixture();
    const review = captureReviewedCodexSource({ path: item.source });
    assert.equal(assertReviewedCodexSourceUnchanged({ review }).ino, review.ino);
    writeFileSync(item.source, BINARY.replace("1.2.3", "1.2.4"));
    assert.throws(
      () => assertReviewedCodexSourceUnchanged({ review }),
      /identity changed during inspection/,
    );
  });

  await context.test("group-writable and non-executable candidates are rejected", async () => {
    const item = await fixture();
    chmodSync(item.source, 0o720);
    assert.throws(
      () => captureReviewedCodexSource({ path: item.source }),
      /group\/world writable/,
    );
    chmodSync(item.source, 0o600);
    assert.throws(
      () => captureReviewedCodexSource({ path: item.source }),
      /not owner-executable/,
    );
  });

  await context.test("symlink and wrong-owner candidates are rejected", async () => {
    const item = await fixture();
    const link = join(item.root, "codex-source-link");
    symlinkSync(item.source, link);
    assert.throws(
      () => captureReviewedCodexSource({ path: link }),
      /must not be a symlink/,
    );
    assert.throws(
      () => captureReviewedCodexSource({ path: item.source, uid: process.getuid() + 1 }),
      /owned by another user/,
    );
  });
});

test("install copies reviewed bytes to an owner-only stable executable", async () => {
  const item = await fixture();
  const installed = materialize({
    controlRoot: item.controlRoot,
    sourceIdentity: item.identity,
  });
  assert.deepEqual(installed, {
    path: plannedCodexRuntimePath({
      controlRoot: item.controlRoot,
      sha256: item.identity.sha256,
    }),
    sha256: item.identity.sha256,
    version: VERSION,
    reused: false,
  });
  assert.equal(readFileSync(installed.path, "utf8"), BINARY);
  assert.equal(statSync(installed.path).mode & 0o777, 0o500);
  assert.equal(statSync(item.controlRoot).mode & 0o077, 0);
  assert.equal(statSync(join(item.controlRoot, "runtimes")).mode & 0o077, 0);
  assert.equal(statSync(dirname(installed.path)).mode & 0o077, 0);
  assert.equal(statSync(dirname(dirname(installed.path))).mode & 0o077, 0);
  assert.deepEqual(
    readdirSync(dirname(installed.path)).filter((name) => name.startsWith(".install-")),
    [],
  );
  assert.deepEqual(
    verifyMaterializedCodexRuntime({
      controlRoot: item.controlRoot,
      sha256: item.identity.sha256,
    }),
    {
      path: installed.path,
      sha256: item.identity.sha256,
      size: Buffer.byteLength(BINARY),
    },
  );
});

test("stable runtime survives source-extension removal and same digest is reused", async () => {
  const item = await fixture();
  const first = materialize({
    controlRoot: item.controlRoot,
    sourceIdentity: item.identity,
  });
  const firstStat = statSync(first.path);
  unlinkSync(item.source);
  const second = materialize({
    controlRoot: item.controlRoot,
    sourceIdentity: item.identity,
  });
  const secondStat = statSync(second.path);
  assert.equal(second.reused, true);
  assert.equal(secondStat.ino, firstStat.ino);
  assert.equal(secondStat.mtimeMs, firstStat.mtimeMs);
  const version = spawnSync(second.path, ["--version"], { encoding: "utf8" });
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), VERSION);
});

test("existing wrong or writable runtime is rejected without replacement", async (context) => {
  await context.test("wrong bytes", async () => {
    const item = await fixture();
    const finalPath = plannedCodexRuntimePath({
      controlRoot: item.controlRoot,
      sha256: item.identity.sha256,
    });
    mkdirSync(dirname(finalPath), { mode: 0o700, recursive: true });
    writeFileSync(finalPath, "wrong", { mode: 0o500 });
    chmodSync(finalPath, 0o500);
    assert.throws(
      () => materialize({ controlRoot: item.controlRoot, sourceIdentity: item.identity }),
      /does not match its content-addressed SHA-256/,
    );
    assert.equal(readFileSync(finalPath, "utf8"), "wrong");
  });

  await context.test("owner-writable final file", async () => {
    const item = await fixture();
    const finalPath = plannedCodexRuntimePath({
      controlRoot: item.controlRoot,
      sha256: item.identity.sha256,
    });
    mkdirSync(dirname(finalPath), { mode: 0o700, recursive: true });
    writeFileSync(finalPath, BINARY, { mode: 0o700 });
    chmodSync(finalPath, 0o700);
    assert.throws(
      () => materialize({ controlRoot: item.controlRoot, sourceIdentity: item.identity }),
      /exact 0500/,
    );
    assert.equal(statSync(finalPath).mode & 0o777, 0o700);
  });
});

test("symlink sources and destinations are never followed", async (context) => {
  await context.test("source symlink", async () => {
    const item = await fixture();
    const link = join(item.root, "codex-link");
    symlinkSync(item.source, link);
    const identity = { ...item.identity, path: link };
    assert.throws(
      () => materialize({ controlRoot: item.controlRoot, sourceIdentity: identity }),
      /must not be a symlink/,
    );
    assert.equal(
      existsSync(plannedCodexRuntimePath({
        controlRoot: item.controlRoot,
        sha256: identity.sha256,
      })),
      false,
    );
  });

  await context.test("destination symlink", async () => {
    const item = await fixture();
    const finalPath = plannedCodexRuntimePath({
      controlRoot: item.controlRoot,
      sha256: item.identity.sha256,
    });
    mkdirSync(dirname(finalPath), { mode: 0o700, recursive: true });
    symlinkSync(item.source, finalPath);
    assert.throws(
      () => materialize({ controlRoot: item.controlRoot, sourceIdentity: item.identity }),
      /real regular file/,
    );
    assert.equal(lstatSync(finalPath).isSymbolicLink(), true);
  });
});

test("unapproved source metadata and size are rejected before publication", async (context) => {
  await context.test("group-writable source", async () => {
    const item = await fixture();
    chmodSync(item.source, 0o720);
    assert.throws(
      () => materialize({ controlRoot: item.controlRoot, sourceIdentity: item.identity }),
      /group\/world writable/,
    );
  });

  await context.test("source over configured limit", async () => {
    const item = await fixture();
    assert.throws(
      () => materializeReviewedCodexRuntime({
        controlRoot: item.controlRoot,
        sourceIdentity: item.identity,
        maxBinaryBytes: 4,
        freeSpaceReserveBytes: 0,
      }),
      /outside the allowed range/,
    );
    assert.equal(
      existsSync(plannedCodexRuntimePath({
        controlRoot: item.controlRoot,
        sha256: item.identity.sha256,
      })),
      false,
    );
  });
});

test("digest failure leaves no final or partial temporary runtime", async () => {
  const item = await fixture();
  const unapproved = {
    ...item.identity,
    sha256: "0".repeat(64),
  };
  const finalPath = plannedCodexRuntimePath({
    controlRoot: item.controlRoot,
    sha256: unapproved.sha256,
  });
  assert.throws(
    () => materialize({ controlRoot: item.controlRoot, sourceIdentity: unapproved }),
    /no longer matches the approved SHA-256/,
  );
  assert.equal(existsSync(finalPath), false);
  assert.deepEqual(
    readdirSync(dirname(dirname(finalPath))).filter((name) => name.startsWith(".install-")),
    [],
  );
});

test("post-install mode or content tampering is detected", async () => {
  const item = await fixture();
  const installed = materialize({
    controlRoot: item.controlRoot,
    sourceIdentity: item.identity,
  });
  chmodSync(installed.path, 0o700);
  assert.throws(
    () => verifyMaterializedCodexRuntime({
      controlRoot: item.controlRoot,
      sha256: item.identity.sha256,
    }),
    /exact 0500/,
  );
  writeFileSync(installed.path, `${BINARY}# changed\n`, { mode: 0o500 });
  chmodSync(installed.path, 0o500);
  assert.throws(
    () => verifyMaterializedCodexRuntime({
      controlRoot: item.controlRoot,
      sha256: item.identity.sha256,
    }),
    /does not match its content-addressed SHA-256/,
  );
});

test("exclusive installer-file publication never replaces a raced existing file", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-installer-file-test-"));
  const path = join(root, "schedule.plist");
  const reviewed = "<plist>reviewed</plist>\n";
  const raced = "<plist>raced</plist>\n";
  writeFileSync(path, raced, { mode: 0o644 });
  assert.throws(
    () => publishOwnedInstallerFileExclusive({ path, content: reviewed }),
    /appeared during installation/,
  );
  assert.equal(readFileSync(path, "utf8"), raced);
  assert.deepEqual(
    readdirSync(root).filter((name) => name.includes(".new-")),
    [],
  );
});

test("reviewed installer file is exclusive, exact, and detects later replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-arxiv-installer-file-exact-test-"));
  const path = join(root, "schedule.plist");
  const reviewed = "<plist>reviewed</plist>\n";
  assert.deepEqual(
    publishOwnedInstallerFileExclusive({ path, content: reviewed }),
    { path, size: Buffer.byteLength(reviewed) },
  );
  assert.equal(statSync(path).mode & 0o777, 0o644);
  assert.deepEqual(
    assertExactOwnedInstallerFile({ path, content: reviewed }),
    { path, size: Buffer.byteLength(reviewed) },
  );
  writeFileSync(path, "<plist>changed</plist>\n");
  assert.throws(
    () => assertExactOwnedInstallerFile({ path, content: reviewed }),
    /does not exactly match/,
  );
});
