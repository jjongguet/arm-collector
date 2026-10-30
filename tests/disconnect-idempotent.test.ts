import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  chmodSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { Collector } from "../packages/collector/public.ts";

const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "arm-disconnect-")));
  chmodSync(root, 0o700);
  return {
    root,
    dir: join(root, "state"),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
};

/** Loopback ARM stub: only the disconnect route, with an explicit status. */
async function stub(status: number) {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(
      JSON.stringify(status === 200 ? { revoked: true } : { error: "Denied" }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const pair = (c: Collector, origin: string, token = "a".repeat(43)) =>
  c.configure({
    origin,
    token,
    deviceId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    expires: Date.now() + 1000,
  });

test("disconnect is idempotent: an unpaired directory still clears owned state and reports why", async () => {
  const f = fixture();
  try {
    const c = new Collector(f.dir);
    assert.deepEqual(await c.disconnect(), {
      disconnected: true,
      remote: "not-paired",
    });
    // A second call must not throw and must keep the same honest receipt.
    assert.deepEqual(await c.disconnect(), {
      disconnected: true,
      remote: "not-paired",
    });
    assert.equal(existsSync(join(f.dir, "connection.json")), false);
    assert.equal(existsSync(join(f.dir, "spool.json")), false);
  } finally {
    f.close();
  }
});

test("an expired or revoked credential is already denied, and local state is still removed", async () => {
  const stubServer = await stub(401);
  const f = fixture();
  try {
    const c = new Collector(f.dir);
    pair(c, stubServer.origin);
    writeFileSync(join(f.dir, "adapter-config.json"), "{}");
    assert.deepEqual(await c.disconnect(), {
      disconnected: true,
      remote: "already-denied",
    });
    assert.deepEqual(stubServer.seen, ["POST /api/disconnect"]);
    assert.equal(existsSync(join(f.dir, "connection.json")), false);
    // Adapter configuration belongs to the host install and is never removed here.
    assert.equal(existsSync(join(f.dir, "adapter-config.json")), true);
    assert.deepEqual(await c.disconnect(), {
      disconnected: true,
      remote: "not-paired",
    });
  } finally {
    f.close();
    await stubServer.close();
  }
});

test("a live credential is invalidated remotely before owned files are removed", async () => {
  const stubServer = await stub(200);
  const f = fixture();
  try {
    const c = new Collector(f.dir);
    pair(c, stubServer.origin);
    assert.deepEqual(await c.disconnect(), {
      disconnected: true,
      remote: "invalidated",
    });
    assert.deepEqual(stubServer.seen, ["POST /api/disconnect"]);
    assert.equal(existsSync(join(f.dir, "connection.json")), false);
    assert.equal(existsSync(join(f.dir, "scope-key")), false);
  } finally {
    f.close();
    await stubServer.close();
  }
});
