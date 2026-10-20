import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const cli = resolve("dist/collector/cli.js");
function invoke(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    timeout: 5000,
  });
}

test("the emitted CLI reports unpaired state without a network client", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "arm-built-status-")));
  try {
    const result = invoke(["status", "--dir", dir]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).paired, false);
    const denied = invoke(["isolated-test", "--dir", dir, "--project", dir]);
    assert.equal(denied.status, 1);
    assert.equal(denied.stdout.includes('"launched":true'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compiled setup registers its actual JavaScript entrypoint, never a missing TS file", () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "arm built hooks ")));
  try {
    const result = invoke([
      "setup",
      "--host",
      "claude-code",
      "--project",
      project,
      "--dir",
      join(project, "state"),
      "--apply",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const settings = readFileSync(
      join(project, ".claude/settings.local.json"),
      "utf8",
    );
    assert.ok(settings.includes(cli), settings);
    assert.equal(settings.includes("dist/collector/cli.ts"), false);
    const uninstall = invoke([
      "setup",
      "--host",
      "claude-code",
      "--project",
      project,
      "--dir",
      join(project, "state"),
      "--uninstall",
      "--apply",
    ]);
    assert.equal(uninstall.status, 0, uninstall.stderr);
    assert.equal(
      readFileSync(
        join(project, ".claude/settings.local.json"),
        "utf8",
      ).includes("arm-owned-v1"),
      false,
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
