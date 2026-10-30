import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  ARM_ISOLATED_PROFILE,
  Collector,
  IsolatedRefusal,
  closeIsolatedSelection,
  isCurrentIsolatedObservation,
  prepareIsolatedSelection,
  runIsolatedNodeTest,
} from "../packages/collector/public.ts";
import type { IsolatedSelection } from "../packages/collector/public.ts";

// Private ATM source is deliberately not vendored into the public collector.
// The parent supplies its explicitly owned, verified worktree for host gates.
const source = process.env.ARM_REAL_PROJECT_ROOT;
const real = {
  skip: source
    ? false
    : "ARM_REAL_PROJECT_ROOT is absent; pinned private ATM closure not supplied",
};

test("isolated CLI rejects extra flags and missing explicit opt-in", () => {
  const f = fixture(false);
  try {
    for (const extra of [
      [],
      ["--opt-in", "--eval", "ignored"],
      ["--opt-in", "--opt-in"],
    ]) {
      const result = spawnSync(
        process.execPath,
        [
          new URL("../packages/collector/cli.ts", import.meta.url).pathname,
          "isolated-test",
          "--dir",
          join(f.root, "state"),
          "--project",
          f.project,
          ...extra,
        ],
        { encoding: "utf8", timeout: 5000 },
      );
      assert.equal(result.status, 1);
      assert.equal(result.stdout.includes('"launched":true'), false);
    }
  } finally {
    f.close();
  }
});
function fixture(copy = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "arm-isolated-test-")));
  chmodSync(root, 0o700);
  const project = join(root, "project");
  mkdirSync(project, { mode: 0o700 });
  if (copy) {
    assert.ok(source);
    for (const { path } of ARM_ISOLATED_PROFILE.files) {
      const file = join(project, path);
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, readFileSync(join(source, path)), { mode: 0o600 });
    }
  }
  const collector = new Collector(join(root, "state"));
  return {
    root,
    project,
    collector,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("forged selections never launch or remove foreign files", async () => {
  const f = fixture(false);
  try {
    const result = await runIsolatedNodeTest(f.collector, {
      sourceRoot: f.project,
    } as IsolatedSelection);
    assert.equal(result.refusedReason, "unowned-selection");
    assert.equal(result.launched, false);
    assert.equal(result.cleanup.verified, false);
    assert.equal(isCurrentIsolatedObservation(f.collector, result), false);
    assert.ok(existsSync(f.project));
  } finally {
    f.close();
  }
});

test("symlink roots and arbitrary non-profile projects are refused before launch", () => {
  const f = fixture(false);
  try {
    const link = join(f.root, "link");
    symlinkSync(f.project, link);
    assert.throws(
      () => prepareIsolatedSelection(f.collector, link),
      (e) => e instanceof IsolatedRefusal && e.code === "root-symlink",
    );
    assert.throws(
      () => prepareIsolatedSelection(f.collector, f.project),
      (e) => e instanceof IsolatedRefusal && e.code === "manifest-missing",
    );
  } finally {
    f.close();
  }
});

for (const kind of ["source", "snapshot", "manifest"] as const) {
  test(
    `changed ${kind} bytes refuse launch and clean the owned snapshot`,
    real,
    async () => {
      const f = fixture();
      const selection = prepareIsolatedSelection(f.collector, f.project);
      try {
        const file =
          kind === "manifest"
            ? selection.manifestPath
            : join(
                kind === "source" ? f.project : selection.sealedRoot,
                ARM_ISOLATED_PROFILE.test,
              );
        chmodSync(file, 0o600);
        writeFileSync(file, "changed");
        const result = await runIsolatedNodeTest(f.collector, selection);
        assert.equal(result.launched, false);
        assert.equal(
          result.refusedReason,
          kind === "source" ? "source-changed" : "sealed-manifest-changed",
        );
        assert.equal(result.cleanup.verified, true);
        assert.equal(existsSync(selection.sealedRoot), false);
      } finally {
        closeIsolatedSelection(selection);
        f.close();
      }
    },
  );
}

test(
  "foreign collectors and copied handles cannot consume an owned selection",
  real,
  async () => {
    const f = fixture();
    const foreign = fixture(false);
    const selection = prepareIsolatedSelection(f.collector, f.project);
    try {
      for (const [collector, handle] of [
        [foreign.collector, selection],
        [f.collector, { ...selection }],
      ] as const) {
        const result = await runIsolatedNodeTest(collector, handle);
        assert.equal(result.refusedReason, "unowned-selection");
        assert.equal(result.launched, false);
        assert.ok(existsSync(selection.sealedRoot));
      }
    } finally {
      closeIsolatedSelection(selection);
      f.close();
      foreign.close();
    }
  },
);

test(
  "pre-abort cleans without launching and invalid timeout is rejected",
  real,
  async () => {
    const f = fixture();
    const selection = prepareIsolatedSelection(f.collector, f.project);
    try {
      await assert.rejects(
        runIsolatedNodeTest(f.collector, selection, { timeoutMs: 0 }),
        IsolatedRefusal,
      );
      const result = await runIsolatedNodeTest(f.collector, selection, {
        signal: AbortSignal.abort(),
      });
      assert.equal(result.refusedReason, "aborted");
      assert.equal(result.launched, false);
      assert.equal(result.cleanup.verified, true);
    } finally {
      closeIsolatedSelection(selection);
      f.close();
    }
  },
);

test(
  "actual fixed invocation runs all five tests, denies canaries, and binds live source",
  real,
  async () => {
    const f = fixture();
    const selection = prepareIsolatedSelection(f.collector, f.project);
    try {
      const result = await runIsolatedNodeTest(f.collector, selection);
      if (process.platform !== "darwin") {
        assert.equal(result.refusedReason, "unsupported-platform");
        assert.equal(result.launched, false);
        assert.equal(result.cleanup.verified, true);
        return;
      }
      assert.equal(result.refusedReason, null, JSON.stringify(result));
      assert.equal(result.exitCode, 0);
      assert.equal(result.tests, 5);
      assert.equal(result.pass, 5);
      assert.equal(
        result.fail + result.skipped + result.cancelled + result.todo,
        0,
      );
      assert.equal(result.fullOutput, true);
      assert.equal(result.loss, false);
      assert.equal(result.cleanup.verified, true);
      assert.equal(existsSync(selection.sealedRoot), false);
      assert.deepEqual(
        result.canaries.map(({ outcome }) => outcome),
        ["control-ok", "denied", "denied", "denied", "denied"],
      );
      assert.equal(isCurrentIsolatedObservation(f.collector, result), true);
      assert.equal(
        isCurrentIsolatedObservation(f.collector, { ...result }),
        false,
      );
      assert.equal(JSON.stringify(result).includes(f.root), false);
      writeFileSync(join(f.project, ARM_ISOLATED_PROFILE.test), "changed");
      assert.equal(isCurrentIsolatedObservation(f.collector, result), false);
    } finally {
      closeIsolatedSelection(selection);
      f.close();
    }
  },
);

test(
  "concurrent use and mid-canary cancellation do not orphan an owned child",
  real,
  async () => {
    const f = fixture();
    const selection = prepareIsolatedSelection(f.collector, f.project);
    try {
      const controller = new AbortController();
      const pending = runIsolatedNodeTest(f.collector, selection, {
        signal: controller.signal,
      });
      const concurrent = await runIsolatedNodeTest(f.collector, selection);
      assert.equal(concurrent.refusedReason, "unowned-selection");
      assert.equal(closeIsolatedSelection(selection).reason, "running");
      controller.abort();
      const result = await pending;
      assert.equal(result.refusedReason, "aborted");
      assert.equal(result.cleanup.verified, true);
    } finally {
      closeIsolatedSelection(selection);
      f.close();
    }
  },
);
