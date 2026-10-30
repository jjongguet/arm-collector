import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Collector, baseEvent } from "../packages/collector/public.ts";

const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "arm-status-")));
  chmodSync(root, 0o700);
  return {
    dir: join(root, "state"),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
};
const token = "t".repeat(43);

test("an unpaired status receipt states that no credential is held", () => {
  const f = fixture();
  try {
    const receipt = new Collector(f.dir).statusReceipt();
    assert.equal(receipt.paired, false);
    assert.equal(receipt.origin, null);
    assert.equal(receipt.queued, 0);
    assert.equal(receipt.lost, 0);
    assert.equal(receipt.reauthRequired, false);
    assert.equal(receipt.coverage, "observed-metadata-only");
    assert.equal(JSON.stringify(receipt).includes(token), false);
  } finally {
    f.close();
  }
});

test("a paired status receipt identifies the connection and queue without the token", () => {
  const f = fixture();
  try {
    const c = new Collector(f.dir);
    const deviceId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const expires = Date.now() + 60_000;
    c.configure({
      origin: "https://monitor.example",
      token,
      deviceId,
      projectId,
      expires,
    });
    const receipt = c.statusReceipt();
    assert.equal(receipt.paired, true);
    assert.equal(receipt.origin, "https://monitor.example");
    assert.equal(receipt.deviceId, deviceId);
    assert.equal(receipt.projectId, projectId);
    assert.equal(receipt.expires, expires);
    assert.equal(receipt.queued, 0);
    assert.equal(JSON.stringify(receipt).includes(token), false);
  } finally {
    f.close();
  }
});

test("queued evidence and judged findings appear in the receipt", () => {
  const f = fixture();
  try {
    const c = new Collector(f.dir);
    c.configure({
      origin: "https://monitor.example",
      token,
      deviceId: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      expires: Date.now() + 60_000,
    });
    c.enqueue({
      ...baseEvent("fixture", "status-run", 0),
      kind: "test-edit",
    });
    const receipt = c.statusReceipt();
    assert.equal(receipt.queued, 1);
    assert.equal(receipt.findings.length, 1);
    assert.equal(receipt.findings[0]!.detector, "edit");
    assert.equal(receipt.findings[0]!.status, "suspected");
  } finally {
    f.close();
  }
});
