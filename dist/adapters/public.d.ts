import { Collector } from "../collector/public.ts";
import type { SelectedScope, IsolatedObservation } from "../collector/public.ts";
import type { Event, Evidence } from "../core/public.ts";
export declare function isolatedClaimEvent(collector: Collector, observation: IsolatedObservation, claim: string): Event;
export type HostContext = {
    scope: SelectedScope;
    version: string;
    runId: string;
    pending: Map<string, {
        before: string | null;
        sequence: number;
    }>;
    seen: Set<string>;
    latest: Evidence | null;
    latestToolId: string | null;
    turn: number;
    loss: boolean;
};
export declare function hostContext(scope: SelectedScope, version: string, runId: string): HostContext;
export declare function approvedTestCommand(command: unknown, scope: SelectedScope): boolean;
export declare function normalizeHost(raw: unknown, host: "claude-code" | "codex", collector: Collector, sequence: number, context?: HostContext): Event | null;
export declare function claudeSetup(project: string, collectorDir: string, cliPath: string, apply?: boolean, uninstall?: boolean): {
    file: string;
    operation: string;
    events: string[];
    delivery: string;
    requiresExplicitApply: boolean;
};
