import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as collector from "../packages/collector/public.ts";

// The collector is developed only in this repository. These assertions keep
// its user-facing contract (Node floor, documented commands, exported surface)
// from drifting silently; any change here is a deliberate contract change.
const readme = readFileSync("README.md", "utf8");
const cli = readFileSync("packages/collector/cli.ts", "utf8");
// This file also ships in the generated mirror. In this repository the install
// surface is the `mirror/` template; inside the mirror the same assertions apply
// to the shipped package at the root.
const MIRROR_ROOT = existsSync("mirror/package.json") ? "mirror" : ".";
const mirror = JSON.parse(
  readFileSync(`${MIRROR_ROOT}/package.json`, "utf8"),
) as {
  name: string;
  version: string;
  private: boolean;
  engines: { node: string };
  bin: Record<string, string>;
  exports: Record<string, { types: string; default: string }>;
};
const mirrorReadme = readFileSync(`${MIRROR_ROOT}/README.md`, "utf8");
const COMMANDS = [
  "connect",
  "redeem",
  "status",
  "report",
  "flush",
  "worker",
  "rotate",
  "disconnect",
  "setup",
  "receive",
  "codex-fixture",
  "codex-exec",
  "isolated-test",
];

test("the README states the collector Node floor separately from the server", () => {
  assert.match(readme, /collector는 `engines` 기준 Node ≥24\.15가 필요하다/);
  assert.match(readme, /ARM 호스팅 런타임 자체의 요구사항은 Node ≥22/);
});

test("every documented command exists in the CLI dispatcher", () => {
  const dispatched = new Set(
    Array.from(cli.matchAll(/case "([a-z-]+)"/g), (m) => m[1]),
  );
  for (const command of COMMANDS) {
    assert.ok(dispatched.has(command), `CLI dispatches ${command}`);
    assert.ok(readme.includes(`\`${command}`), `README documents ${command}`);
    assert.ok(
      mirrorReadme.includes(`\`${command}`),
      `mirror README documents ${command}`,
    );
  }
});

test("the exported collector surface is pinned", () => {
  assert.deepEqual(
    Object.keys(collector).sort(),
    [
      "ARM_ISOLATED_PROFILE",
      "Collector",
      "ISOLATED_COMMAND_CLASS",
      "ISOLATED_OUTPUT_LIMIT",
      "ISOLATED_PROFILE_ID",
      "ISOLATED_RUNNER_PROFILE",
      "ISOLATED_SCOPE_ID",
      "ISOLATED_TEST_ARGV",
      "ISOLATED_TEST_FILE",
      "ISOLATED_TIMEOUT_MS",
      "IsolatedRefusal",
      "PINNED_NODE_EXECUTABLE",
      "PINNED_NODE_LABEL",
      "SANDBOX_EXEC",
      "approvedOrigin",
      "baseEvent",
      "closeIsolatedSelection",
      "collectorWorker",
      "createOwnedFixture",
      "isCurrentIsolatedObservation",
      "isOwnedFixture",
      "observeNodeTest",
      "prepareIsolatedSelection",
      "request",
      "runIsolatedNodeTest",
    ].sort(),
  );
});

// The mirror package is the install surface (JJO-1174): a git tag install has no
// build step, so every advertised target must be a path this build emits.
test("the mirror package points at paths this build emits", () => {
  assert.equal(mirror.name, "arm-collector");
  assert.equal(mirror.private, false);
  assert.equal(mirror.engines.node, ">=24.15");
  assert.equal(mirror.version, "0.1.0");
  assert.deepEqual(Object.keys(mirror.bin), ["arm-collector"]);
  const bin = mirror.bin["arm-collector"] ?? assert.fail("no bin entry");
  const targets = [
    bin,
    ...Object.values(mirror.exports).flatMap((entry) => [
      entry.types,
      entry.default,
    ]),
  ].map((target) => target.replace(/^\.\//, ""));
  for (const target of targets)
    assert.ok(
      existsSync(resolve(target)),
      `${target} is missing after npm run build:collector`,
    );
  // The SDK contract document describes the development repository; the mirror
  // ships the result, not the contract.
  if (MIRROR_ROOT === "mirror")
    assert.ok(
      existsSync(resolve("docs/sdk.md")),
      "the SDK contract is documented",
    );
});

test("the built CLI keeps its shebang and runs through a symlinked bin", () => {
  const built = "dist/collector/cli.js";
  assert.equal(
    readFileSync(built, "utf8").split("\n")[0],
    "#!/usr/bin/env node",
  );
  assert.equal(cli.split("\n")[0], "#!/usr/bin/env node");
  // npm installs a bin entry as a symlink and Node resolves the main module to
  // its real path, so the entry guard has to survive that indirection instead
  // of silently running nothing.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "arm-sdk-bin-")));
  try {
    const link = join(root, "arm-collector");
    symlinkSync(resolve(built), link);
    const result = spawnSync(
      process.execPath,
      [link, "status", "--dir", join(root, "state")],
      {
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).paired, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
