#!/usr/bin/env node
import { spawn } from "node:child_process";
import { Collector } from "./public.ts";
import type { SelectedScope } from "./public.ts";
export declare function validateCodexArgs(args: string[]): string[];
export declare function runCodex(collector: Collector, scope: SelectedScope, supplied: string[], probe?: boolean, launch?: typeof spawn): Promise<{
    hostVersion: string;
    versionKnown: boolean;
    processExitCode: number | null;
    events: number;
    loss: boolean;
    digest: {
        before: string | null;
        after: string | null;
        changed: boolean;
    };
    coverage: "unproven";
    coverageReason: string;
}>;
export declare function main(args?: string[]): Promise<void>;
