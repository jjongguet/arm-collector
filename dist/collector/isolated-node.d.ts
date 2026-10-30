import type { Collector } from "./public.ts";
export declare const ISOLATED_RUNNER_PROFILE: "NODE_TAP_ISOLATED_V1";
export declare const ISOLATED_COMMAND_CLASS: "approved-isolated-node-test";
export declare const ISOLATED_PROFILE_ID: "arm-atm-98b5cfc-node-24.15.0-seatbelt-v1";
export declare const ISOLATED_TEST_FILE: "tests/unit/token-estimate.test.ts";
export declare const ISOLATED_SCOPE_ID: "isolated-arm-atm";
export declare const PINNED_NODE_EXECUTABLE: string;
export declare const PINNED_NODE_SHA256 = "3200fbd9f7fd4410426dd541e10d1ab829d3472f270d743c7fabd1696c03fe32";
export declare const PINNED_NODE_LABEL: "node-24.15.0-pinned";
export declare const SANDBOX_EXEC: "/usr/bin/sandbox-exec";
export declare const ISOLATED_TEST_ARGV: readonly string[];
export declare const ISOLATED_OUTPUT_LIMIT = 262144;
export declare const ISOLATED_CANARY_OUTPUT_LIMIT = 4096;
export declare const ISOLATED_TIMEOUT_MS = 60000;
export declare const ISOLATED_CANARY_TIMEOUT_MS = 5000;
export declare const ISOLATED_MIN_TIMEOUT_MS = 100;
export declare const ISOLATED_MAX_TIMEOUT_MS = 120000;
export type IsolatedManifestEntry = {
    readonly path: string;
    readonly digest: string;
};
export type IsolatedProfile = {
    readonly profileId: string;
    readonly test: string;
    readonly files: readonly IsolatedManifestEntry[];
};
export type IsolatedSelection = {
    readonly profileId: string;
    readonly sourceRoot: string;
    readonly sealedRoot: string;
    readonly scratchRoot: string;
    readonly manifestPath: string;
    readonly profile: IsolatedProfile;
};
export type IsolatedRefusalCode = "profile-invalid" | "profile-unowned" | "root-unavailable" | "root-symlink" | "root-not-directory" | "root-not-owned" | "root-not-private" | "root-not-canonical" | "manifest-missing" | "manifest-symlink" | "manifest-unsafe" | "manifest-mismatch" | "manifest-too-large" | "canary-setup-failed" | "invalid-timeout";
export type IsolatedRefusedReason = "unowned-selection" | "selection-busy" | "source-changed" | "unsupported-platform" | "sandbox-unavailable" | "pinned-node-unavailable" | "pinned-node-unsafe" | "sealed-root-changed" | "sealed-manifest-changed" | "sealed-unverified" | "canary-failed" | "aborted";
export type IsolatedCanaryName = "control" | "read" | "write" | "network" | "exec";
export type IsolatedCanaryOutcome = "control-ok" | "denied" | "allowed" | "error" | "timeout";
export type IsolatedCanary = {
    readonly name: IsolatedCanaryName;
    readonly outcome: IsolatedCanaryOutcome;
};
export type IsolatedCleanup = {
    readonly verified: boolean;
    readonly removed: boolean;
    readonly reason: string | null;
};
export type IsolatedRunOptions = {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
};
export type IsolatedObservation = {
    readonly runnerProfile: typeof ISOLATED_RUNNER_PROFILE;
    readonly commandClass: typeof ISOLATED_COMMAND_CLASS;
    readonly profileId: string | null;
    readonly scopeId: string;
    readonly selectionDigest: string | null;
    readonly testDigest: string | null;
    readonly executableProfile: typeof PINNED_NODE_LABEL;
    readonly argvProfile: readonly string[];
    readonly fileCount: number;
    readonly testCount: number;
    readonly supported: boolean;
    readonly launched: boolean;
    readonly refusedReason: IsolatedRefusedReason | null;
    readonly aborted: boolean;
    readonly timedOut: boolean;
    readonly completed: boolean;
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly tests: number;
    readonly pass: number;
    readonly fail: number;
    readonly cancelled: number;
    readonly skipped: number;
    readonly todo: number;
    readonly fullOutput: boolean;
    readonly outputBytes: number;
    readonly outputTruncated: boolean;
    readonly stderrBytes: number;
    readonly stderrLines: number;
    readonly stderrTruncated: boolean;
    readonly loss: boolean;
    readonly integrity: "stable" | "changed" | "unverified";
    readonly coverage: "isolated" | "unproven";
    readonly canaries: readonly IsolatedCanary[];
    readonly cleanup: IsolatedCleanup;
    readonly claim: null;
};
export declare class IsolatedRefusal extends Error {
    readonly code: IsolatedRefusalCode;
    constructor(code: IsolatedRefusalCode, message: string);
}
export declare function prepareIsolatedSelection(collector: Collector, root: string): IsolatedSelection;
export declare function closeIsolatedSelection(selection: IsolatedSelection): IsolatedCleanup;
export declare function runIsolatedNodeTest(collector: Collector, selection: IsolatedSelection, options?: IsolatedRunOptions): Promise<IsolatedObservation>;
export declare function isCurrentIsolatedObservation(collector: Collector, observation: IsolatedObservation): boolean;
export declare const ARM_ISOLATED_PROFILE: IsolatedProfile;
