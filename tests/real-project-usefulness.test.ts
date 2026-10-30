import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  ARM_ISOLATED_PROFILE,
  Collector,
  prepareIsolatedSelection,
  runIsolatedNodeTest,
} from "../packages/collector/public.ts";
import type { IsolatedObservation } from "../packages/collector/public.ts";
import {
  approvedTestCommand,
  isolatedClaimEvent,
} from "../packages/adapters/public.ts";
import { eventSchema, judge } from "../packages/core/public.ts";
import type { Evidence } from "../packages/core/public.ts";

const source = process.env.ARM_REAL_PROJECT_ROOT;
const sourceFile = "src/modules/orders/token-estimate.ts";
const originalExpression = "Buffer.byteLength(description, 'utf8')";
const skip =
  process.platform !== "darwin"
    ? "macOS Seatbelt required for measured usefulness"
    : !source
      ? "ARM_REAL_PROJECT_ROOT absent; private ATM source is not shipped"
      : false;

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "arm-usefulness-")));
  chmodSync(root, 0o700);
  const project = join(root, "project");
  mkdirSync(project, { mode: 0o700 });
  for (const { path } of ARM_ISOLATED_PROFILE.files) {
    const target = join(project, path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, readFileSync(join(source!, path)), { mode: 0o600 });
  }
  const collector = new Collector(join(root, "collector"));
  return {
    root,
    project,
    collector,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("fixed isolation-none argv is not silently matched to a default-mode transcript", () => {
  const scope = { root: "/owned", files: ["a.test.ts"], tests: ["a.test.ts"] };
  assert.equal(
    approvedTestCommand(
      "node --test --test-isolation=none --test-concurrency=1 --test-reporter=tap a.test.ts",
      scope,
    ),
    false,
  );
  assert.equal(
    approvedTestCommand("node --test --test-reporter=tap a.test.ts", scope),
    true,
  );
});

test("forged isolated receipt is an unknown claim, never execution authority", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "arm-forgery-")));
  try {
    const collector = new Collector(root);
    const event = isolatedClaimEvent(
      collector,
      { coverage: "isolated", exitCode: 0 } as IsolatedObservation,
      "All tests passed.",
    );
    assert.equal(event.evidence, null);
    assert.equal(judge(event)?.status, "unknown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "pinned real test detects the UTF-8 fault and resolves after restoration",
  { skip },
  async (t) => {
    const f = fixture();
    const file = join(f.project, sourceFile);
    const original = readFileSync(file, "utf8");
    try {
      assert.equal(original.split(originalExpression).length, 2);
      writeFileSync(
        file,
        original.replace(originalExpression, "description.length"),
      );
      const before = await runIsolatedNodeTest(
        f.collector,
        prepareIsolatedSelection(f.collector, f.project),
      );
      assert.equal(before.launched, true, JSON.stringify(before));
      assert.equal(before.tests, 5);
      assert.equal(before.pass, 4);
      assert.equal(before.fail, 1);
      assert.equal(before.skipped, 0);
      assert.equal(before.exitCode, 1);
      assert.equal(before.cleanup.verified, true);
      assert.equal(
        judge(isolatedClaimEvent(f.collector, before, "All tests passed."))
          ?.status,
        "detected",
      );

      // Deterministic regression restoration only. The separate native receipt
      // records a genuine Codex patch proposal; this test does not call a model.
      writeFileSync(file, original);
      assert.equal(
        judge(isolatedClaimEvent(f.collector, before, "All tests passed."))
          ?.status,
        "unknown",
      );
      const after = await runIsolatedNodeTest(
        f.collector,
        prepareIsolatedSelection(f.collector, f.project),
      );
      assert.equal(after.tests, 5);
      assert.equal(after.pass, 5);
      assert.equal(after.exitCode, 0);
      assert.equal(after.loss, false);
      assert.equal(after.cleanup.verified, true);
      assert.notEqual(before.selectionDigest, after.selectionDigest);
      assert.equal(before.testDigest, after.testDigest);
      const event = eventSchema.parse(
        isolatedClaimEvent(f.collector, after, "All tests passed."),
      );
      assert.equal(judge(event)?.status, "resolved");
      assert.equal(
        judge(
          isolatedClaimEvent(f.collector, { ...after }, "All tests passed."),
        )?.status,
        "unknown",
      );

      const evidence = event.evidence!;
      const invalid: Partial<Evidence>[] = [
        { runnerProfile: "NODE_TAP_V1" },
        { commandClass: "approved-node-test" },
        { scopeId: "foreign" },
        { tests: 0 },
        { tests: 6, pass: 6 },
        { tests: 5, pass: 4, skipped: 1 },
        { loss: true },
        { fullOutput: false },
        { before: "a".repeat(64) },
        { claim: null },
        { background: true },
        { completed: false },
        { exitCode: null },
        { coverage: "unproven" },
      ];
      for (const patch of invalid)
        assert.equal(
          judge({ ...event, evidence: { ...evidence, ...patch } })?.status,
          "unknown",
          JSON.stringify(patch),
        );
      assert.equal(judge({ ...event, nodeMajor: 22 })?.status, "unknown");
      assert.equal(
        judge(isolatedClaimEvent(f.collector, after, "Tests will pass."))
          ?.status,
        "unknown",
      );
      assert.equal(JSON.stringify(event).includes(f.root), false);
      assert.equal(JSON.stringify(event).includes(originalExpression), false);

      const now = performance.now.bind(performance);
      t.mock.method(performance, "now", () => now() + 30001);
      assert.equal(
        judge(isolatedClaimEvent(f.collector, after, "All tests passed."))
          ?.status,
        "unknown",
      );
      t.mock.restoreAll();
      f.collector.gap();
      assert.equal(
        judge(isolatedClaimEvent(f.collector, after, "All tests passed."))
          ?.status,
        "unknown",
      );
    } finally {
      t.mock.restoreAll();
      f.close();
    }
  },
);
