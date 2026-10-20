import { test } from "node:test";
import assert from "node:assert/strict";
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
      "Collector",
      "approvedOrigin",
      "baseEvent",
      "collectorWorker",
      "createOwnedFixture",
      "isOwnedFixture",
      "observeNodeTest",
      "request",
    ].sort(),
  );
});
