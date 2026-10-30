import { join, resolve, isAbsolute, relative } from "node:path";
import { readFileSync, statSync, lstatSync, openSync, closeSync, unlinkSync, constants, existsSync, mkdtempSync, writeFileSync, chmodSync, realpathSync, rmSync, } from "node:fs";
import { tmpdir } from "node:os";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { z } from "zod";
import { privateDir, readPrivate, atomicPrivate, removePrivate, noSymlinks, } from "./storage.js";
import { eventSchema, judge, parseTap } from "../core/public.js";
const configuration = z
    .object({
    origin: z.url(),
    token: z.string().min(40).max(60),
    deviceId: z.uuid(),
    projectId: z.uuid(),
    expires: z.number().int(),
})
    .strict();
const spoolSchema = z
    .object({
    events: z.array(eventSchema).max(500),
    lost: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
    retryAt: z.number().int().nonnegative(),
})
    .strict();
const retentionMs = 7 * 86400000;
const sequenceCapacity = 4096;
const sequenceSchema = z
    .record(
// Keyed by runId, so it must accept exactly what an event accepts. The two
// schemas were previously independent: a runId that eventSchema allowed
// (for example a legible label) could not be persisted here, which poisoned
// sequences.json and made every later collection call throw.
eventSchema.shape.runId, z
    .object({
    sequence: z.number().int().min(0).max(1000000),
    lastSeen: z.number().int().nonnegative(),
})
    .strict())
    .refine((value) => Object.keys(value).length <= sequenceCapacity);
const gapSchema = z
    .object({
    event: eventSchema,
    acknowledgedAt: z.number().int().nonnegative(),
})
    .strict();
