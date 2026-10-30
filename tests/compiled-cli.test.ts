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
  writeFileSync,
} from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { validateCodexArgs } from "../packages/collector/cli.ts";

const cli = resolve("dist/collector/cli.js");
function invoke(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    timeout: 5000,
    env,
  });
}

// A stand-in `codex` first on PATH records every launch, so a refusal can be
// shown to happen before any provider process starts.
function fakeCodex() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "arm-fake-codex-")));
  const bin = join(root, "bin"),
    project = join(root, "project"),
    marker = join(root, "launches.log");
  mkdirSync(bin);
  mkdirSync(project);
  writeFileSync(join(project, "a.test.js"), "");
  writeFileSync(join(bin, "codex"), `#!/bin/sh\necho "$*" >> '${marker}'\n`);
  chmodSync(join(bin, "codex"), 0o755);
  return {
    project,
    dir: join(root, "state"),
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
    launches: () =>
      existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n") : [],
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("codex-exec refuses incomplete opt-in before launching codex", () => {
  const f = fakeCodex();
  try {
    const scope = ["--scope", "a.test.js", "--tests", "a.test.js"];
    const refused: string[][] = [
      ["--project", f.project, ...scope, "--", "hi"],
      ["--opt-in", ...scope, "--", "hi"],
      ["--opt-in", "--project", f.project, "--tests", "a.test.js", "--", "hi"],
      ["--opt-in", "--project", f.project, "--scope", "a.test.js", "--", "hi"],
      [
        "--opt-in",
        "--project",
        f.project,
        "--scope",
        "a.test.js",
        "--tests",
        "b.test.js",
        "--",
        "hi",
      ],
      ["--opt-in", "--project", f.project, ...scope],
      ["--opt-in", "--project", f.project, ...scope, "--", "-x"],
    ];
    for (const args of refused) {
      const result = invoke(["codex-exec", "--dir", f.dir, ...args], f.env);
      assert.equal(result.status, 1, args.join(" "));
      assert.deepEqual(f.launches(), [], args.join(" "));
    }
    // Positive control: the same stand-in is launched once the opt-in is complete.
    const accepted = invoke(
      [
        "codex-exec",
        "--dir",
        f.dir,
        "--opt-in",
        "--project",
        f.project,
        ...scope,
        "--capability-probe",
        "--",
        "hi",
      ],
      f.env,
    );
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.deepEqual(f.launches(), [
      "--version",
      "exec --ignore-user-config --ephemeral --skip-git-repo-check --sandbox read-only --json hi",
    ]);
    const receipt = JSON.parse(accepted.stdout);
    assert.equal(receipt.coverage, "unproven");
    assert.equal(receipt.versionKnown, false);
  } finally {
    f.close();
  }
});

test("codex-exec accepts exactly one bounded prompt argument", () => {
  for (const args of [[], ["a", "b"], ["-x"], ["a".repeat(32769)]])
    assert.throws(() => validateCodexArgs(args), /one bounded prompt/);
  for (const args of [["a"], ["a".repeat(32768)]])
    assert.deepEqual(validateCodexArgs(args), args);
});

for (const [name, events] of [
  [
    "error and turn.failed",
    [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"turn.started"}',
      '{"type":"error","message":"usage limit"}',
      '{"type":"turn.failed","error":{"message":"usage limit"}}',
    ],
  ],
  [
    "turn.failed alone",
    [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"turn.started"}',
      '{"type":"turn.failed","error":{"message":"usage limit"}}',
    ],
  ],
  [
    "error alone",
    [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"turn.started"}',
      '{"type":"error","message":"usage limit"}',
    ],
  ],
] as [string, string[]][])
  test(`a zero exit code is not read as a passing turn (${name})`, () => {
    // codex-cli 0.159.3 returns exit 0 while emitting `error` / `turn.failed`
    // (observed live on 2026-10-29 when the account hit its usage limit). The
    // wrapper must record a gap, not a clean run.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "arm-exit-zero-")));
    const bin = join(root, "bin"),
      project = join(root, "project"),
      state = join(root, "state");
    mkdirSync(bin);
    mkdirSync(project);
    mkdirSync(state, { mode: 0o700 });
    writeFileSync(join(project, "a.test.js"), "");
    writeFileSync(
      join(bin, "codex"),
      `#!/bin/sh\nif [ "$1" = "exec" ]; then\n${events
        .map((e) => `  echo '${e}'`)
        .join("\n")}\n  exit 0\nfi\necho "codex-cli 0.159.3"\n`,
    );
    chmodSync(join(bin, "codex"), 0o755);
    try {
      const result = invoke(
        [
          "codex-exec",
          "--dir",
          state,
          "--opt-in",
          "--project",
          project,
          "--scope",
          "a.test.js",
          "--tests",
          "a.test.js",
          "--capability-probe",
          "--",
          "reply ok",
        ],
        { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
      );
      assert.equal(result.status, 0, result.stderr);
      const line = result.stdout.trim().split("\n").filter(Boolean).pop();
      assert.ok(line, result.stdout);
      const probe = JSON.parse(line) as Record<string, unknown>;
      assert.equal(probe.processExitCode, 0);
      assert.equal(probe.loss, true);
      assert.equal(probe.coverage, "unproven");
      assert.ok(
        existsSync(join(state, "coverage-gap")),
        "a failed turn must leave a coverage gap",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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
