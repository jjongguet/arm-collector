import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  symlinkSync,
  statSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  Collector,
  baseEvent,
  observeNodeTest,
  createOwnedFixture,
  prepareIsolatedSelection,
  runIsolatedNodeTest,
} from "../packages/collector/public.ts";
import {
  normalizeHost,
  claudeSetup,
  isolatedClaimEvent,
  hostContext,
} from "../packages/adapters/public.ts";
import { judge } from "../packages/core/public.ts";
import { readPrivate } from "../packages/collector/storage.ts";
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "arm-collector-")));
  chmodSync(root, 0o700);
  return {
    root,
    c: new Collector(join(root, "state")),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
test("disconnect is idempotent and leaves foreign files untouched", async () => {
  const f = fixture();
  try {
    const foreign = join(f.c.dir, "foreign.txt");
    writeFileSync(foreign, "preserved", { mode: 0o600 });
    assert.equal(f.c.statusReceipt().paired, false);
    f.c.enqueue(baseEvent("fixture", "disconnect-run", 1));
    assert.equal((await f.c.disconnect()).remote, "not-paired");
    assert.equal((await f.c.disconnect()).remote, "not-paired");
    assert.equal(readFileSync(foreign, "utf8"), "preserved");
    assert.equal(f.c.statusReceipt().paired, false);
  } finally {
    f.close();
  }
});

test(
  "consumer observes the real isolated closure without promoting JSON copies",
  {
    skip:
      process.platform !== "darwin"
        ? "Seatbelt host required"
        : !process.env.ARM_REAL_PROJECT_ROOT
          ? "Explicit private ATM fixture not supplied"
          : false,
  },
  async () => {
    const f = fixture();
    try {
      const observed = await runIsolatedNodeTest(
        f.c,
        prepareIsolatedSelection(f.c, process.env.ARM_REAL_PROJECT_ROOT!),
      );
      assert.equal(observed.tests, 5, JSON.stringify(observed));
      assert.equal(observed.pass, 5);
      assert.equal(observed.exitCode, 0);
      assert.equal(observed.loss, false);
      assert.equal(observed.cleanup.verified, true);
      assert.equal(
        judge(isolatedClaimEvent(f.c, observed, "All tests passed."))?.status,
        "resolved",
      );
      assert.equal(
        judge(isolatedClaimEvent(f.c, { ...observed }, "All tests passed."))
          ?.status,
        "unknown",
      );
      f.c.gap();
      assert.equal(
        judge(isolatedClaimEvent(f.c, observed, "All tests passed."))?.status,
        "unknown",
      );
    } finally {
      f.close();
    }
  },
);

test("private secret storage and symlink denial", () => {
  const f = fixture();
  try {
    f.c.configure({
      origin: "https://monitor.example",
      token: "a".repeat(43),
      deviceId: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      expires: Date.now() + 1000,
    });
    assert.equal(
      statSync(join(f.c.dir, "connection.json")).mode & 0o777,
      0o600,
    );
    assert.equal(statSync(f.c.dir).mode & 0o777, 0o700);
    symlinkSync(join(f.c.dir, "connection.json"), join(f.root, "link"));
    assert.throws(() => readPrivate(join(f.root, "link")));
    chmodSync(join(f.c.dir, "connection.json"), 0o644);
    assert.throws(() => f.c.load());
    assert.throws(() =>
      f.c.configure({
        origin: "http://evil.example",
        token: "a".repeat(43),
        deviceId: crypto.randomUUID(),
        projectId: crypto.randomUUID(),
        expires: 0,
      }),
    );
  } finally {
    f.close();
  }
});
for (const changed of ["origin", "deviceId", "projectId"] as const) {
  test(`re-pairing a private directory with a different ${changed} renews acknowledged loss`, async () => {
    const f = fixture(),
      original = globalThis.fetch;
    const config = {
      origin: "https://monitor.example",
      token: "a".repeat(43),
      deviceId: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      expires: Date.now() + 100000,
    };
    const calls: { url: string; body: string }[] = [];
    try {
      f.c.configure(config);
      // An existing health file may be the only durable record of loss.
      const health = join(f.c.dir, "health-gap.json");
      writeFileSync(
        health,
        JSON.stringify({
          event: baseEvent("fixture", "collector-coverage", 0),
          acknowledgedAt: 0,
        }),
        { mode: 0o600 },
      );
      globalThis.fetch = async (input, options) => {
        calls.push({ url: String(input), body: String(options?.body) });
        return new Response("{}", { status: 200 });
      };
      await f.c.flush();
      assert.equal(calls.length, 1);
      const acknowledged = JSON.parse(readPrivate(health));
      assert.ok(acknowledged.acknowledgedAt > 0);
      assert.ok(Date.now() - acknowledged.acknowledgedAt < 86400000);
      assert.equal(f.c.pendingGap(), null);
      assert.equal(f.c.spool().lost, 0);
      assert.equal(f.c.lostInMemory, 0);

      const next = {
        ...config,
        [changed]:
          changed === "origin"
            ? "https://other-monitor.example"
            : crypto.randomUUID(),
      };
      const rePaired = new Collector(f.c.dir);
      rePaired.configure(next);
      assert.equal(readPrivate(join(f.c.dir, "coverage-gap")), "1");
      const restarted = new Collector(f.c.dir);
      const pending = restarted.pendingGap();
      assert.ok(pending);
      assert.equal(pending.runId, "collector-coverage");
      assert.notEqual(pending.eventId, acknowledged.event.eventId);
      assert.equal(restarted.report().coverage, "unknown");
      await restarted.flush();
      assert.deepEqual(
        calls.map((call) => call.url),
        [config.origin + "/api/ingest", next.origin + "/api/ingest"],
      );
      assert.equal(calls[1]!.body, JSON.stringify({ events: [pending] }));
      assert.equal(restarted.pendingGap(), null);
      assert.equal(restarted.report().coverage, "unknown");
    } finally {
      globalThis.fetch = original;
      f.close();
    }
  });
}
test("same-device rotation preserves sticky loss and pending retry bytes", async (t) => {
  const f = fixture(),
    original = globalThis.fetch;
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now });
  const config = {
    origin: "https://monitor.example",
    token: "a".repeat(43),
    deviceId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    expires: now + 3 * 86400000,
  };
  const bodies: string[] = [];
  try {
    f.c.configure(config);
    f.c.gap();
    const pending = f.c.pendingGap();
    assert.ok(pending);
    const health = join(f.c.dir, "health-gap.json");
    const pendingBytes = readPrivate(health);
    globalThis.fetch = async (input, options) => {
      assert.equal(String(input), config.origin + "/api/ingest");
      bodies.push(String(options?.body));
      return new Response("{}", { status: bodies.length === 1 ? 503 : 200 });
    };
    await f.c.flush();
    assert.equal(bodies.length, 1);
    assert.equal(f.c.spool().failures, 1);
    t.mock.timers.tick(86400001);
    f.c.configure({ ...config, token: "b".repeat(43) });
    const restarted = new Collector(f.c.dir);
    assert.equal(readPrivate(join(f.c.dir, "coverage-gap")), "1");
    assert.equal(readPrivate(health), pendingBytes);
    assert.deepEqual(restarted.pendingGap(), pending);
    assert.equal(readPrivate(health), pendingBytes);
    await restarted.flush();
    assert.deepEqual(bodies, [
      JSON.stringify({ events: [pending] }),
      JSON.stringify({ events: [pending] }),
    ]);
    const acknowledgedBytes = readPrivate(health);
    restarted.configure({ ...config, token: "c".repeat(43) });
    assert.equal(readPrivate(health), acknowledgedBytes);
    assert.equal(restarted.pendingGap(), null);
    assert.equal(restarted.hasGap(), true);
    assert.equal(restarted.report().coverage, "unknown");
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});
for (const blocked of ["coverage-gap", "health-gap.json"] as const) {
  test(`re-pairing does not publish a new identity when ${blocked} cannot be updated`, () => {
    const f = fixture();
    const config = {
      origin: "https://monitor.example",
      token: "a".repeat(43),
      deviceId: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      expires: Date.now() + 100000,
    };
    try {
      f.c.configure(config);
      const health = join(f.c.dir, "health-gap.json");
      const bytes = JSON.stringify({
        event: baseEvent("fixture", "collector-coverage", 0),
        acknowledgedAt: Date.now(),
      });
      writeFileSync(health, bytes, { mode: 0o600 });
      if (blocked === "coverage-gap")
        mkdirSync(join(f.c.dir, blocked), { mode: 0o700 });
      else chmodSync(health, 0o644);
      assert.throws(() =>
        f.c.configure({ ...config, deviceId: crypto.randomUUID() }),
      );
      assert.deepEqual(f.c.load(), config);
      assert.equal(readFileSync(health, "utf8"), bytes);
      assert.equal(new Collector(f.c.dir).hasGap(), true);
      if (blocked === "health-gap.json")
        assert.equal(readPrivate(join(f.c.dir, "coverage-gap")), "1");
    } finally {
      f.close();
    }
  });
}
test("local repeated-error findings become unknown with a coverage gap without rewriting events", () => {
  const f = fixture();
  try {
    for (let sequence = 0; sequence < 3; sequence++) {
      const event = baseEvent("fixture", "repeated-error", sequence);
      event.kind = "error";
      event.errorClass = "tool-failed";
      event.progressFingerprint = "a".repeat(64);
      assert.equal(f.c.enqueue(event), true);
    }
    const spool = join(f.c.dir, "spool.json");
    const bytes = readPrivate(spool);
    assert.deepEqual(f.c.report().findings, [
      {
        detector: "D2",
        status: "suspected",
        reason: "Repeated error without observed progress",
      },
    ]);
    f.c.gap();
    const findings = [
      {
        detector: "D2",
        status: "unknown",
        reason: "Observation coverage gap",
      },
      {
        detector: "coverage",
        status: "unknown",
        reason: "Observation coverage gap",
      },
    ];
    assert.deepEqual(f.c.report().findings, findings);
    assert.deepEqual(new Collector(f.c.dir).report().findings, findings);
    assert.equal(readPrivate(spool), bytes);
  } finally {
    f.close();
  }
});
test("raw secret canaries never enter normalized spool or report", () => {
  const f = fixture();
  try {
    const canary =
      "PROVIDER-TOKEN-canary prompt /Users/private@example.com/source";
    const e = normalizeHost(
      {
        hook_event_name: "Stop",
        session_id: canary,
        last_assistant_message: "All tests passed.",
        prompt: canary,
        source: canary,
        tool_input: { command: canary },
      },
      "claude-code",
      f.c,
      1,
    )!;
    assert.equal(e.evidence, null);
    assert.equal(judge(e)?.status, "unknown");
    f.c.enqueue(e);
    const disk = readFileSync(join(f.c.dir, "spool.json"), "utf8"),
      report = JSON.stringify(f.c.report());
    assert.ok(!disk.includes(canary));
    assert.ok(!report.includes(canary));
    assert.ok(!disk.includes("/Users/"));
    assert.ok(!disk.includes("prompt"));
  } finally {
    f.close();
  }
});
test("queue caps, restart, session isolation and crash lock gap", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 502; i++) f.c.enqueue(baseEvent("fixture", "run", i));
    assert.equal(f.c.report().queued, 500);
    assert.equal(f.c.report().lost, 2);
    const restarted = new Collector(f.c.dir);
    assert.equal(restarted.report().lost, 2);
    const second = new Collector(join(f.root, "second"));
    assert.equal(second.report().queued, 0);
    writeFileSync(join(second.dir, "spool.lock"), "owned-crash", {
      mode: 0o600,
    });
    assert.equal(second.enqueue(baseEvent("fixture", "run", 1)), false);
    assert.equal(new Collector(second.dir).report().coverage, "unknown");
  } finally {
    f.close();
  }
});
test("write failure never throws into agent and exposes gap", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.c.dir, "spool.json"), { mode: 0o700 });
    assert.equal(f.c.enqueue(baseEvent("fixture", "run", 1)), false);
    assert.equal(f.c.lostInMemory, 1);
  } finally {
    f.close();
  }
});
test("config preview and owned uninstall preserve unrelated entries", () => {
  const f = fixture();
  try {
    const dir = join(f.root, ".claude");
    mkdirSync(dir, { mode: 0o700 });
    const original = {
      permissions: { allow: ["Read"] },
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "echo unrelated" }] }],
      },
    };
    const path = join(dir, "settings.local.json");
    writeFileSync(path, JSON.stringify(original), { mode: 0o600 });
    claudeSetup(f.root, f.c.dir, "/owned/cli.ts");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), original);
    claudeSetup(f.root, f.c.dir, "/owned/cli.ts", true);
    let value = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(value.permissions, original.permissions);
    assert.equal(value.hooks.Stop.length, 2);
    const stop = value.hooks.Stop[1].hooks[0];
    assert.equal(stop.async, undefined);
    assert.equal(stop.timeout, 3);
    assert.match(stop.command, /arm-owned-v1/);
    const failure = value.hooks.PostToolUseFailure[0].hooks[0];
    assert.equal(failure.async, true);
    assert.equal(value.hooks.PostToolUse[0].matcher, "Edit|Write");
    // Re-apply replaces the owned entry instead of duplicating it.
    claudeSetup(f.root, f.c.dir, "/owned/cli.ts", true);
    value = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(value.hooks.Stop.length, 2);
    assert.equal(value.hooks.Stop[1].hooks.length, 1);
    claudeSetup(f.root, f.c.dir, "/owned/cli.ts", true, true);
    value = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(value.hooks.Stop, original.hooks.Stop);
    assert.deepEqual(value.permissions, original.permissions);
    // Path drift: a re-apply replaces the previous owned entry instead of
    // orphaning it, and uninstall removes owned entries by marker alone.
    claudeSetup(f.root, f.c.dir, "/moved/cli.ts", true);
    value = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(value.hooks.Stop.length, 2);
    assert.equal(value.hooks.Stop[1].hooks.length, 1);
    assert.match(value.hooks.Stop[1].hooks[0].command, /moved\/cli\.ts/);
    claudeSetup(f.root, f.c.dir, "/elsewhere/cli.ts", true, true);
    assert.doesNotMatch(readFileSync(path, "utf8"), /arm-owned-v1/);
    value = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(value.hooks.Stop, original.hooks.Stop);
  } finally {
    f.close();
  }
});
test("actual explicit NODE_TAP failure then fix with stable fixture snapshots", async () => {
  const f = fixture();
  const owned = createOwnedFixture();
  try {
    const file = join(owned.scope.root, owned.scope.tests[0]!);
    const e = await observeNodeTest(
      f.c,
      owned.scope.root,
      owned.scope.tests,
      owned.scope.files,
      owned.scope,
    );
    assert.equal(e.exitCode, 1);
    assert.equal(e.fail, 1);
    assert.equal(e.fullOutput, true);
    e.claim = f.c.snapshot(owned.scope.root, owned.scope.files);
    assert.equal(
      judge({
        ...baseEvent("fixture", "run", 2),
        kind: "claim",
        claimClass: "tests-passed",
        evidence: e,
      })?.status,
      "detected",
    );
    chmodSync(file, 0o600);
    writeFileSync(
      file,
      "const {test}=require('node:test');test('fixture',()=>{});\n",
    );
    const pass = await observeNodeTest(
      f.c,
      owned.scope.root,
      owned.scope.tests,
      owned.scope.files,
      owned.scope,
    );
    pass.claim = f.c.snapshot(owned.scope.root, owned.scope.files);
    assert.equal(pass.exitCode, 0);
    assert.equal(
      judge({
        ...baseEvent("fixture", "run", 2),
        kind: "claim",
        claimClass: "tests-passed",
        evidence: pass,
      })?.status,
      "resolved",
    );
    assert.equal(
      judge({
        ...baseEvent("fixture", "run", 2),
        kind: "claim",
        claimClass: "tests-passed",
        evidence: { ...e, claim: pass.claim },
      })?.status,
      "unknown",
    );
  } finally {
    owned.close();
    f.close();
  }
});
test("expired credential loss is idempotent across flushes", async () => {
  const f = fixture();
  try {
    f.c.configure({
      origin: "https://monitor.example",
      token: "a".repeat(43),
      deviceId: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      expires: Date.now() - 1000,
    });
    f.c.enqueue(baseEvent("fixture", "expired-run", 1));
    await f.c.flush();
    const first = f.c.report();
    await f.c.flush();
    const second = f.c.report();
    assert.equal(first.queued, 1);
    assert.equal(second.queued, 1);
    assert.equal(first.lost, second.lost);
    assert.equal(second.coverage, "unknown");
  } finally {
    f.close();
  }
});
test("revoked credential records reauthentication and stops retrying", async () => {
  const f = fixture(),
    original = globalThis.fetch;
  let calls = 0;
  const config = {
    origin: "https://monitor.example",
    token: "a".repeat(43),
    deviceId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    expires: Date.now() + 100000,
  };
  try {
    f.c.configure(config);
    f.c.enqueue(baseEvent("fixture", "run", 1));
    globalThis.fetch = async () => {
      calls++;
      return new Response(
        JSON.stringify({ error: "Device credential required" }),
        {
          status: 401,
        },
      );
    };
    await f.c.flush();
    assert.equal(calls, 1);
    assert.equal(f.c.report().reauthRequired, true);
    assert.equal(f.c.report().queued, 1);
    assert.equal(f.c.report().coverage, "unknown");
    await f.c.flush();
    assert.equal(calls, 1);
    f.c.configure(config);
    assert.equal(f.c.report().reauthRequired, false);
    globalThis.fetch = async () => {
      calls++;
      return new Response("{}", { status: 200 });
    };
    await f.c.flush();
    assert.equal(f.c.report().queued, 0);
    assert.equal(f.c.report().coverage, "observed-metadata-only");
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});
test("permanent rejection isolates the poison batch and surfaces loss", async () => {
  const f = fixture(),
    original = globalThis.fetch;
  try {
    f.c.configure({
      origin: "https://monitor.example",
      token: "a".repeat(43),
      deviceId: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      expires: Date.now() + 100000,
    });
    f.c.enqueue(baseEvent("fixture", "poison-run", 1));
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "Invalid batch" }), { status: 400 });
    await f.c.flush();
    assert.equal(f.c.report().queued, 0);
    assert.equal(f.c.report().lost, 1);
    assert.equal(f.c.report().failures, 0);
    assert.equal(f.c.report().retryAt, 0);
    assert.equal(f.c.report().coverage, "unknown");
    // A rejected coverage-gap event is not poison: it stays on the bounded
    // retry path so a protocol mismatch remains visible instead of silent.
    await f.c.flush();
    assert.equal(f.c.report().failures, 1);
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});
test("snapshot caps and path traversal remain unknown", () => {
  const f = fixture();
  try {
    assert.equal(f.c.snapshot(f.root, []), null);
    assert.equal(f.c.snapshot(f.root, ["../secret"]), null);
    assert.equal(f.c.snapshot(f.root, ["/absolute/path"]), null);
    writeFileSync(join(f.root, "large.js"), "x".repeat(2 * 1024 * 1024 + 1));
    assert.equal(f.c.snapshot(f.root, ["large.js"]), null);
  } finally {
    f.close();
  }
});
test("network failure retries only approved ingest, no judge or redirect", async () => {
  const f = fixture(),
    original = globalThis.fetch;
  const calls: string[] = [];
  try {
    f.c.configure({
      origin: "https://monitor.example",
      token: "a".repeat(43),
      deviceId: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      expires: Date.now() + 1000,
    });
    f.c.enqueue(baseEvent("fixture", "run", 1));
    globalThis.fetch = async (input, options) => {
      calls.push(String(input));
      assert.equal(options?.redirect, "error");
      throw Error("offline");
    };
    await f.c.flush();
    assert.equal(f.c.report().failures, 1);
    assert.equal(f.c.report().queued, 1);
    await f.c.flush();
    assert.deepEqual(calls, ["https://monitor.example/api/ingest"]);
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});

// The sequence store is keyed by runId, so it must accept exactly the runIds an
// event accepts. When the two schemas disagreed, one legible runId poisoned
// sequences.json and every later call threw with no recovery path.
test("a schema-valid runId never poisons the sequence store", () => {
  const f = fixture();
  try {
    assert.equal(f.c.nextSequence("owned-run"), 0);
    assert.equal(f.c.nextSequence("owned-run"), 1);
    assert.equal(f.c.nextSequence("a".repeat(64)), 0);
    assert.equal(f.c.enqueue(baseEvent("fixture", "owned-run", 2)), true);
    // A restart reads the same file back and keeps counting.
    const restarted = new Collector(f.c.dir);
    assert.equal(restarted.nextSequence("owned-run"), 3);
    assert.deepEqual(
      Object.keys(
        JSON.parse(readFileSync(join(f.c.dir, "sequences.json"), "utf8")),
      ).sort(),
      ["a".repeat(64), "owned-run"].sort(),
    );
  } finally {
    f.close();
  }
});

// A general (non-fixture) codex-exec scope can carry complete, stable test
// evidence, yet the wrapper never claims isolation for it. The isolated twin is
// the positive control: only the coverage label differs between the two.
test("general-scope codex evidence stays unproven and judges unknown", () => {
  const f = fixture();
  try {
    const project = join(f.root, "project");
    mkdirSync(project);
    writeFileSync(join(project, "a.test.js"), "");
    const scope = { root: project, files: ["a.test.js"], tests: ["a.test.js"] };
    const context = hostContext(scope, "0.159.3", crypto.randomUUID());
    const command = "node --test --test-reporter=tap a.test.js";
    const tap =
      "TAP version 13\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1.2\n";
    assert.equal(
      normalizeHost(
        { type: "item.started", item: { id: "c1", type: "command_execution", command } },
        "codex",
        f.c,
        0,
        context,
      ),
      null,
    );
    normalizeHost(
      {
        type: "item.completed",
        item: { id: "c1", type: "command_execution", command, status: "completed", exit_code: 0, aggregated_output: tap },
      },
      "codex",
      f.c,
      1,
      context,
    );
    const claim = normalizeHost(
      { type: "item.completed", item: { id: "m1", type: "agent_message", text: "All tests passed." } },
      "codex",
      f.c,
      2,
      context,
    )!;
    assert.equal(claim.claimClass, "tests-passed");
    assert.equal(claim.evidence?.coverage, "unproven");
    assert.equal(claim.evidence?.exitCode, 0);
    assert.equal(claim.evidence?.tests, 1);
    // Neutralise the separate runner-version guard so coverage alone decides.
    const general = { ...claim, nodeMajor: 24 };
    assert.equal(judge(general)?.status, "unknown");
    const isolatedTwin = { ...general, evidence: { ...general.evidence!, coverage: "isolated" as const } };
    assert.equal(judge(isolatedTwin)?.status, "resolved");
  } finally {
    f.close();
  }
});

test("receive orders accepted events per stable session and enqueues nothing unsupported", () => {
  const f = fixture();
  try {
    const receive = (payload: unknown) => {
      const result = spawnSync(
        process.execPath,
        ["packages/collector/cli.ts", "receive", "--host", "codex", "--dir", f.c.dir],
        { input: JSON.stringify(payload), encoding: "utf8", timeout: 10000 },
      );
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout) as { received: boolean; reason: string };
    };
    const spooled = () =>
      (JSON.parse(readPrivate(join(f.c.dir, "spool.json"))) as {
        events: { runId: string; sequence: number }[];
      }).events;
    const claim = {
      type: "item.completed",
      thread_id: "thread-stable",
      item: { type: "agent_message", text: "All tests passed." },
    };
    assert.deepEqual(receive(claim), { received: true, reason: "queued" });
    assert.deepEqual(receive(claim), { received: true, reason: "queued" });
    const stable = spooled();
    assert.equal(stable.length, 2);
    assert.equal(stable[0]!.runId, stable[1]!.runId);
    assert.ok(stable[1]!.sequence > stable[0]!.sequence);
    // Without a session/thread id each payload is its own run; only the receipt
    // shape is part of the contract, not cross-run ordering.
    const { thread_id: _, ...idless } = claim;
    assert.deepEqual(receive(idless), { received: true, reason: "queued" });
    const before = readPrivate(join(f.c.dir, "spool.json"));
    assert.deepEqual(receive({ type: "turn.started" }), { received: false, reason: "unsupported-event" });
    assert.equal(readPrivate(join(f.c.dir, "spool.json")), before);
  } finally {
    f.close();
  }
});

test("re-enqueueing an event id is idempotent only for identical bytes", () => {
  const f = fixture();
  try {
    const event = baseEvent("fixture", "owned-run", 0);
    assert.equal(f.c.enqueue(event), true);
    const spool = readPrivate(join(f.c.dir, "spool.json"));
    assert.equal(f.c.enqueue(structuredClone(event)), true);
    assert.equal(readPrivate(join(f.c.dir, "spool.json")), spool);
    assert.equal(f.c.hasGap(), false);
    assert.equal(f.c.enqueue({ ...event, sequence: 1 }), false);
    assert.equal(readPrivate(join(f.c.dir, "spool.json")), spool);
    assert.equal(f.c.hasGap(), true);
  } finally {
    f.close();
  }
});
