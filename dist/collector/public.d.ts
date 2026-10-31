import type { Event } from "../core/public.ts";
export declare class Collector {
    dir: string;
    origin: string | null;
    lostInMemory: number;
    constructor(dir: string);
    locked<T>(fn: () => T): T;
    gap(): void;
    hasGap(): boolean;
    pendingGap(): {
        schemaVersion: 1;
        eventId: string;
        runId: string;
        turnId: string;
        toolCallId: string;
        sequence: number;
        time: number;
        host: string;
        adapterVersion: "1";
        hostVersion: string;
        nodeMajor: number;
        kind: "error" | "claim" | "test-edit" | "health";
        claimClass: "tests-passed" | "none" | "ambiguous";
        errorClass: "none" | "test-failed" | "tool-failed";
        progressFingerprint: string | null;
        evidence: {
            runnerProfile: "NODE_TAP_V1" | "NODE_TAP_ISOLATED_V1" | "unsupported";
            commandClass: "unsupported" | "approved-node-test" | "approved-isolated-node-test";
            exitCode: number | null;
            tests: number;
            pass: number;
            fail: number;
            cancelled: number;
            skipped: number;
            todo: number;
            completed: boolean;
            fullOutput: boolean;
            background: boolean;
            loss: boolean;
            startedSequence: number;
            completedSequence: number;
            scopeId: string;
            coverage: "isolated" | "unproven" | "exceeded";
            before: string | null;
            after: string | null;
            claim: string | null;
        } | null;
    } | null;
    load(): {
        origin: string;
        token: string;
        deviceId: string;
        projectId: string;
        expires: number;
    };
    configure(value: unknown): void;
    spool(): {
        events: {
            schemaVersion: 1;
            eventId: string;
            runId: string;
            turnId: string;
            toolCallId: string;
            sequence: number;
            time: number;
            host: string;
            adapterVersion: "1";
            hostVersion: string;
            nodeMajor: number;
            kind: "error" | "claim" | "test-edit" | "health";
            claimClass: "tests-passed" | "none" | "ambiguous";
            errorClass: "none" | "test-failed" | "tool-failed";
            progressFingerprint: string | null;
            evidence: {
                runnerProfile: "NODE_TAP_V1" | "NODE_TAP_ISOLATED_V1" | "unsupported";
                commandClass: "unsupported" | "approved-node-test" | "approved-isolated-node-test";
                exitCode: number | null;
                tests: number;
                pass: number;
                fail: number;
                cancelled: number;
                skipped: number;
                todo: number;
                completed: boolean;
                fullOutput: boolean;
                background: boolean;
                loss: boolean;
                startedSequence: number;
                completedSequence: number;
                scopeId: string;
                coverage: "isolated" | "unproven" | "exceeded";
                before: string | null;
                after: string | null;
                claim: string | null;
            } | null;
        }[];
        lost: number;
        failures: number;
        retryAt: number;
    };
    enqueue(raw: unknown): boolean;
    report(): {
        queued: number;
        lost: number;
        failures: number;
        retryAt: number;
        coverage: string;
        reauthRequired: boolean;
        findings: (import("../core/public.ts").Finding | null)[];
    };
    flush(signal?: AbortSignal): Promise<void>;
    /**
     * Idempotent disconnect. A directory that was never paired (or was already
     * disconnected) still has its owned local state removed and reports why no
     * remote call happened; an expired or revoked credential counts as denied.
     */
    disconnect(): Promise<{
        disconnected: true;
        remote: "invalidated" | "already-denied" | "not-paired";
    }>;
    /** Stable status receipt: connection identity and queue state, never a token. */
    statusReceipt(): {
        queued: number;
        lost: number;
        failures: number;
        retryAt: number;
        coverage: string;
        reauthRequired: boolean;
        findings: (import("../core/public.ts").Finding | null)[];
        paired: true;
        origin: string;
        deviceId: string;
        projectId: string;
        expires: number;
    } | {
        queued: number;
        lost: number;
        failures: number;
        retryAt: number;
        coverage: string;
        reauthRequired: boolean;
        findings: (import("../core/public.ts").Finding | null)[];
        paired: false;
        origin: null;
    };
    key(): NonSharedBuffer;
    private sequences;
    nextSequence(runId: string): number;
    snapshot(root: string, files: string[]): string | null;
}
export declare function approvedOrigin(value: string): string;
export declare function request(origin: string, path: "/api/pairing" | "/api/pairing/redeem" | "/api/ingest" | "/api/disconnect" | "/api/rotate", body: unknown, token?: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
export declare function baseEvent(host: Event["host"], runId: string, sequence: number): Event;
export declare function observeNodeTest(collector: Collector, root: string, files: string[], scope: string[], isolated: boolean | SelectedScope): Promise<{
    runnerProfile: "NODE_TAP_V1" | "NODE_TAP_ISOLATED_V1" | "unsupported";
    commandClass: "unsupported" | "approved-node-test" | "approved-isolated-node-test";
    exitCode: number | null;
    tests: number;
    pass: number;
    fail: number;
    cancelled: number;
    skipped: number;
    todo: number;
    completed: boolean;
    fullOutput: boolean;
    background: boolean;
    loss: boolean;
    startedSequence: number;
    completedSequence: number;
    scopeId: string;
    coverage: "isolated" | "unproven" | "exceeded";
    before: string | null;
    after: string | null;
    claim: string | null;
}>;
export type SelectedScope = {
    root: string;
    files: string[];
    tests: string[];
};
export declare function createOwnedFixture(passing?: boolean): {
    scope: SelectedScope;
    close(): void;
};
export declare function isOwnedFixture(scope: SelectedScope): boolean;
export declare function collectorWorker(collector: Collector, signal: AbortSignal, interval?: number): Promise<void>;
export { ARM_ISOLATED_PROFILE, ISOLATED_COMMAND_CLASS, ISOLATED_OUTPUT_LIMIT, ISOLATED_PROFILE_ID, ISOLATED_RUNNER_PROFILE, ISOLATED_SCOPE_ID, ISOLATED_TEST_ARGV, ISOLATED_TEST_FILE, ISOLATED_TIMEOUT_MS, IsolatedRefusal, PINNED_NODE_EXECUTABLE, PINNED_NODE_LABEL, SANDBOX_EXEC, closeIsolatedSelection, isCurrentIsolatedObservation, prepareIsolatedSelection, runIsolatedNodeTest, } from "./isolated-node.ts";
export type { IsolatedCanary, IsolatedCanaryName, IsolatedCanaryOutcome, IsolatedCleanup, IsolatedManifestEntry, IsolatedObservation, IsolatedProfile, IsolatedRefusalCode, IsolatedRefusedReason, IsolatedRunOptions, IsolatedSelection, } from "./isolated-node.ts";
