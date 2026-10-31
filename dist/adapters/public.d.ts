import { z } from "zod";
import { Collector } from "../collector/public.ts";
import type { SelectedScope, IsolatedObservation } from "../collector/public.ts";
import type { Event, Evidence } from "../core/public.ts";
/**
 * Generic host envelope for any coding agent that is not Claude Code or Codex.
 * It carries only the observation itself: a claim's text is classified and
 * discarded, and no evidence is accepted. A host cannot certify its own work,
 * so generic claims stay `unknown` in judgement and only the collector's own
 * approved test runs can produce stronger verdicts.
 */
export declare const genericHostSchema: z.ZodObject<{
    kind: z.ZodEnum<{
        error: "error";
        claim: "claim";
        "test-edit": "test-edit";
        health: "health";
    }>;
    hostVersion: z.ZodOptional<z.ZodString>;
    runId: z.ZodOptional<z.ZodString>;
    turnId: z.ZodOptional<z.ZodString>;
    claim: z.ZodOptional<z.ZodObject<{
        role: z.ZodString;
        text: z.ZodString;
    }, z.core.$strict>>;
    error: z.ZodOptional<z.ZodObject<{
        class: z.ZodEnum<{
            "test-failed": "test-failed";
            "tool-failed": "tool-failed";
        }>;
        progress: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>;
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
export declare function genericEvent(raw: unknown, host: string, collector: Collector, sequence: number): Event | null;
export declare function normalizeHost(raw: unknown, host: string, collector: Collector, sequence: number, context?: HostContext): Event | null;
export declare function claudeSetup(project: string, collectorDir: string, cliPath: string, apply?: boolean, uninstall?: boolean): {
    file: string;
    operation: string;
    events: string[];
    delivery: string;
    requiresExplicitApply: boolean;
};
