import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  chmodSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Collector } from "../packages/collector/public.ts";
import { runCodex } from "../packages/collector/cli.ts";

const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "arm-codex-tamper-")));
  chmodSync(root, 0o700);
  const source = join(root, "src.ts");
  const spec = join(root, "src.test.ts");
  writeFileSync(source, "export const value = 1;\n");
  writeFileSync(spec, "// selected test\n");
  const collector = new Collector(join(root, "state"));
  return {
    root,
    source,
    spec,
    collector,
    scope: { root, files: ["src.ts", "src.test.ts"], tests: ["src.test.ts"] },
    close: () => rmSync(root, { recursive: true, force: true }),
  };
};

/** Fake codex transport: version query, then an exec that may mutate a file. */
const launcher = (mutate: (() => void) | null) => {
  let call = 0;
  return ((_command: string, argv: string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    const index = call++;
    process.nextTick(() => {
      if (index === 0) {
        child.stdout.write("codex-cli 0.159.3\n");
        child.emit("close", 0);
        return;
      }
      assert.ok(argv.includes("read-only"));
      mutate?.();
      child.emit("close", 0);
    });
    return child;
  }) as never;
};

test("a run that leaves the opted-in scope untouched keeps equal digests and unproven coverage", async () => {
  const f = fixture();
  const log = console.log;
  try {
    console.log = () => {};
    const result = await runCodex(
      f.collector,
      f.scope,
      ["report without changing files"],
      true,
      launcher(null),
    );
    assert.equal(result.digest.changed, false);
    assert.equal(result.digest.before, result.digest.after);
    assert.ok(result.digest.before);
    assert.match(result.digest.before, /^[a-f0-9]{64}$/);
    assert.equal(result.coverage, "unproven");
    assert.match(result.coverageReason, /child-process isolation/);
    // Untouched scope is not a gap: the wrapper observed the same bytes.
    assert.equal(f.collector.report().coverage, "observed-metadata-only");
  } finally {
    console.log = log;
    f.close();
  }
});

test("a run that changes the scope is reported as changed, records a gap and still says unproven", async () => {
  const f = fixture();
  const log = console.log;
  try {
    console.log = () => {};
    const result = await runCodex(
      f.collector,
      f.scope,
      ["apply a patch"],
      true,
      launcher(() => writeFileSync(f.source, "export const value = 2;\n")),
    );
    assert.equal(result.digest.changed, true);
    assert.notEqual(result.digest.before, result.digest.after);
    assert.equal(result.coverage, "unproven");
    assert.match(result.coverageReason, /scope changed during the run/);
    // The evidence itself proves the scope moved; a later pass cannot clear it.
    assert.equal(f.collector.report().coverage, "unknown");
    assert.equal(readFileSync(f.source, "utf8").includes("value = 2"), true);
  } finally {
    console.log = log;
    f.close();
  }
});

test("the version probe records no digest claim and an unknown binary stays lossy", async () => {
  const f = fixture();
  const log = console.log;
  try {
    console.log = () => {};
    const unknown = ((_command: string) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        kill: () => boolean;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      process.nextTick(() => child.emit("error", Error("codex missing")));
      return child;
    }) as never;
    const result = await runCodex(
      f.collector,
      f.scope,
      ["report"],
      true,
      unknown,
    );
    assert.equal(result.versionKnown, false);
    assert.equal(result.loss, true);
    assert.equal(result.coverage, "unproven");
    assert.equal(f.collector.report().coverage, "unknown");
  } finally {
    console.log = log;
    f.close();
  }
});
