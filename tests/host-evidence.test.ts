import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  Collector,
  createOwnedFixture,
  collectorWorker,
  baseEvent,
} from "../packages/collector/public.ts";
import {
  hostContext,
  normalizeHost,
  approvedTestCommand,
  claudeSetup,
} from "../packages/adapters/public.ts";
import { validateCodexArgs, runCodex } from "../packages/collector/cli.ts";
import { judge, eventSchema } from "../packages/core/public.ts";
const encoded = (event: unknown) => JSON.stringify(eventSchema.parse(event));
const tap = (fail = 1) =>
  `TAP version 13\n${fail ? "not ok" : "ok"} 1 - owned\n1..1\n# tests 1\n# pass ${1 - fail}\n# fail ${fail}\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 12.1\n`;
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "arm-host-test-")));
  const collector = new Collector(join(root, "state"));
  const owned = createOwnedFixture();
  const context = hostContext(owned.scope, "0.159.3", "owned-run");
  const command = `/bin/zsh -lc '${process.execPath} --test --test-reporter=tap ${resolve(owned.scope.root, owned.scope.tests[0]!)}'`;
  const send = (
    type: string,
    item: Record<string, unknown>,
    sequence: number,
  ) => normalizeHost({ type, item }, "codex", collector, sequence, context);
  const start = (id = "cmd") =>
    send("item.started", { type: "command_execution", id, command }, 0);
  const complete = (extra = {}, id = "cmd") =>
    send(
      "item.completed",
      {
        type: "command_execution",
        id,
        command,
        status: "completed",
        exit_code: 1,
        aggregated_output: tap(),
        ...extra,
      },
      1,
    );
  const claim = (text = "All tests passed.", sequence = 2) =>
    send(
      "item.completed",
      { type: "agent_message", id: "message", text },
      sequence,
    )!;
  return {
    root,
    collector,
    owned,
    context,
    command,
    send,
    start,
    complete,
    claim,
    close() {
      owned.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test("correlated owned command contradicts claim; fresh passing completion resolves", () => {
  const f = fixture();
  try {
    f.start();
    f.complete();
    const event = f.claim();
    assert.equal(judge(event)?.status, "detected");
    assert.equal(event.hostVersion, "0.159.3");
    assert.notEqual(event.toolCallId, "tool");
    f.start("fixed");
    f.complete({ exit_code: 0, aggregated_output: tap(0) }, "fixed");
    assert.equal(judge(f.claim())?.status, "resolved");
    assert.equal(judge(f.claim())?.status, "unknown");
  } finally {
    f.close();
  }
});
test(
  "collector failures name a real next action without echoing paths or payloads",
  { timeout: 20000 },
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "arm-cli-hint-")));
    const link = join(root, "linked-state");
    symlinkSync(join(root, "real-state"), link);
    mkdirSync(join(root, "real-state"), { mode: 0o700 });
    try {
      const cli = new URL("../packages/collector/cli.ts", import.meta.url)
        .pathname;
      const run = (args: string[]) =>
        new Promise<{ code: number | null; stderr: string }>((done, fail) => {
          const child = spawn(process.execPath, [cli, ...args], {
            stdio: ["ignore", "ignore", "pipe"],
          });
          let stderr = "";
          child.stderr.on("data", (chunk) => {
            stderr += String(chunk);
          });
          child.once("close", (code) => done({ code, stderr }));
          child.once("error", fail);
        });
      const symlinked = await run([
        "connect",
        "--origin",
        "http://127.0.0.1:9",
        "--approve-origin",
        "--dir",
        link,
      ]);
      assert.equal(symlinked.code, 1);
      assert.match(symlinked.stderr, /resolves through a symlink/);
      assert.doesNotMatch(symlinked.stderr, new RegExp(root));
      const unreachable = await run([
        "connect",
        "--origin",
        "http://127.0.0.1:9",
        "--approve-origin",
        "--dir",
        join(root, "real-state"),
      ]);
      assert.equal(unreachable.code, 1);
      assert.doesNotMatch(
        unreachable.stderr,
        /8[0-9]{3}|localhost|ECONNREFUSED/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "async hook receiver terminates incomplete stdin and persists coverage loss",
  { timeout: 8000 },
  async () => {
    const f = fixture();
    const child = spawn(
      process.execPath,
      [
        new URL("../packages/collector/cli.ts", import.meta.url).pathname,
        "receive",
        "--host",
        "claude-code",
        "--dir",
        f.collector.dir,
      ],
      { stdio: ["pipe", "ignore", "ignore"] },
    );
    const timeout = setTimeout(() => child.kill("SIGKILL"), 6500);
    try {
      child.stdin.write("{");
      const code = await new Promise<number | null>((done, fail) => {
        child.once("close", done);
        child.once("error", fail);
      });
      assert.equal(code, 0);
      assert.equal(new Collector(f.collector.dir).hasGap(), true);
    } finally {
      clearTimeout(timeout);
      child.kill("SIGKILL");
      f.close();
    }
  },
);
for (const exit of [1, 0, null]) {
  test(`terminal failed command status with exit ${exit} remains conservative`, () => {
    const f = fixture();
    try {
      f.start();
      f.complete({
        status: "failed",
        exit_code: exit,
        aggregated_output: tap(exit === 0 ? 0 : 1),
      });
      const claim = f.claim();
      assert.equal(claim.evidence?.background, false);
      assert.equal(claim.evidence?.exitCode, exit);
      assert.equal(judge(claim)?.status, exit === 1 ? "detected" : "unknown");
    } finally {
      f.close();
    }
  });
}
for (const mode of [
  "missing-start-id",
  "missing-complete-id",
  "empty-id",
  "unknown-item",
  "missing-item",
  "updated-command",
  "turn-failed",
] as const) {
  test(`later ${mode} span cannot reuse earlier passing evidence`, () => {
    const f = fixture();
    try {
      f.start();
      f.complete({ exit_code: 0, aggregated_output: tap(0) });
      assert.ok(f.context.latest);
      if (mode === "missing-start-id")
        f.send(
          "item.started",
          { type: "command_execution", command: f.command },
          2,
        );
      else if (mode === "missing-complete-id" || mode === "empty-id") {
        const error = f.send(
          "item.completed",
          {
            type: "command_execution",
            ...(mode === "empty-id" ? { id: "" } : {}),
            command: f.command,
            status: "completed",
            exit_code: 1,
            aggregated_output: tap(),
          },
          2,
        );
        assert.equal(error?.kind, "error");
      } else if (mode === "unknown-item")
        f.send(
          "item.completed",
          { type: "unsupported_tool", id: "unknown" },
          2,
        );
      else if (mode === "updated-command")
        f.send(
          "item.updated",
          { type: "command_execution", id: "later", command: f.command },
          2,
        );
      else
        normalizeHost(
          { type: mode === "turn-failed" ? "turn.failed" : "item.completed" },
          "codex",
          f.collector,
          2,
          f.context,
        );
      assert.equal(f.context.latest, null);
      const claim = f.claim("All tests passed.", 3);
      assert.equal(claim.evidence, null);
      assert.equal(judge(claim)?.status, "unknown");
      assert.equal(f.collector.report().coverage, "unknown");
      // Loss persists even if a later identified command completes normally.
      f.start("fresh");
      f.complete({ exit_code: 0, aggregated_output: tap(0) }, "fresh");
      assert.equal(f.claim().evidence?.loss, true);
      assert.ok(f.collector.pendingGap());
    } finally {
      f.close();
    }
  });
}
for (const mode of [
  "missing",
  "wrong-id",
  "background",
  "truncated",
  "missing-exit",
  "duplicate",
  "stale",
  "turn",
  "version",
  "sequence",
] as const) {
  test(`insufficient ${mode} host evidence stays unknown`, () => {
    const f = fixture();
    try {
      if (mode === "version") f.context.loss = true;
      if (mode !== "missing") f.start();
      const extra =
        mode === "background"
          ? { status: "in_progress" }
          : mode === "truncated"
            ? { aggregated_output: tap().slice(0, -10) }
            : mode === "missing-exit"
              ? { exit_code: null }
              : {};
      f.complete(extra, mode === "wrong-id" ? "different" : "cmd");
      if (mode === "duplicate") f.complete();
      if (mode === "stale") {
        chmodSync(join(f.owned.scope.root, "fixture.test.cjs"), 0o600);
        writeFileSync(join(f.owned.scope.root, "fixture.test.cjs"), "changed");
      }
      if (mode === "turn")
        normalizeHost(
          { type: "turn.started" },
          "codex",
          f.collector,
          2,
          f.context,
        );
      assert.equal(
        judge(f.claim("All tests passed.", mode === "sequence" ? 1 : 2))
          ?.status,
        "unknown",
      );
    } finally {
      f.close();
    }
  });
}
test("negation and non-owned scope cannot manufacture isolation", () => {
  const f = fixture();
  try {
    f.start();
    f.complete();
    assert.equal(judge(f.claim("Tests did not pass."))?.status, "unknown");
    f.context.scope = { ...f.owned.scope };
    f.start("other");
    f.complete({}, "other");
    assert.equal(f.claim().evidence?.coverage, "unproven");
  } finally {
    f.close();
  }
});
test("exact transport parser rejects composition, redirects, extra options and background", () => {
  const f = fixture();
  try {
    assert.equal(approvedTestCommand(f.command, f.owned.scope), true);
    for (const suffix of [
      " &",
      " && echo ok",
      " | tee raw",
      " > raw",
      "; node evil",
      " --watch",
    ])
      assert.equal(
        approvedTestCommand(
          f.command.slice(0, -1) + suffix + "'",
          f.owned.scope,
        ),
        false,
      );
    assert.equal(
      approvedTestCommand(
        "node --test --test-reporter=tap missing.cjs",
        f.owned.scope,
      ),
      false,
    );
  } finally {
    f.close();
  }
});
test("D2 repetitions use cause and progress HMAC, never raw payload", () => {
  const f = fixture();
  try {
    const events = [0, 1, 2].map((sequence) =>
      f.send(
        "item.completed",
        {
          id: `error-${sequence}`,
          type: "command_execution",
          command: "node broken.cjs",
          exit_code: 1,
          aggregated_output: `Error: CANARY /private/customer\n# duration_ms ${sequence}`,
        },
        sequence,
      )!,
    );
    assert.equal(judge(events[2]!, events.slice(0, 2))?.status, "suspected");
    for (const event of events) f.collector.enqueue(event);
    const disk = readFileSync(join(f.collector.dir, "spool.json"), "utf8");
    assert.ok(!disk.includes("CANARY"));
    assert.ok(!disk.includes("/private/"));
    assert.ok(!JSON.stringify(f.collector.report()).includes("customer"));
  } finally {
    f.close();
  }
});
test("native Claude has unknown numeric exit and only bounded test filenames are edits", () => {
  const f = fixture();
  try {
    assert.equal(
      normalizeHost(
        {
          hook_event_name: "PostToolUse",
          tool_name: "Write",
          tool_input: { file_path: "/repo/tests/application.js" },
        },
        "claude-code",
        f.collector,
        0,
      ),
      null,
    );
    assert.equal(
      normalizeHost(
        {
          hook_event_name: "PostToolUse",
          tool_name: "Edit",
          tool_input: { file_path: "/repo/unit.test.ts" },
        },
        "claude-code",
        f.collector,
        0,
      )?.kind,
      "test-edit",
    );
    const claim = normalizeHost(
      {
        hook_event_name: "Stop",
        session_id: "CANARY",
        last_assistant_message: "All tests passed.",
        tool_response: { stdout: tap(0), interrupted: false },
      },
      "claude-code",
      f.collector,
      1,
    )!;
    assert.equal(claim.evidence, null);
    assert.equal(claim.hostVersion, "0.0.0");
    assert.equal(judge(claim)?.status, "unknown");
  } finally {
    f.close();
  }
});
test("all output and privacy override flag forms are forbidden", () => {
  for (const flag of [
    "-o",
    "-ofile",
    "--output-last-message",
    "--output-last-message=file",
    "--config=x",
    "-c",
    "--resume",
    "--sandbox=workspace-write",
    "--enable=feature",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--cd=/tmp",
  ]) {
    assert.throws(() => validateCodexArgs([flag]));
    assert.throws(() => validateCodexArgs(["prompt", flag]));
  }
  assert.deepEqual(validateCodexArgs(["bounded prompt"]), ["bounded prompt"]);
});
test("mocked child failure settles, reports only metadata and preserves config", async () => {
  const f = fixture();
  const log = console.log;
  try {
    mkdirSync(join(f.root, ".claude"), { mode: 0o700 });
    const config = join(f.root, ".claude", "settings.local.json");
    writeFileSync(
      config,
      JSON.stringify({ permissions: { allow: ["Read"] } }),
      { mode: 0o600 },
    );
    claudeSetup(f.root, f.collector.dir, "/owned/cli.ts", true);
    const before = readFileSync(config, "utf8");
    let count = 0;
    const launch = ((_command: string, argv: string[]) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        kill: () => boolean;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      const index = count++;
      process.nextTick(() => {
        if (index === 0) {
          child.stdout.write("codex-cli 0.159.3\n");
          child.emit("close", 0);
        } else {
          assert.ok(argv.includes("--ignore-user-config"));
          assert.ok(argv.includes("read-only"));
          child.emit("error", Error("CANARY-provider-failure"));
        }
      });
      return child;
    }) as unknown as typeof spawn;
    const logs: string[] = [];
    console.log = (value) => {
      logs.push(String(value));
    };
    const result = await runCodex(
      f.collector,
      f.owned.scope,
      ["safe fixture prompt"],
      true,
      launch,
    );
    assert.equal(result.processExitCode, null);
    assert.equal(result.hostVersion, "0.159.3");
    assert.ok(!logs.join("").includes("CANARY"));
    assert.equal(readFileSync(config, "utf8"), before);
    assert.equal(f.collector.report().coverage, "unknown");
  } finally {
    console.log = log;
    f.close();
  }
});
test("explicit worker stops promptly on cancellation with no later flush", async () => {
  const f = fixture();
  try {
    const controller = new AbortController();
    let calls = 0;
    f.collector.flush = async (signal) => {
      calls++;
      assert.equal(signal, controller.signal);
      controller.abort();
    };
    await collectorWorker(f.collector, controller.signal, 100);
    assert.equal(calls, 1);
    await collectorWorker(f.collector, controller.signal, 100);
    assert.equal(calls, 1);
  } finally {
    f.close();
  }
});
test("mocked wrapper correlates streamed child events without persisting raw canaries", async () => {
  const f = fixture(),
    log = console.log;
  try {
    let calls = 0;
    const launch = (() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        kill: () => boolean;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      const index = calls++;
      process.nextTick(() => {
        if (index === 0) child.stdout.write("codex-cli 0.159.3\n");
        else {
          const item = {
            type: "command_execution",
            id: "command-canary",
            command: f.command,
          };
          const rows = [
            { type: "item.started", item },
            {
              type: "item.completed",
              item: {
                ...item,
                status: "completed",
                exit_code: 1,
                aggregated_output: tap().replace("owned", "CANARY-RAW-SOURCE"),
              },
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                id: "claim-canary",
                text: "All tests passed.",
              },
              prompt: "CANARY-RAW-PROMPT",
            },
          ];
          const text = rows.map((row) => JSON.stringify(row) + "\n").join("");
          child.stdout.write(text.slice(0, 37));
          child.stdout.write(text.slice(37));
        }
        child.emit("close", 0);
      });
      return child;
    }) as unknown as typeof spawn;
    const logs: string[] = [];
    console.log = (value) => {
      logs.push(String(value));
    };
    const result = await runCodex(
      f.collector,
      f.owned.scope,
      ["safe prompt"],
      true,
      launch,
    );
    assert.equal(result.events, 2);
    assert.equal(result.loss, false);
    assert.equal(f.collector.report().findings.at(-1)?.status, "detected");
    const disk = readFileSync(join(f.collector.dir, "spool.json"), "utf8");
    assert.ok(!disk.includes("CANARY"));
    assert.ok(!disk.includes(f.owned.scope.root));
    assert.ok(!logs.join("").includes("CANARY"));
  } finally {
    console.log = log;
    f.close();
  }
});
test("hook sequences remain bounded and monotonic across receive instances", () => {
  const f = fixture();
  try {
    const id = "a".repeat(64);
    assert.equal(f.collector.nextSequence(id), 0);
    assert.equal(new Collector(f.collector.dir).nextSequence(id), 1);
    writeFileSync(
      join(f.collector.dir, "sequences.json"),
      JSON.stringify({ [id]: { sequence: 1000000, lastSeen: Date.now() } }),
      { mode: 0o600 },
    );
    assert.throws(() => f.collector.nextSequence(id));
  } finally {
    f.close();
  }
});
test("expired queued metadata is counted as loss even while unpaired", async () => {
  const f = fixture();
  try {
    const event = normalizeHost(
      {
        hook_event_name: "Stop",
        session_id: "expiry",
        last_assistant_message: "All tests passed.",
      },
      "claude-code",
      f.collector,
      0,
    )!;
    event.time = Date.now() - 8 * 86400000;
    assert.equal(f.collector.enqueue(event), true);
    await f.collector.flush();
    assert.equal(f.collector.report().queued, 0);
    assert.equal(f.collector.report().lost, 1);
    assert.equal(f.collector.report().coverage, "unknown");
  } finally {
    f.close();
  }
});
function pairForDelivery(collector: Collector) {
  collector.configure({
    origin: "https://monitor.example",
    token: "a".repeat(43),
    deviceId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    expires: Date.now() + 86400000,
  });
}
test("overflow gap survives restart and delivery retries preserve attempted payload bytes", async () => {
  const f = fixture(),
    original = globalThis.fetch;
  try {
    pairForDelivery(f.collector);
    f.start();
    f.complete({ exit_code: 0, aggregated_output: tap(0) });
    const claim = f.claim();
    assert.equal(f.collector.enqueue(claim), true);
    const attempted = new Map<string, string>();
    let fail = true;
    globalThis.fetch = async (_url, options) => {
      const batch = JSON.parse(String(options?.body)).events;
      for (const event of batch) {
        const bytes = JSON.stringify(event);
        if (attempted.has(event.eventId))
          assert.equal(bytes, attempted.get(event.eventId));
        else attempted.set(event.eventId, bytes);
      }
      if (fail) throw Error("offline");
      return new Response("{}", { status: 200 });
    };
    await f.collector.flush();
    for (let i = 1; i < 500; i++)
      f.collector.enqueue(baseEvent("fixture", "fill", i));
    assert.equal(
      f.collector.enqueue(baseEvent("fixture", "overflow", 0)),
      false,
    );
    const restarted = new Collector(f.collector.dir);
    const spoolPath = join(f.collector.dir, "spool.json");
    const spool = JSON.parse(readFileSync(spoolPath, "utf8"));
    spool.retryAt = 0;
    writeFileSync(spoolPath, JSON.stringify(spool), { mode: 0o600 });
    await restarted.flush();
    const health = JSON.parse(
      readFileSync(join(f.collector.dir, "health-gap.json"), "utf8"),
    );
    assert.equal(health.event.kind, "health");
    assert.equal(health.acknowledgedAt, 0);
    const second = JSON.parse(readFileSync(spoolPath, "utf8"));
    second.retryAt = 0;
    writeFileSync(spoolPath, JSON.stringify(second), { mode: 0o600 });
    fail = false;
    await restarted.flush();
    assert.equal(attempted.get(claim.eventId), encoded(claim));
    assert.equal(attempted.get(health.event.eventId), encoded(health.event));
    assert.equal(restarted.report().coverage, "unknown");
    f.context.latest = null;
    f.start("new");
    f.complete({ exit_code: 0, aggregated_output: tap(0) }, "new");
    assert.equal(f.claim().evidence?.loss, true);
    assert.equal(
      encoded(
        f.collector.spool().events.find((e) => e.eventId === claim.eventId) ??
          claim,
      ),
      encoded(claim),
    );
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});
test("write-loss marker with empty spool is uploaded by restarted explicit worker", async () => {
  const f = fixture(),
    original = globalThis.fetch;
  try {
    pairForDelivery(f.collector);
    const lock = join(f.collector.dir, "spool.lock");
    writeFileSync(lock, "owned-test-lock", { mode: 0o600 });
    assert.equal(f.collector.enqueue(baseEvent("fixture", "lost", 0)), false);
    unlinkSync(lock);
    const restarted = new Collector(f.collector.dir),
      controller = new AbortController();
    const received: unknown[] = [];
    globalThis.fetch = async (_url, options) => {
      const batch = JSON.parse(String(options?.body));
      received.push(...batch.events);
      controller.abort();
      return new Response("{}", { status: 200 });
    };
    assert.equal(restarted.report().queued, 0);
    await collectorWorker(restarted, controller.signal, 100);
    assert.equal(received.length, 1);
    assert.equal((received[0] as { kind: string }).kind, "health");
    assert.equal(restarted.report().coverage, "unknown");
    assert.ok(
      restarted
        .report()
        .findings.some((finding) => finding?.status === "unknown"),
    );
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});
test("offline restarted report never resolves expired passing metadata or mutates its retry payload", () => {
  const f = fixture();
  try {
    f.start();
    f.complete({ exit_code: 0, aggregated_output: tap(0) });
    const event = f.claim();
    event.time = Date.now() - 8 * 86400000;
    f.collector.enqueue(event);
    const before = readFileSync(join(f.collector.dir, "spool.json"), "utf8");
    const report = new Collector(f.collector.dir).report();
    assert.equal(report.coverage, "unknown");
    assert.equal(report.lost, 1);
    assert.ok(
      !report.findings.some((finding) => finding?.status === "resolved"),
    );
    assert.ok(
      report.findings.some((finding) => finding?.reason.includes("expired")),
    );
    assert.equal(
      readFileSync(join(f.collector.dir, "spool.json"), "utf8"),
      before,
    );
    assert.equal(JSON.stringify(f.collector.spool().events[0]), encoded(event));
  } finally {
    f.close();
  }
});
test("more than 100 sessions remain monotonic and only expired unqueued counters are reclaimed", () => {
  const f = fixture();
  try {
    const ids = Array.from({ length: 120 }, (_, i) =>
      i.toString(16).padStart(64, "0"),
    );
    for (const id of ids) assert.equal(f.collector.nextSequence(id), 0);
    const restarted = new Collector(f.collector.dir);
    for (const id of ids) assert.equal(restarted.nextSequence(id), 1);
    const file = join(f.collector.dir, "sequences.json"),
      entries = JSON.parse(readFileSync(file, "utf8"));
    entries[ids[0]!].lastSeen = Date.now() - 8 * 86400000;
    entries[ids[1]!].lastSeen = Date.now() - 8 * 86400000;
    const queued = baseEvent("claude-code", ids[0]!, 17);
    f.collector.enqueue(queued);
    writeFileSync(file, JSON.stringify(entries), { mode: 0o600 });
    assert.equal(restarted.nextSequence(ids[0]!), 18);
    const retained = JSON.parse(readFileSync(file, "utf8"));
    assert.ok(retained[ids[0]!]);
    assert.equal(retained[ids[1]!], undefined);
    assert.equal(restarted.nextSequence(ids[2]!), 2);
  } finally {
    f.close();
  }
});
test("delayed acknowledgement preserves and reconstructs a resumed session counter through server retention", async (t) => {
  const f = fixture(),
    original = globalThis.fetch,
    base = Date.now();
  let now = base;
  t.mock.method(Date, "now", () => now);
  try {
    pairForDelivery(f.collector);
    f.collector.configure({
      ...f.collector.load(),
      expires: base + 30 * 86400000,
    });
    const run = "a".repeat(64),
      other = "b".repeat(64);
    assert.equal(f.collector.nextSequence(run), 0);
    const event = baseEvent("claude-code", run, 0);
    assert.equal(f.collector.enqueue(event), true);
    // Lost counter metadata must be recovered from acknowledged immutable spans.
    unlinkSync(join(f.collector.dir, "sequences.json"));
    now = base + 6 * 86400000;
    globalThis.fetch = async (_url, options) => {
      assert.equal(
        JSON.parse(String(options?.body)).events[0].eventId,
        event.eventId,
      );
      return new Response("{}", { status: 200 });
    };
    await f.collector.flush();
    assert.equal(f.collector.spool().events.length, 0);
    const record = JSON.parse(
      readFileSync(join(f.collector.dir, "sequences.json"), "utf8"),
    )[run];
    assert.deepEqual(record, { sequence: 0, lastSeen: now });
    now = base + 8 * 86400000;
    const restarted = new Collector(f.collector.dir);
    assert.equal(restarted.nextSequence(other), 0);
    now = base + 9 * 86400000;
    assert.equal(restarted.nextSequence(run), 1);
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});
test("bounded retained-session capacity fails closed and resumes after date-aware reclamation", () => {
  const f = fixture();
  try {
    const now = Date.now(),
      file = join(f.collector.dir, "sequences.json");
    const entries = Object.fromEntries(
      Array.from({ length: 4096 }, (_, i) => [
        i.toString(16).padStart(64, "0"),
        { sequence: 4, lastSeen: now },
      ]),
    );
    writeFileSync(file, JSON.stringify(entries), { mode: 0o600 });
    assert.throws(() => f.collector.nextSequence("f".repeat(64)));
    assert.equal(f.collector.report().coverage, "unknown");
    entries["0".repeat(64)]!.lastSeen = now - 8 * 86400000;
    writeFileSync(file, JSON.stringify(entries), { mode: 0o600 });
    assert.equal(f.collector.nextSequence("f".repeat(64)), 0);
    assert.equal(f.collector.nextSequence("1".padStart(64, "0")), 5);
  } finally {
    f.close();
  }
});
test("owned fixture needs exact absolute executable and absolute resolved test paths", () => {
  const f = fixture();
  try {
    const path = resolve(f.owned.scope.root, f.owned.scope.tests[0]!);
    assert.equal(
      approvedTestCommand(
        `${process.execPath} --test --test-reporter=tap ${path}`,
        f.owned.scope,
      ),
      true,
    );
    for (const command of [
      `${process.execPath} --test --test-reporter=tap fixture.test.cjs`,
      `node --test --test-reporter=tap ${path}`,
      `${process.execPath} --test --test-reporter=tap /other/fixture.test.cjs`,
      `${process.execPath} --test --test-reporter=tap ${f.owned.scope.root}/../fixture.test.cjs`,
    ])
      assert.equal(approvedTestCommand(command, f.owned.scope), false);
    assert.equal(approvedTestCommand(f.command, f.owned.scope), true);
  } finally {
    f.close();
  }
});
for (const status of [200, 401]) {
  test(`disconnect after remote status ${status} removes only collector-owned state`, async () => {
    const f = fixture(),
      original = globalThis.fetch;
    try {
      pairForDelivery(f.collector);
      f.collector.nextSequence("a".repeat(64));
      f.collector.gap();
      f.collector.pendingGap();
      mkdirSync(join(f.root, ".claude"), { mode: 0o700 });
      const config = join(f.root, ".claude", "settings.local.json");
      writeFileSync(
        config,
        JSON.stringify({ permissions: { allow: ["Read"] } }),
        { mode: 0o600 },
      );
      const before = readFileSync(config, "utf8");
      globalThis.fetch = async () => new Response("{}", { status });
      await f.collector.disconnect();
      assert.throws(() => f.collector.load());
      assert.throws(() =>
        readFileSync(join(f.collector.dir, "sequences.json")),
      );
      assert.throws(() =>
        readFileSync(join(f.collector.dir, "health-gap.json")),
      );
      assert.throws(() => readFileSync(join(f.collector.dir, "coverage-gap")));
      assert.equal(readFileSync(config, "utf8"), before);
    } finally {
      globalThis.fetch = original;
      f.close();
    }
  });
}
test("disconnect does not claim remote invalidation or erase credentials on server failure", async () => {
  const f = fixture(),
    original = globalThis.fetch;
  try {
    pairForDelivery(f.collector);
    f.collector.enqueue(baseEvent("fixture", "pending-disconnect", 0));
    const config = readFileSync(
      join(f.collector.dir, "connection.json"),
      "utf8",
    );
    const spool = readFileSync(join(f.collector.dir, "spool.json"), "utf8");
    globalThis.fetch = async () => new Response("{}", { status: 503 });
    await assert.rejects(f.collector.disconnect(), /503/);
    assert.equal(
      readFileSync(join(f.collector.dir, "connection.json"), "utf8"),
      config,
    );
    assert.equal(
      readFileSync(join(f.collector.dir, "spool.json"), "utf8"),
      spool,
    );
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});
test("conflicting re-enqueue rejects without rewriting the retained retry event", () => {
  const f = fixture();
  try {
    f.start();
    f.complete({ exit_code: 0, aggregated_output: tap(0) });
    const event = f.claim();
    assert.equal(f.collector.enqueue(event), true);
    assert.equal(f.collector.enqueue(event), true);
    assert.equal(
      f.collector.enqueue({
        ...event,
        evidence: { ...event.evidence!, loss: true },
      }),
      false,
    );
    assert.equal(JSON.stringify(f.collector.spool().events[0]), encoded(event));
    assert.equal(f.collector.spool().events.length, 1);
    assert.equal(f.collector.report().coverage, "unknown");
  } finally {
    f.close();
  }
});
test("old unacknowledged gap retries unchanged then creates fresh coverage metadata after ack", async () => {
  const f = fixture(),
    original = globalThis.fetch;
  try {
    pairForDelivery(f.collector);
    f.collector.gap();
    const event = f.collector.pendingGap()!;
    const file = join(f.collector.dir, "health-gap.json");
    event.time = Date.now() - 8 * 86400000;
    // Arrange persisted historical state before its first attempted delivery.
    writeFileSync(file, JSON.stringify({ event, acknowledgedAt: 0 }), {
      mode: 0o600,
    });
    const received: { eventId: string; time: number }[] = [];
    globalThis.fetch = async (_url, options) => {
      const batch = JSON.parse(String(options?.body));
      received.push(...batch.events);
      return new Response("{}", { status: 200 });
    };
    await new Collector(f.collector.dir).flush();
    assert.equal(JSON.stringify(received[0]), encoded(event));
    await new Collector(f.collector.dir).flush();
    assert.notEqual(received[1]!.eventId, event.eventId);
    assert.ok(received[1]!.time > event.time);
    assert.equal(f.collector.report().coverage, "unknown");
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});
