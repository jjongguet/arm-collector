import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as collector from "../packages/collector/public.ts";

// This repository is the public install source extracted from the ARM
// producer. These assertions keep its own advertised contract (version,
// Node floor, documented commands, exported surface) from drifting while the
// producer is still moving. Cross-repository content parity is a separate
// freeze step; it cannot be proven from inside this repository.
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  version: string;
  engines: { node: string };
};
const readme = readFileSync("README.md", "utf8");
const cli = readFileSync("packages/collector/cli.ts", "utf8");

test("the package advertises the collector Node floor and a semantic version", () => {
  assert.equal(pkg.engines.node, ">=24.15");
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.match(readme, /Node ≥ 24\.15/);
  assert.doesNotMatch(readme, /Node ≥ ?22/);
});

test("every documented command exists in the CLI dispatcher", () => {
  const dispatched = new Set(
    Array.from(cli.matchAll(/case "([a-z-]+)"/g), (m) => m[1]),
  );
  for (const command of [
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
  ])
    assert.ok(dispatched.has(command), `CLI dispatches ${command}`);
  // README's "기타 명령" list must stay a subset of the dispatcher.
  for (const documented of ["report", "worker", "rotate", "disconnect"])
    assert.ok(readme.includes(documented), `README documents ${documented}`);
});

test("the exported collector surface matches the parity fixture", () => {
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

// Cross-repository content parity cannot be proven from inside this repository,
// so it is pinned to the newest published receipt instead. t04a/t04b are kept as
// historical snapshots of their own producer commits and are deliberately not
// checked against the current tree; only the current receipt binds to files on
// disk, which is what makes a later drift fail here instead of going unnoticed.
const CURRENT_RECEIPT = "artifacts/source-sync-t05.json";

test("the current sync receipt matches the files in this checkout", () => {
  const receipt = JSON.parse(readFileSync(CURRENT_RECEIPT, "utf8")) as {
    schema: string;
    slice: string;
    producerFreezeSha256: string;
    sourceParity: Record<string, string>;
    finalReceipt: boolean;
  };
  assert.equal(receipt.schema, "collector-sync-slice.v1");
  assert.equal(receipt.slice, "COL-T05");
  assert.equal(receipt.finalReceipt, true);
  const paths = Object.keys(receipt.sourceParity).sort();
  assert.ok(paths.length > 0, "the receipt must name the files it pins");
  for (const path of paths) {
    const actual = createHash("sha256")
      .update(readFileSync(path))
      .digest("hex");
    assert.equal(
      actual,
      receipt.sourceParity[path],
      `${path} drifted from ${CURRENT_RECEIPT}; publish a new receipt instead of editing the old one`,
    );
  }
  const canonical = JSON.stringify(
    Object.fromEntries(paths.map((path) => [path, receipt.sourceParity[path]])),
  );
  assert.equal(
    createHash("sha256").update(canonical).digest("hex"),
    receipt.producerFreezeSha256,
    "producerFreezeSha256 must be the canonical digest of sourceParity",
  );
});
