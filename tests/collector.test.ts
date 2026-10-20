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