export class Collector {
    dir;
    origin = null;
    lostInMemory = 0;
    constructor(dir) {
        this.dir = privateDir(dir);
    }
    locked(fn) {
        const path = join(this.dir, "spool.lock");
        noSymlinks(path);
        const fd = openSync(path, constants.O_CREAT |
            constants.O_EXCL |
            constants.O_WRONLY |
            constants.O_NOFOLLOW, 0o600);
        try {
            return fn();
        }
        finally {
            closeSync(fd);
            unlinkSync(path);
        }
    }
    gap() {
        this.lostInMemory++;
        try {
            atomicPrivate(join(this.dir, "coverage-gap"), "1");
        }
        catch { }
    }
    hasGap() {
        return (this.lostInMemory > 0 ||
            existsSync(join(this.dir, "coverage-gap")) ||
            existsSync(join(this.dir, "health-gap.json")) ||
            this.spool().lost > 0);
    }
    pendingGap() {
        return this.locked(() => {
            if (!this.hasGap())
                return null;
            const file = join(this.dir, "health-gap.json");
            let state = null;
            try {
                state = gapSchema.parse(JSON.parse(readPrivate(file)));
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
            }
            // Never replace an unacknowledged payload, even when it is old: retries
            // must carry exactly the same event ID and bytes. Renew only after ack.
            if (!state ||
                (state.acknowledgedAt > 0 &&
                    Date.now() - state.acknowledgedAt >= 86400000)) {
                state = {
                    event: eventSchema.parse(baseEvent("fixture", "collector-coverage", 0)),
                    acknowledgedAt: 0,
                };
                atomicPrivate(file, JSON.stringify(state));
            }
            return state.acknowledgedAt === 0 ? state.event : null;
        });
    }
    load() {
        return configuration.parse(JSON.parse(readPrivate(join(this.dir, "connection.json"))));
    }
    configure(value) {
        const config = configuration.parse(value);
        approvedOrigin(config.origin);
        this.locked(() => {
            let previous = null;
            try {
                previous = this.load();
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
            }
            if ((!previous ||
                previous.origin !== config.origin ||
                previous.deviceId !== config.deviceId ||
                previous.projectId !== config.projectId) &&
                this.hasGap()) {
                // Persist loss before invalidating the old destination's acknowledgement
                // or publishing the new identity. Token rotation leaves retry bytes alone.
                atomicPrivate(join(this.dir, "coverage-gap"), "1");
                removePrivate(join(this.dir, "health-gap.json"));
            }
            atomicPrivate(join(this.dir, "connection.json"), JSON.stringify(config));
            const marker = join(this.dir, "reauth-required");
            if (existsSync(marker))
                removePrivate(marker);
        });
    }
    spool() {
        try {
            return spoolSchema.parse(JSON.parse(readPrivate(join(this.dir, "spool.json"))));
        }
        catch (e) {
            if (e.code === "ENOENT")
                return { events: [], lost: 0, failures: 0, retryAt: 0 };
            throw e;
        }
    }
    enqueue(raw) {
        try {
            return this.locked(() => {
                const parsed = eventSchema.parse(raw), spool = this.spool();
                // Loss is bound when an event is collected, never during enqueue or
                // retry. Re-enqueues cannot alter an existing event's payload.
                const existing = spool.events.find((e) => e.eventId === parsed.eventId);
                if (existing) {
                    const same = JSON.stringify(existing) === JSON.stringify(parsed);
                    if (!same)
                        this.gap();
                    return same;
                }
                const event = parsed;
                let accepted = true;
                if (spool.events.length >= 500 ||
                    Buffer.byteLength(JSON.stringify(spool)) +
                        Buffer.byteLength(JSON.stringify(event)) >
                        1024 * 1024) {
                    spool.lost++;
                    accepted = false;
                }
                else
                    spool.events.push(event);
                atomicPrivate(join(this.dir, "spool.json"), JSON.stringify(spool));
                return accepted;
            });
        }
        catch {
            this.gap();
            return false;
        }
    }
    report() {
        const spool = this.spool(), reauth = existsSync(join(this.dir, "reauth-required")), gap = reauth ||
            existsSync(join(this.dir, "coverage-gap")) ||
            existsSync(join(this.dir, "health-gap.json")), expired = spool.events.filter((e) => Date.now() - e.time > retentionMs), current = spool.events.filter((e) => Date.now() - e.time <= retentionMs), loss = Boolean(gap || spool.lost + this.lostInMemory || expired.length);
        return {
            queued: spool.events.length,
            lost: spool.lost + this.lostInMemory + expired.length,
            failures: spool.failures,
            retryAt: spool.retryAt,
            coverage: loss ? "unknown" : "observed-metadata-only",
            reauthRequired: reauth,
            findings: [
                ...current
                    .map((e, i) => {
                    const finding = judge(e, current.slice(0, i));
                    return loss &&
                        finding &&
                        (finding.detector === "D1" || finding.detector === "D2")
                        ? {
                            ...finding,
                            status: "unknown",
                            reason: "Observation coverage gap",
                        }
                        : finding;
                })
                    .filter(Boolean),
                ...(loss
                    ? [
                        {
                            detector: "coverage",
                            status: "unknown",
                            reason: expired.length
                                ? "Evidence expired; observation coverage gap"
                                : "Observation coverage gap",
                        },
                    ]
                    : []),
            ],
        };
    }
    async flush(signal) {
        if (signal?.aborted)
            return;
        let initial = this.spool();
        if (initial.events.some((e) => Date.now() - e.time > 7 * 86400000)) {
            this.locked(() => {
                const spool = this.spool();
                const retained = spool.events.filter((e) => Date.now() - e.time <= 7 * 86400000);
                spool.lost += spool.events.length - retained.length;
                spool.events = retained;
                atomicPrivate(join(this.dir, "spool.json"), JSON.stringify(spool));
            });
            initial = this.spool();
        }
        if (Date.now() < initial.retryAt)
            return;
        if (existsSync(join(this.dir, "reauth-required")))
            return;
        const health = this.pendingGap();
        if (initial.events.length === 0 && !health)
            return;
        let config;
        try {
            config = this.load();
        }
        catch (error) {
            if (error.code === "ENOENT" &&
                initial.events.length === 0)
                return;
            throw error;
        }
        if (config.expires <= Date.now()) {
            // Durable gap marker only: the loss is an episode, not a per-tick count,
            // so repeated flushes must not inflate the reported total.
            try {
                atomicPrivate(join(this.dir, "coverage-gap"), "1");
            }
            catch { }
            return;
        }
        const batch = health ? [health] : [];
        for (const e of initial.events) {
            if (Date.now() - e.time > 7 * 86400000)
                continue;
            if (batch.length === 100 ||
                Buffer.byteLength(JSON.stringify({ events: [...batch, e] })) > 262144)
                break;
            batch.push(e);
        }
        let delivered = false, status = 0;
        try {
            if (batch.length)
                await request(config.origin, "/api/ingest", { events: batch }, config.token, signal);
            delivered = true;
        }
        catch (error) {
            status = Number(error.status ?? 0);
        }
        // 4xx (except revoked credentials and rate limits) will never succeed:
        // isolate the rejected batch so one poison payload cannot block the queue.
        const poison = !delivered &&
            status >= 400 &&
            status < 500 &&
            status !== 401 &&
            status !== 429 &&
            batch.some((e) => e !== health);
        try {
            this.locked(() => {
                const spool = this.spool(), sent = new Set(delivered ? batch.map((e) => e.eventId) : []);
                if (delivered && health) {
                    const file = join(this.dir, "health-gap.json");
                    const state = gapSchema.parse(JSON.parse(readPrivate(file)));
                    if (state.event.eventId === health.eventId &&
                        state.acknowledgedAt === 0)
                        atomicPrivate(file, JSON.stringify({
                            ...state,
                            acknowledgedAt: Date.now() -
                                (Date.now() - health.time > retentionMs ? 86400000 : 0),
                        }));
                }
                const acknowledged = delivered
                    ? batch.filter((e) => /^[a-f0-9]{64}$/.test(e.runId))
                    : [];
                if (acknowledged.length) {
                    const entries = this.sequences(), now = Date.now(), queued = new Set(spool.events.map((e) => e.runId));
                    for (const [id, entry] of Object.entries(entries))
                        if (!queued.has(id) && now - entry.lastSeen > retentionMs)
                            delete entries[id];
                    for (const event of acknowledged) {
                        if (!Object.hasOwn(entries, event.runId) &&
                            Object.keys(entries).length >= sequenceCapacity)
                            throw new Error("Sequence capacity exceeded");
                        entries[event.runId] = {
                            sequence: Math.max(entries[event.runId]?.sequence ?? -1, event.sequence),
                            lastSeen: Math.max(entries[event.runId]?.lastSeen ?? 0, now),
                        };
                    }
                    // Persist before removing queue protection; partial writes must fail closed.
                    atomicPrivate(join(this.dir, "sequences.json"), JSON.stringify(entries));
                }
                const retained = spool.events.filter((e) => Date.now() - e.time <= 7 * 86400000);
                spool.lost += spool.events.length - retained.length;
                if (poison) {
                    const isolated = new Set(batch.map((e) => e.eventId));
                    spool.lost += retained.filter((e) => isolated.has(e.eventId)).length;
                    spool.events = retained.filter((e) => !isolated.has(e.eventId));
                }
                else {
                    spool.events = retained.filter((e) => !sent.has(e.eventId));
                }
                if (delivered) {
                    spool.failures = 0;
                    spool.retryAt = 0;
                }
                else if (status === 401) {
                    // The credential was revoked or replaced elsewhere: stop retrying and
                    // require a fresh pairing before any further delivery.
                    atomicPrivate(join(this.dir, "reauth-required"), "1");
                    spool.failures = 0;
                    spool.retryAt = 0;
                }
                else if (poison) {
                    spool.failures = 0;
                    spool.retryAt = 0;
                }
                else {
                    spool.failures++;
                    spool.retryAt =
                        Date.now() +
                            Math.min(60000, 1000 * 2 ** Math.min(spool.failures, 6)) +
                            Math.floor(Math.random() * 500);
                }
                atomicPrivate(join(this.dir, "spool.json"), JSON.stringify(spool));
            });
        }
        catch {
            this.gap();
        }
    }
    /**
     * Idempotent disconnect. A directory that was never paired (or was already
     * disconnected) still has its owned local state removed and reports why no
     * remote call happened; an expired or revoked credential counts as denied.
     */
    async disconnect() {
        let connection = null;
        try {
            connection = this.load();
        }
        catch (error) {
            if (error?.code !== "ENOENT")
                throw error;
        }
        let remote = "not-paired";
        if (connection) {
            try {
                await request(connection.origin, "/api/disconnect", {}, connection.token);
                remote = "invalidated";
            }
            catch (error) {
                if (error instanceof Error && "status" in error && error.status === 401)
                    remote = "already-denied";
                else
                    throw error;
            }
        }
        for (const name of [
            "connection.json",
            "spool.json",
            "sequences.json",
            "health-gap.json",
            "coverage-gap",
            "scope-key",
            "pairing.json",
            "reauth-required",
        ])
            if (existsSync(join(this.dir, name)))
                removePrivate(join(this.dir, name));
        this.lostInMemory = 0;
        this.origin = null;
        return { disconnected: true, remote };
    }
    /** Stable status receipt: connection identity and queue state, never a token. */
    statusReceipt() {
        const report = this.report();
        try {
            const c = this.load();
            return {
                paired: true,
                origin: c.origin,
                deviceId: c.deviceId,
                projectId: c.projectId,
                expires: c.expires,
                ...report,
            };
        }
        catch (error) {
            if (error?.code !== "ENOENT")
                throw error;
            return { paired: false, origin: null, ...report };
        }
    }
    key() {
        const path = join(this.dir, "scope-key");
        try {
            return Buffer.from(readPrivate(path), "hex");
        }
        catch (e) {
            if (e.code !== "ENOENT")
                throw e;
            const key = randomBytes(32);
            atomicPrivate(path, key.toString("hex"));
            return key;
        }
    }
    sequences() {
        try {
            return sequenceSchema.parse(JSON.parse(readPrivate(join(this.dir, "sequences.json"))));
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
            return {};
        }
    }
    nextSequence(runId) {
        return this.locked(() => {
            const file = join(this.dir, "sequences.json");
            const entries = this.sequences();
            const queued = new Set(this.spool().events.map((e) => e.runId));
            const now = Date.now();
            for (const [id, entry] of Object.entries(entries))
                if (id !== runId &&
                    !queued.has(id) &&
                    now - entry.lastSeen > retentionMs)
                    delete entries[id];
            if (!Object.hasOwn(entries, runId) &&
                Object.keys(entries).length >= sequenceCapacity) {
                this.gap();
                throw new Error("Sequence capacity exceeded");
            }
            const queuedSequence = this.spool()
                .events.filter((e) => e.runId === runId)
                .reduce((max, e) => Math.max(max, e.sequence), -1);
            const next = Math.max(entries[runId]?.sequence ?? -1, queuedSequence) + 1;
            if (next > 1000000) {
                this.gap();
                throw new Error("Sequence capacity exceeded");
            }
            entries[runId] = { sequence: next, lastSeen: now };
            atomicPrivate(file, JSON.stringify(entries));
            return next;
        });
    }
    snapshot(root, files) {
        if (files.length === 0 || files.length > 100)
            return null;
        const start = Date.now(), h = createHmac("sha256", this.key());
        let bytes = 0;
        try {
            for (const file of [...new Set(files)].sort()) {
                if (isAbsolute(file) ||
                    file
                        .split(/[\\/]/)
                        .some((p) => ["..", ".git", "node_modules", ".cache"].includes(p)))
                    return null;
                const path = resolve(root, file);
                if (relative(resolve(root), path).startsWith(".."))
                    return null;
                noSymlinks(path);
                const before = lstatSync(path);
                if (!before.isFile())
                    return null;
                bytes += before.size;
                if (bytes > 2 * 1024 * 1024 || Date.now() - start > 1000)
                    return null;
                const data = readFileSync(path), after = statSync(path);
                if (before.mtimeMs !== after.mtimeMs ||
                    before.ctimeMs !== after.ctimeMs ||
                    before.ino !== after.ino ||
                    before.size !== after.size)
                    return null;
                h.update(file).update("\0").update(data).update("\0");
            }
            return h.digest("hex");
        }
        catch {
            return null;
        }
    }
}
export function approvedOrigin(value) {
    const url = new URL(value);
    if (url.origin !== value ||
        url.username ||
        url.password ||
        (url.protocol !== "https:" &&
            !["127.0.0.1", "localhost"].includes(url.hostname)))
        throw new Error("Explicit HTTPS origin or owned loopback required");
    return value;
}
export async function request(origin, path, body, token, signal) {
    approvedOrigin(origin);
    const response = await fetch(origin + path, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
            : AbortSignal.timeout(5000),
    });
    if (!response.ok)
        throw Object.assign(new Error(`Collector request rejected (${response.status})`), { status: response.status });
    return (await response.json());
}
export function baseEvent(host, runId, sequence) {
    return {
        schemaVersion: 1,
        eventId: randomUUID(),
        runId,
        turnId: "turn",
        toolCallId: "tool",
        sequence,
        time: Date.now(),
        host,
        hostVersion: "0.0.0",
        adapterVersion: "1",
        nodeMajor: Number(process.versions.node.split(".")[0]),
        kind: "health",
        claimClass: "none",
        errorClass: "none",
        progressFingerprint: null,
        evidence: null,
    };
}
// Explicit approved invocation only. No shell, arbitrary command strings, or provider/model execution.
export async function observeNodeTest(collector, root, files, scope, isolated) {
    if (!files.length ||
        files.some((f) => !scope.includes(f) ||
            !/^[-a-zA-Z0-9_./]+\.(?:test\.)?[cm]?[jt]s$/.test(f) ||
            isAbsolute(f) ||
            f.split("/").includes("..")))
        throw new Error("Explicit approved test files required");
    const before = collector.snapshot(root, scope);
    let output = "", overflow = false;
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", ...files], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH ?? "", HOME: collector.dir },
    });
    child.stdout.on("data", (chunk) => {
        if (Buffer.byteLength(output) + chunk.length <= 262144)
            output += chunk.toString();
        else
            overflow = true;
    });
    child.stderr.on("data", () => {
        overflow = true;
    });
    const exit = await new Promise((res, rej) => {
        let settled = false;
        let killTimer;
        const finish = (code, error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            clearTimeout(killTimer);
            if (error)
                rej(error);
            else
                res(code);
        };
        const timer = setTimeout(() => {
            overflow = true;
            child.kill("SIGTERM");
            killTimer = setTimeout(() => {
                child.kill("SIGKILL");
                finish(null);
            }, 1000);
        }, 30000);
        child.once("error", (error) => finish(null, error));
        child.once("close", (code) => finish(code));
    });
    const after = collector.snapshot(root, scope);
    const evidence = {
        runnerProfile: "NODE_TAP_V1",
        commandClass: "approved-node-test",
        exitCode: exit,
        ...parseTap(output),
        completed: exit !== null,
        background: false,
        loss: overflow || collector.hasGap(),
        startedSequence: 0,
        completedSequence: 1,
        scopeId: "explicit-scope",
        coverage: typeof isolated === "object" &&
            isOwnedFixture(isolated) &&
            resolve(root) === isolated.root &&
            JSON.stringify(files) === JSON.stringify(isolated.tests) &&
            JSON.stringify(scope) === JSON.stringify(isolated.files)
            ? "isolated"
            : "unproven",
        before,
        after,
        claim: null,
    };
    return evidence;
}
const ownedFixtures = new WeakSet();
export function createOwnedFixture(passing = false) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "arm-owned-")));
    const owner = lstatSync(root);
    chmodSync(root, 0o700);
    writeFileSync(join(root, "fixture.test.cjs"), `const {test}=require('node:test');const assert=require('node:assert/strict');test('owned fixture',()=>assert.equal(1,${passing ? 1 : 2}));\n`, { mode: 0o400 });
    const scope = {
        root,
        files: ["fixture.test.cjs"],
        tests: ["fixture.test.cjs"],
    };
    Object.freeze(scope.files);
    Object.freeze(scope.tests);
    Object.freeze(scope);
    ownedFixtures.add(scope);
    return {
        scope,
        close() {
            ownedFixtures.delete(scope);
            if (!existsSync(root))
                return;
            const current = lstatSync(root);
            if (current.isSymbolicLink() ||
                current.ino !== owner.ino ||
                current.dev !== owner.dev)
                throw new Error("Fixture ownership changed");
            chmodSync(root, 0o700);
            rmSync(root, { recursive: true, force: true });
        },
    };
}
export function isOwnedFixture(scope) {
    return ownedFixtures.has(scope);
}
export async function collectorWorker(collector, signal, interval = 1000) {
    if (interval < 100 || interval > 60000)
        throw new Error("Worker interval cap");
    while (!signal.aborted) {
        try {
            await collector.flush(signal);
        }
        catch {
            /* offline/unpaired: retry only while explicitly running */
        }
        if (signal.aborted)
            break;
        await new Promise((done) => {
            const finish = () => {
                clearTimeout(timer);
                signal.removeEventListener("abort", finish);
                done();
            };
            const timer = setTimeout(finish, interval);
            signal.addEventListener("abort", finish, { once: true });
            if (signal.aborted)
                finish();
        });
    }
}
export { ARM_ISOLATED_PROFILE, ISOLATED_COMMAND_CLASS, ISOLATED_OUTPUT_LIMIT, ISOLATED_PROFILE_ID, ISOLATED_RUNNER_PROFILE, ISOLATED_SCOPE_ID, ISOLATED_TEST_ARGV, ISOLATED_TEST_FILE, ISOLATED_TIMEOUT_MS, IsolatedRefusal, PINNED_NODE_EXECUTABLE, PINNED_NODE_LABEL, SANDBOX_EXEC, closeIsolatedSelection, isCurrentIsolatedObservation, prepareIsolatedSelection, runIsolatedNodeTest, } from "./isolated-node.js";
