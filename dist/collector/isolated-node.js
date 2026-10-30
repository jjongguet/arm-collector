import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync, } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { parseTap } from "../core/public.js";
// Fixed invocation identity. This is deliberately a different profile from the
// generic NODE_TAP_V1 observer: only this module runs the approved Node test
// child inside the per-child Seatbelt boundary.
export const ISOLATED_RUNNER_PROFILE = "NODE_TAP_ISOLATED_V1";
export const ISOLATED_COMMAND_CLASS = "approved-isolated-node-test";
export const ISOLATED_PROFILE_ID = "arm-atm-98b5cfc-node-24.15.0-seatbelt-v1";
export const ISOLATED_TEST_FILE = "tests/unit/token-estimate.test.ts";
export const ISOLATED_SCOPE_ID = "isolated-arm-atm";
// Verified post-admission pin: this exact executable, Node v24.15.0.
export const PINNED_NODE_EXECUTABLE = join(homedir(), ".nvm/versions/node/v24.15.0/bin/node");
export const PINNED_NODE_SHA256 = "3200fbd9f7fd4410426dd541e10d1ab829d3472f270d743c7fabd1696c03fe32";
export const PINNED_NODE_LABEL = "node-24.15.0-pinned";
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
// Fixed argv. The selected file is appended last; no caller-supplied flags,
// reporter options, environment, or command strings can alter this shape.
export const ISOLATED_TEST_ARGV = Object.freeze([
    "--test",
    "--test-isolation=none",
    "--test-concurrency=1",
    "--test-reporter=tap",
]);
export const ISOLATED_OUTPUT_LIMIT = 262144;
export const ISOLATED_CANARY_OUTPUT_LIMIT = 4096;
export const ISOLATED_TIMEOUT_MS = 60000;
export const ISOLATED_CANARY_TIMEOUT_MS = 5000;
export const ISOLATED_MIN_TIMEOUT_MS = 100;
export const ISOLATED_MAX_TIMEOUT_MS = 120000;
export class IsolatedRefusal extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "IsolatedRefusal";
        this.code = code;
    }
}
const sealedStates = new WeakMap();
const observations = new WeakMap();
const NOT_OWNED_CLEANUP = Object.freeze({
    verified: false,
    removed: false,
    reason: "not-owned",
});
const MANIFEST_BYTE_CAP = 1024 * 1024;
const MANIFEST_TOTAL_BYTE_CAP = 4 * 1024 * 1024;
const PROFILE_FILE_LIMIT = 64;
function uid() {
    const value = process.getuid?.();
    if (value === undefined)
        throw new IsolatedRefusal("root-not-owned", "The current user identity is unavailable.");
    return value;
}
function isInside(root, path) {
    return path === root || path.startsWith(root === "/" ? "/" : `${root}/`);
}
function validRelative(path) {
    return (typeof path === "string" &&
        path.length > 0 &&
        path.length <= 256 &&
        !isAbsolute(path) &&
        !path.includes("\\") &&
        !path.includes("\0") &&
        path
            .split("/")
            .every((part) => part.length > 0 &&
            part !== "." &&
            part !== ".." &&
            part !== "node_modules" &&
            part !== ".git" &&
            /^[A-Za-z0-9._-]+$/.test(part)));
}
function sha256(data) {
    return createHash("sha256").update(data).digest("hex");
}
function literal(path) {
    return JSON.stringify(path);
}
function pathLiteral(path) {
    return `(literal ${literal(path)})`;
}
function ancestors(path) {
    const values = [];
    let current = path;
    for (;;) {
        const parent = dirname(current);
        if (parent === current)
            break;
        values.push(parent);
        current = parent;
    }
    values.push("/");
    return values;
}
function identity(path) {
    const info = lstatSync(path);
    return Object.freeze({ dev: info.dev, ino: info.ino, uid: info.uid });
}
function sameIdentity(path, expected) {
    try {
        const current = lstatSync(path);
        return (!current.isSymbolicLink() &&
            current.dev === expected.dev &&
            current.ino === expected.ino &&
            current.uid === expected.uid);
    }
    catch {
        return false;
    }
}
function missing(error) {
    return error?.code === "ENOENT";
}
function readOwnedBytes(path) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const before = fstatSync(fd);
        if (!before.isFile())
            throw new IsolatedRefusal("manifest-unsafe", "An approved file is not a regular file.");
        if (before.size > MANIFEST_BYTE_CAP)
            throw new IsolatedRefusal("manifest-too-large", "An approved file exceeds the byte cap.");
        const data = readFileSync(fd);
        const after = fstatSync(fd);
        if (before.dev !== after.dev ||
            before.ino !== after.ino ||
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs ||
            before.ctimeMs !== after.ctimeMs ||
            data.byteLength !== after.size)
            throw new IsolatedRefusal("manifest-unsafe", "An approved file changed while it was read.");
        return data;
    }
    finally {
        closeSync(fd);
    }
}
function createIsolatedProfile(input) {
    if (!input ||
        typeof input.profileId !== "string" ||
        !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(input.profileId) ||
        !validRelative(input.test) ||
        !Array.isArray(input.files) ||
        input.files.length === 0 ||
        input.files.length > PROFILE_FILE_LIMIT)
        throw new IsolatedRefusal("profile-invalid", "The isolated profile shape is invalid.");
    const seen = new Set();
    const files = [];
    for (const entry of input.files) {
        if (!entry ||
            typeof entry.path !== "string" ||
            typeof entry.digest !== "string" ||
            !validRelative(entry.path) ||
            !/^[a-f0-9]{64}$/.test(entry.digest) ||
            seen.has(entry.path))
            throw new IsolatedRefusal("profile-invalid", "The isolated profile manifest is invalid.");
        seen.add(entry.path);
        files.push(Object.freeze({ path: entry.path, digest: entry.digest }));
    }
    if (!seen.has(input.test))
        throw new IsolatedRefusal("profile-invalid", "The approved test must be part of the isolated manifest.");
    const profile = Object.freeze({
        profileId: input.profileId,
        test: input.test,
        files: Object.freeze(files),
    });
    return profile;
}
export function prepareIsolatedSelection(collector, root) {
    let profile = ARM_ISOLATED_PROFILE;
    if (typeof root !== "string" || !isAbsolute(root) || root.includes("\0"))
        throw new IsolatedRefusal("root-unavailable", "An absolute selected root is required.");
    const selected = resolve(root);
    let rootInfo;
    try {
        rootInfo = lstatSync(selected);
    }
    catch (error) {
        if (missing(error))
            throw new IsolatedRefusal("root-unavailable", "The selected root is unavailable.");
        throw error;
    }
    if (rootInfo.isSymbolicLink())
        throw new IsolatedRefusal("root-symlink", "The selected root must not be a symlink.");
    if (!rootInfo.isDirectory())
        throw new IsolatedRefusal("root-not-directory", "The selected root must be a directory.");
    if (rootInfo.uid !== uid())
        throw new IsolatedRefusal("root-not-owned", "The selected root must be owned by the current user.");
    if ((rootInfo.mode & 0o022) !== 0)
        throw new IsolatedRefusal("root-not-private", "The selected root must not be group or world writable.");
    if (realpathSync(selected) !== selected)
        throw new IsolatedRefusal("root-not-canonical", "The selected root must be canonical and free of symlinked parts.");
    const contents = [];
    let total = 0;
    for (const entry of profile.files) {
        const path = resolve(selected, entry.path);
        if (!isInside(selected, path))
            throw new IsolatedRefusal("manifest-unsafe", "An approved path escapes the selected root.");
        let info;
        try {
            info = lstatSync(path);
        }
        catch (error) {
            if (missing(error))
                throw new IsolatedRefusal("manifest-missing", "An approved file is missing.");
            throw error;
        }
        if (info.isSymbolicLink())
            throw new IsolatedRefusal("manifest-symlink", "An approved file must not be a symlink.");
        if (!info.isFile())
            throw new IsolatedRefusal("manifest-unsafe", "An approved file must be a regular file.");
        if (info.uid !== uid() || (info.mode & 0o022) !== 0)
            throw new IsolatedRefusal("manifest-unsafe", "An approved file must be current-user owned and not group or world writable.");
        if (realpathSync(path) !== path)
            throw new IsolatedRefusal("manifest-symlink", "An approved file resolves through a symlink.");
        const data = readOwnedBytes(path);
        total += data.byteLength;
        if (total > MANIFEST_TOTAL_BYTE_CAP)
            throw new IsolatedRefusal("manifest-too-large", "The approved closure exceeds the total byte cap.");
        const actualDigest = sha256(data);
        // The single pre-approved UTF-8 fault is the only alternate source.
        // Tests, package metadata and every dependency remain byte-pinned.
        const approvedFault = entry.path === "src/modules/orders/token-estimate.ts" &&
            actualDigest ===
                "d81347dd49a059a7eab49e512fa6936f3ba9152e940dc81712bdda80cd9a74dd";
        if (actualDigest !== entry.digest && !approvedFault)
            throw new IsolatedRefusal("manifest-mismatch", "An approved file does not match its protected digest.");
        contents.push({ entry: { path: entry.path, digest: actualDigest }, data });
    }
    profile = createIsolatedProfile({
        ...profile,
        files: contents.map(({ entry }) => entry),
    });
    let stateRoot;
    let stateInfo;
    try {
        stateRoot = realpathSync(collector.dir);
        stateInfo = lstatSync(stateRoot);
    }
    catch {
        throw new IsolatedRefusal("root-unavailable", "The collector state directory is unavailable.");
    }
    if (!stateInfo.isDirectory() ||
        stateInfo.uid !== uid() ||
        (stateInfo.mode & 0o077) !== 0)
        throw new IsolatedRefusal("root-not-private", "The collector state directory must be a private owned directory.");
    const base = realpathSync(mkdtempSync(join(stateRoot, "isolated-run-")));
    chmodSync(base, 0o700);
    try {
        const sealed = join(base, "sealed");
        const scratch = join(base, "scratch");
        const outside = join(base, "outside");
        const manifestPath = join(base, "manifest.json");
        const protectedTarget = join(base, "protected.txt");
        const ownedTrue = join(scratch, "owned-true");
        mkdirSync(sealed, { mode: 0o700 });
        mkdirSync(scratch, { mode: 0o700 });
        mkdirSync(outside, { mode: 0o700 });
        for (const { entry, data } of contents) {
            const target = resolve(sealed, entry.path);
            if (!isInside(sealed, target))
                throw new IsolatedRefusal("manifest-unsafe", "An approved path escapes the sealed root.");
            mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
            writeFileSync(target, data, { mode: 0o400, flag: "wx" });
            chmodSync(target, 0o400);
        }
        writeFileSync(manifestPath, JSON.stringify({
            profileId: profile.profileId,
            files: profile.files.map((entry) => ({
                path: entry.path,
                digest: entry.digest,
            })),
        }), { mode: 0o600 });
        writeFileSync(protectedTarget, "owned-protected-target", { mode: 0o600 });
        writeFileSync(join(outside, "secret.txt"), "owned-denied-read-target", {
            mode: 0o600,
        });
        writeFileSync(ownedTrue, readFileSync("/usr/bin/true"), { mode: 0o700 });
        for (const name of Object.keys(CANARY_SOURCES)) {
            writeFileSync(join(scratch, `${name}.mjs`), CANARY_SOURCES[name], {
                mode: 0o400,
            });
        }
        sealTree(sealed);
        const selectionDigest = profileDigest(profile);
        const state = {
            collector,
            source: selected,
            sourceIdentity: identity(selected),
            running: false,
            base,
            sealed,
            scratch,
            outside,
            manifestPath,
            protectedTarget,
            ownedTrue,
            baseIdentity: identity(base),
            sealedIdentity: identity(sealed),
            selectionDigest,
            profile,
        };
        const selection = Object.freeze({
            profileId: profile.profileId,
            sourceRoot: selected,
            sealedRoot: sealed,
            scratchRoot: scratch,
            manifestPath,
            profile,
        });
        sealedStates.set(selection, state);
        return selection;
    }
    catch (error) {
        removeBase(base);
        throw error;
    }
}
export function closeIsolatedSelection(selection) {
    const state = sealedStates.get(selection);
    if (state?.running)
        return Object.freeze({
            verified: false,
            removed: false,
            reason: "running",
        });
    if (!state)
        return Object.freeze({
            verified: false,
            removed: false,
            reason: "not-owned",
        });
    let info;
    try {
        info = lstatSync(state.base);
    }
    catch (error) {
        if (missing(error))
            return Object.freeze({
                verified: true,
                removed: false,
                reason: "absent",
            });
        return Object.freeze({
            verified: false,
            removed: false,
            reason: "unreadable",
        });
    }
    if (info.isSymbolicLink() ||
        !info.isDirectory() ||
        info.dev !== state.baseIdentity.dev ||
        info.ino !== state.baseIdentity.ino ||
        info.uid !== state.baseIdentity.uid)
        return Object.freeze({
            verified: false,
            removed: false,
            reason: "ownership-changed",
        });
    try {
        removeBase(state.base);
    }
    catch {
        return Object.freeze({
            verified: false,
            removed: false,
            reason: "remove-failed",
        });
    }
    const verified = !existsSync(state.base);
    sealedStates.delete(selection);
    return Object.freeze({
        verified,
        removed: true,
        reason: verified ? null : "remove-incomplete",
    });
}
export async function runIsolatedNodeTest(collector, selection, options = {}) {
    const state = sealedStates.get(selection);
    if (!state || state.collector !== collector || state.running)
        return refusedObservation("unowned-selection", {
            profileId: null,
            selectionDigest: null,
            testDigest: null,
            fileCount: 0,
            supported: false,
            cleanup: NOT_OWNED_CLEANUP,
        });
    const base = {
        profileId: state.profile.profileId,
        selectionDigest: state.selectionDigest,
        testDigest: state.profile.files.find((entry) => entry.path === state.profile.test)
            ?.digest ?? null,
        fileCount: state.profile.files.length,
    };
    const timeoutMs = options.timeoutMs ?? ISOLATED_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) ||
        timeoutMs < ISOLATED_MIN_TIMEOUT_MS ||
        timeoutMs > ISOLATED_MAX_TIMEOUT_MS)
        throw new IsolatedRefusal("invalid-timeout", "The isolated timeout is outside the approved bounds.");
    state.running = true;
    const canaries = [];
    const refuse = (reason) => {
        state.running = false;
        return refusedObservation(reason, {
            ...base,
            supported: process.platform === "darwin",
            aborted: reason === "aborted",
            canaries,
            cleanup: closeIsolatedSelection(selection),
        });
    };
    try {
        if (options.signal?.aborted)
            return refuse("aborted");
        const sealed = verifySealed(state);
        if (sealed !== "stable")
            return refuse(sealed);
        const platform = platformRefusal();
        if (platform)
            return refuse(platform);
        const policy = seatbeltPolicy(state);
        for (const name of CANARY_ORDER) {
            if (options.signal?.aborted)
                break;
            canaries.push(await runCanary(state, policy, name, options.signal, timeoutMs));
        }
        if (options.signal?.aborted)
            return refuse("aborted");
        if (!enforcementPassed(canaries))
            return refuse("canary-failed");
        const rechecked = verifySealed(state);
        if (rechecked !== "stable")
            return refuse(rechecked);
        return await launchApprovedTest(collector, selection, state, policy, timeoutMs, options.signal, canaries);
    }
    finally {
        state.running = false;
        if (sealedStates.has(selection))
            closeIsolatedSelection(selection);
    }
}
const CONTROL_SCRIPT = `import { readFileSync, writeFileSync } from "node:fs";
const target = process.argv[2];
const sealed = process.argv[3];
writeFileSync(target, "control", { mode: 0o600 });
if (readFileSync(target, "utf8") !== "control") process.exit(3);
if (readFileSync(sealed).length === 0) process.exit(3);
process.stdout.write("CANARY-CONTROL-OK\\n");
`;
const READ_SCRIPT = `import { readFileSync } from "node:fs";
try {
  readFileSync(process.argv[2]);
  process.exit(2);
} catch (error) {
  const code = error && typeof error === "object" ? error.code : "";
  if (code === "EPERM" || code === "EACCES") {
    process.stdout.write("DENIED:" + code + "\\n");
    process.exit(0);
  }
  process.exit(3);
}
`;
const WRITE_SCRIPT = `import { writeFileSync } from "node:fs";
try {
  writeFileSync(process.argv[2], "denied-write", { flag: "a" });
  process.exit(2);
} catch (error) {
  const code = error && typeof error === "object" ? error.code : "";
  if (code === "EPERM" || code === "EACCES") {
    process.stdout.write("DENIED:" + code + "\\n");
    process.exit(0);
  }
  process.exit(3);
}
`;
const NETWORK_SCRIPT = `import { createServer, connect } from "node:net";
const timer = setTimeout(() => process.exit(4), 3000);
const denied = (start) => new Promise((resolve) => {
  const error = (e) => resolve(e?.code === "EPERM" || e?.code === "EACCES");
  try { start(error, () => resolve(false)); } catch (e) { error(e); }
});
const results = await Promise.all([
  denied((error, allowed) => createServer().once("error", error).listen(0, "127.0.0.1", allowed)),
  denied((error, allowed) => createServer().once("error", error).listen(process.argv[2], allowed)),
  denied((error, allowed) => connect({host:"127.0.0.1", port:9}).once("error", error).once("connect", allowed)),
]);
clearTimeout(timer);
if (results.every(Boolean)) {
  process.stdout.write("DENIED:EPERM\\n");
  process.exit(0);
}
process.exit(2);
`;
const EXEC_SCRIPT = `import { spawnSync } from "node:child_process";
const other = process.argv[2];
const pinned = process.argv[3];
const attempts = [
  spawnSync(other, [], { stdio: "ignore" }),
  spawnSync(pinned, ["-e", "process.exit(0)"], { stdio: "ignore" }),
];
const denied = attempts.every((result) => {
  const code = result.error && result.error.code;
  return code === "EPERM" || code === "EACCES";
});
if (denied) {
  process.stdout.write("DENIED:EPERM\\n");
  process.exit(0);
}
process.exit(2);
`;
const CANARY_SOURCES = Object.freeze({
    control: CONTROL_SCRIPT,
    read: READ_SCRIPT,
    write: WRITE_SCRIPT,
    network: NETWORK_SCRIPT,
    exec: EXEC_SCRIPT,
});
const CANARY_ORDER = Object.freeze([
    "control",
    "read",
    "write",
    "network",
    "exec",
]);
function profileDigest(profile) {
    const hash = createHash("sha256").update(JSON.stringify([
        ISOLATED_RUNNER_PROFILE,
        ISOLATED_COMMAND_CLASS,
        profile.profileId,
        profile.test,
        ISOLATED_TEST_ARGV,
        PINNED_NODE_SHA256,
    ]));
    for (const entry of [...profile.files].sort((left, right) => left.path.localeCompare(right.path)))
        hash.update(entry.path).update("\0").update(entry.digest).update("\0");
    return hash.digest("hex");
}
function sealTree(path) {
    const info = lstatSync(path);
    if (info.isDirectory()) {
        for (const name of readdirSync(path))
            sealTree(join(path, name));
        chmodSync(path, 0o500);
    }
    else {
        chmodSync(path, 0o400);
    }
}
function removeBase(path) {
    try {
        makeRemovable(path);
        rmSync(path, { recursive: true, force: true });
    }
    catch { }
}
function makeRemovable(path) {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) {
        unlinkSync(path);
        return;
    }
    if (info.isDirectory()) {
        chmodSync(path, 0o700);
        for (const name of readdirSync(path))
            makeRemovable(join(path, name));
    }
    else {
        chmodSync(path, 0o600);
    }
}
function verifySealed(state) {
    try {
        if (!sourceStable(state))
            return "source-changed";
        const manifest = JSON.stringify({
            profileId: state.profile.profileId,
            files: state.profile.files.map(({ path, digest }) => ({ path, digest })),
        });
        if (readOwnedBytes(state.manifestPath).toString() !== manifest)
            return "sealed-manifest-changed";
        if (!sameIdentity(state.sealed, state.sealedIdentity))
            return "sealed-root-changed";
        const root = lstatSync(state.sealed);
        if (!root.isDirectory() || (root.mode & 0o077) !== 0)
            return "sealed-root-changed";
        for (const entry of state.profile.files) {
            const path = resolve(state.sealed, entry.path);
            if (!isInside(state.sealed, path))
                return "sealed-manifest-changed";
            let info;
            try {
                info = lstatSync(path);
            }
            catch {
                return "sealed-manifest-changed";
            }
            if (info.isSymbolicLink() ||
                !info.isFile() ||
                info.uid !== uid() ||
                (info.mode & 0o022) !== 0)
                return "sealed-manifest-changed";
            if (realpathSync(path) !== path)
                return "sealed-manifest-changed";
            if (sha256(readOwnedBytes(path)) !== entry.digest)
                return "sealed-manifest-changed";
        }
        return "stable";
    }
    catch {
        return "sealed-unverified";
    }
}
function platformRefusal() {
    if (process.platform !== "darwin")
        return "unsupported-platform";
    try {
        const sandbox = lstatSync(SANDBOX_EXEC);
        if (sandbox.isSymbolicLink() ||
            !sandbox.isFile() ||
            sandbox.uid !== 0 ||
            (sandbox.mode & 0o022) !== 0)
            return "sandbox-unavailable";
        accessSync(SANDBOX_EXEC, constants.X_OK);
    }
    catch {
        return "sandbox-unavailable";
    }
    try {
        const node = lstatSync(PINNED_NODE_EXECUTABLE);
        if (node.isSymbolicLink() || !node.isFile())
            return "pinned-node-unavailable";
        if (node.uid !== uid() ||
            (node.mode & 0o022) !== 0 ||
            realpathSync(PINNED_NODE_EXECUTABLE) !== PINNED_NODE_EXECUTABLE)
            return "pinned-node-unsafe";
        accessSync(PINNED_NODE_EXECUTABLE, constants.X_OK);
        const fd = openSync(PINNED_NODE_EXECUTABLE, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const hash = createHash("sha256");
            const buffer = Buffer.alloc(65536);
            let count;
            while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0)
                hash.update(buffer.subarray(0, count));
            if (hash.digest("hex") !== PINNED_NODE_SHA256)
                return "pinned-node-unsafe";
        }
        finally {
            closeSync(fd);
        }
    }
    catch {
        return "pinned-node-unavailable";
    }
    return null;
}
function seatbeltPolicy(state) {
    const metadata = new Set();
    for (const path of [PINNED_NODE_EXECUTABLE, state.sealed, state.scratch])
        for (const ancestor of ancestors(path))
            metadata.add(ancestor);
    // Exact read literals: the measured platform minimum plus the approved
    // snapshot closure, its ancestor directories, and the owned canary files.
    // No project, home, or broad subpath read is granted.
    const sealedReads = new Set([state.sealed]);
    for (const entry of state.profile.files) {
        let current = state.sealed;
        for (const part of entry.path.split("/")) {
            current = join(current, part);
            sealedReads.add(current);
        }
    }
    const scratchReads = [
        state.scratch,
        state.ownedTrue,
        join(state.scratch, "control-ok"),
        ...Object.keys(CANARY_SOURCES).map((name) => join(state.scratch, `${name}.mjs`)),
    ];
    const reads = [
        pathLiteral("/"),
        `(subpath ${literal("/System/Library")})`,
        `(subpath ${literal("/usr/lib")})`,
        pathLiteral("/dev/null"),
        pathLiteral("/dev/urandom"),
        pathLiteral(PINNED_NODE_EXECUTABLE),
        ...[...sealedReads].map(pathLiteral),
        ...scratchReads.map(pathLiteral),
    ];
    const metadataRules = [...metadata].map(pathLiteral).join(" ");
    return [
        "(version 1)",
        "(deny default)",
        "(deny process-fork)",
        "(deny network*)",
        `(allow process-exec (literal ${literal(PINNED_NODE_EXECUTABLE)}))`,
        "(allow signal (target self))",
        "(allow sysctl-read)",
        `(allow file-read* ${reads.join(" ")})`,
        `(allow file-read-metadata ${metadataRules})`,
        `(allow file-write* (subpath ${literal(state.scratch)}))`,
        `(deny file-write* (subpath ${literal(state.sealed)}) (literal ${literal(state.manifestPath)}) (literal ${literal(state.protectedTarget)}))`,
    ].join("\n");
}
function childEnvironment() {
    return Object.freeze({ LANG: "C", LC_ALL: "C", TZ: "UTC" });
}
function killTree(child, signal) {
    if (child.pid === undefined)
        return;
    try {
        process.kill(-child.pid, signal);
    }
    catch {
        try {
            child.kill(signal);
        }
        catch { }
    }
}
function canaryArgs(state, name) {
    switch (name) {
        case "control":
            return [
                join(state.scratch, "control-ok"),
                join(state.sealed, state.profile.test),
            ];
        case "read":
            return [join(state.outside, "secret.txt")];
        case "write":
            return [state.protectedTarget];
        case "network":
            // Relative to sealed cwd: avoid AF_UNIX's short sockaddr path limit.
            return ["../scratch/denied.sock"];
        case "exec":
            return [state.ownedTrue, PINNED_NODE_EXECUTABLE];
    }
}
async function runCanary(state, policy, name, outer, timeoutMs) {
    const child = spawn(SANDBOX_EXEC, [
        "-p",
        policy,
        PINNED_NODE_EXECUTABLE,
        join(state.scratch, `${name}.mjs`),
        ...canaryArgs(state, name),
    ], {
        cwd: state.sealed,
        env: childEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        detached: true,
    });
    let text = "", kept = 0;
    let timedOut = false, aborted = false, overflow = false, diagnosticBytes = 0, launchError = false;
    child.stdout?.on("data", (chunk) => {
        if (kept + chunk.length > ISOLATED_CANARY_OUTPUT_LIMIT) {
            overflow = true;
            killTree(child, "SIGKILL");
        }
        if (kept >= ISOLATED_CANARY_OUTPUT_LIMIT)
            return;
        const room = ISOLATED_CANARY_OUTPUT_LIMIT - kept;
        const part = chunk.subarray(0, room);
        text += part.toString();
        kept += part.length;
    });
    child.stderr?.on("data", (chunk) => {
        diagnosticBytes += chunk.length;
        if (diagnosticBytes > ISOLATED_CANARY_OUTPUT_LIMIT) {
            overflow = true;
            killTree(child, "SIGKILL");
        }
    });
    const exit = await new Promise((done) => {
        let settled = false;
        let timer;
        let killTimer;
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            if (killTimer)
                clearTimeout(killTimer);
            outer?.removeEventListener("abort", cancel);
            done(value);
        };
        const cancel = () => {
            aborted = true;
            killTree(child, "SIGKILL");
        };
        timer = setTimeout(() => {
            timedOut = true;
            killTree(child, "SIGTERM");
            killTimer = setTimeout(() => killTree(child, "SIGKILL"), 1000);
        }, Math.min(ISOLATED_CANARY_TIMEOUT_MS, timeoutMs));
        outer?.addEventListener("abort", cancel, { once: true });
        if (outer?.aborted)
            cancel();
        child.once("error", () => {
            launchError = true;
        });
        child.once("close", (code, signal) => finish({ code, signal, error: launchError }));
    });
    const line = text.trim();
    const outcome = timedOut
        ? "timeout"
        : aborted || overflow || exit.error || exit.code !== 0
            ? "error"
            : name === "control"
                ? line === "CANARY-CONTROL-OK"
                    ? "control-ok"
                    : "error"
                : /^DENIED:(?:EPERM|EACCES)$/.test(line)
                    ? "denied"
                    : "allowed";
    return Object.freeze({ name, outcome });
}
function enforcementPassed(canaries) {
    const control = canaries.find((canary) => canary.name === "control");
    return (canaries.length === CANARY_ORDER.length &&
        control?.outcome === "control-ok" &&
        canaries
            .filter((canary) => canary.name !== "control")
            .every((canary) => canary.outcome === "denied"));
}
async function launchApprovedTest(collector, selection, state, policy, timeoutMs, outer, canaries) {
    const child = spawn(SANDBOX_EXEC, [
        "-p",
        policy,
        PINNED_NODE_EXECUTABLE,
        ...ISOLATED_TEST_ARGV,
        state.profile.test,
    ], {
        cwd: state.sealed,
        env: childEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        detached: true,
    });
    const parts = [];
    let outputBytes = 0, kept = 0, stderrBytes = 0, stderrLines = 0, stderrTruncated = false, truncated = false, timedOut = false, aborted = false, launchError = false;
    child.stdout?.on("data", (chunk) => {
        outputBytes += chunk.length;
        if (kept >= ISOLATED_OUTPUT_LIMIT) {
            truncated = true;
            killTree(child, "SIGKILL");
            return;
        }
        const room = ISOLATED_OUTPUT_LIMIT - kept;
        if (chunk.length > room) {
            parts.push(chunk.subarray(0, room));
            kept += room;
            truncated = true;
            killTree(child, "SIGKILL");
        }
        else {
            parts.push(chunk);
            kept += chunk.length;
        }
    });
    child.stderr?.on("data", (chunk) => {
        stderrBytes += chunk.length;
        for (const byte of chunk)
            if (byte === 10)
                stderrLines++;
        // Diagnostics are observed as bounded metadata, never stored or echoed.
        // A benign runtime warning is not stdout truncation and is not silently
        // dropped; an oversized diagnostic stream is the only stderr loss.
        if (stderrBytes > ISOLATED_OUTPUT_LIMIT) {
            stderrTruncated = true;
            killTree(child, "SIGKILL");
        }
    });
    const exit = await new Promise((done) => {
        let settled = false;
        let timer;
        let killTimer;
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            if (killTimer)
                clearTimeout(killTimer);
            outer?.removeEventListener("abort", cancel);
            done(value);
        };
        const cancel = () => {
            aborted = true;
            killTree(child, "SIGKILL");
        };
        timer = setTimeout(() => {
            timedOut = true;
            killTree(child, "SIGTERM");
            killTimer = setTimeout(() => killTree(child, "SIGKILL"), 1000);
        }, timeoutMs);
        outer?.addEventListener("abort", cancel, { once: true });
        if (outer?.aborted)
            cancel();
        child.once("error", () => {
            launchError = true;
        });
        child.once("close", (code, signal) => finish({ code, signal, error: launchError }));
    });
    const output = Buffer.concat(parts).toString("utf8");
    const parsed = parseTap(output);
    const integrity = verifySealed(state) === "stable" ? "stable" : "changed";
    let gap = false;
    try {
        gap = collector.hasGap();
    }
    catch {
        gap = true;
    }
    const completed = !exit.error && !timedOut && !aborted && exit.code !== null;
    state.running = false;
    const filesCleanup = closeIsolatedSelection(selection);
    let groupAbsent = child.pid === undefined;
    if (child.pid !== undefined) {
        try {
            process.kill(-child.pid, 0);
        }
        catch (error) {
            groupAbsent = error.code === "ESRCH";
        }
    }
    const cleanup = Object.freeze({
        ...filesCleanup,
        verified: filesCleanup.verified && groupAbsent,
        reason: groupAbsent ? filesCleanup.reason : "process-group-remains",
    });
    const loss = truncated ||
        stderrTruncated ||
        timedOut ||
        aborted ||
        exit.error ||
        integrity !== "stable" ||
        gap ||
        !cleanup.verified;
    const observation = Object.freeze({
        runnerProfile: ISOLATED_RUNNER_PROFILE,
        commandClass: ISOLATED_COMMAND_CLASS,
        profileId: state.profile.profileId,
        scopeId: `isolated-${state.selectionDigest}`,
        selectionDigest: state.selectionDigest,
        testDigest: state.profile.files.find((entry) => entry.path === state.profile.test)
            ?.digest ?? null,
        executableProfile: PINNED_NODE_LABEL,
        argvProfile: ISOLATED_TEST_ARGV,
        fileCount: state.profile.files.length,
        testCount: 1,
        supported: true,
        launched: true,
        refusedReason: null,
        aborted,
        timedOut,
        completed,
        exitCode: exit.code,
        signal: exit.signal,
        tests: parsed.tests,
        pass: parsed.pass,
        fail: parsed.fail,
        cancelled: parsed.cancelled,
        skipped: parsed.skipped,
        todo: parsed.todo,
        fullOutput: parsed.fullOutput && !truncated,
        outputBytes,
        outputTruncated: truncated,
        stderrBytes,
        stderrLines,
        stderrTruncated,
        loss,
        integrity,
        coverage: completed && integrity === "stable" ? "isolated" : "unproven",
        canaries: Object.freeze([...canaries]),
        cleanup,
        claim: null,
    });
    observations.set(observation, { state, time: performance.now() });
    return observation;
}
function sourceStable(state) {
    try {
        return (sameIdentity(state.source, state.sourceIdentity) &&
            realpathSync(state.source) === state.source &&
            state.profile.files.every(({ path, digest }) => {
                const file = join(state.source, path);
                return (realpathSync(file) === file && sha256(readOwnedBytes(file)) === digest);
            }));
    }
    catch {
        return false;
    }
}
// A JSON receipt is data, never authority. Claims require the original
// in-process observation, its collector, a fresh monotonic age and live source.
export function isCurrentIsolatedObservation(collector, observation) {
    const owned = observations.get(observation);
    try {
        return Boolean(owned &&
            owned.state.collector === collector &&
            performance.now() - owned.time <= 30000 &&
            sourceStable(owned.state) &&
            !collector.hasGap());
    }
    catch {
        return false;
    }
}
function refusedObservation(reason, fields) {
    return Object.freeze({
        runnerProfile: ISOLATED_RUNNER_PROFILE,
        commandClass: ISOLATED_COMMAND_CLASS,
        profileId: fields.profileId,
        scopeId: fields.profileId === null ? "isolated-unowned" : ISOLATED_SCOPE_ID,
        selectionDigest: fields.selectionDigest,
        testDigest: fields.testDigest,
        executableProfile: PINNED_NODE_LABEL,
        argvProfile: ISOLATED_TEST_ARGV,
        fileCount: fields.fileCount,
        testCount: 0,
        supported: fields.supported,
        launched: false,
        refusedReason: reason,
        aborted: fields.aborted ?? false,
        timedOut: false,
        completed: false,
        exitCode: null,
        signal: null,
        tests: 0,
        pass: 0,
        fail: 0,
        cancelled: 0,
        skipped: 0,
        todo: 0,
        fullOutput: false,
        outputBytes: 0,
        outputTruncated: false,
        stderrBytes: 0,
        stderrLines: 0,
        stderrTruncated: false,
        loss: true,
        integrity: "unverified",
        coverage: "unproven",
        canaries: Object.freeze([...(fields.canaries ?? [])]),
        cleanup: fields.cleanup ?? NOT_OWNED_CLEANUP,
        claim: null,
    });
}
export const ARM_ISOLATED_PROFILE = createIsolatedProfile({
    profileId: ISOLATED_PROFILE_ID,
    test: ISOLATED_TEST_FILE,
    files: [
        {
            path: "tests/unit/token-estimate.test.ts",
            digest: "f428f210e5eddb4f3d63a1c45c6d76dcca3096382403960105f4ec6f24c048fc",
        },
        {
            path: "src/contracts.ts",
            digest: "9983c30fe5a5a0fe29e1f2b5613beebfa153c6bc392ac5d00b3ab73d13f64362",
        },
        {
            path: "src/modules/orders/public.ts",
            digest: "6f17f9f0acf62887e2ba3ead71925d2e0e27daeb74e088860e7b6c061e5a01aa",
        },
        {
            path: "src/modules/orders/service.ts",
            digest: "236ef8f255bf8062fe3b0ae05bf7cec7dbc655b548c69afed26e1bd0263944dd",
        },
        {
            path: "src/modules/orders/token-estimate.ts",
            digest: "ea19338ce9da7fbb4448492901e3770903d03b8a885993a810d5657ef64c0288",
        },
        {
            path: "src/modules/orders/adapters/sqlite.ts",
            digest: "77b50ef477288d45e7ac4aef1232cb69a6902a4e7add798873af804235295e45",
        },
        {
            path: "src/modules/matching/adapters/sqlite.ts",
            digest: "c9a2dd1fe9b4c90b28c27b5301c3ede7da10daaebe70fc7ed8e32760f18e526a",
        },
        {
            path: "src/modules/accounts/public.ts",
            digest: "78fbb461fa979bd77e99239253b8289fbae66cafa2b6484c366503f003370336",
        },
        {
            path: "src/modules/accounts/service.ts",
            digest: "1c6c685ef0c17aab3e997f142257b2f5721194e04953f0675c4fb18c6ee5339d",
        },
        {
            path: "src/execution/receipt.ts",
            digest: "9257deedbfd93827bac1502d723338c7d23184ec3e26b525d42d8bf1d025d2ce",
        },
        {
            path: "src/execution/spec.ts",
            digest: "a410c50360ab55e2f5fece007e625fe030c43a86d3464ed935633d762efaea81",
        },
        {
            path: "src/execution/policy.ts",
            digest: "c8cb816b7fbe53680557b3ce02dbcc2578b18f4ea1fca1b115b41325d54a6023",
        },
        {
            path: "src/execution/supervisor.ts",
            digest: "47da40f17d1373a7176bd4e39f4c18f0f5cfe61b9a58212f0e255bb40515e953",
        },
        {
            path: "src/execution/spec-child.ts",
            digest: "3ae75fa047e28f838b36fe3fef688af62b8e968572a90388a2ec773be42afcc8",
        },
        {
            path: "src/platform/config.ts",
            digest: "1764dbe9baf857350429cd8270698511e7a6462f3026a322be1e73d886d1fdd0",
        },
        {
            path: "src/providers/public.ts",
            digest: "bc5024758dd09bc255da3c0a4a5a4de329d63896212518fe855a79a61707624b",
        },
        {
            path: "package.json",
            digest: "a9aaadf59ba06e77b36bbccc687c826f5848e3a432503b254c8826520e5aaa02",
        },
    ],
});
