import { z } from "zod";
export declare const evidenceSchema: z.ZodObject<{
    runnerProfile: z.ZodEnum<{
        NODE_TAP_V1: "NODE_TAP_V1";
        NODE_TAP_ISOLATED_V1: "NODE_TAP_ISOLATED_V1";
        unsupported: "unsupported";
    }>;
    commandClass: z.ZodEnum<{
        unsupported: "unsupported";
        "approved-node-test": "approved-node-test";
        "approved-isolated-node-test": "approved-isolated-node-test";
    }>;
    exitCode: z.ZodNullable<z.ZodNumber>;
    tests: z.ZodNumber;
    pass: z.ZodNumber;
    fail: z.ZodNumber;
    cancelled: z.ZodNumber;
    skipped: z.ZodNumber;
    todo: z.ZodNumber;
    completed: z.ZodBoolean;
    fullOutput: z.ZodBoolean;
    background: z.ZodBoolean;
    loss: z.ZodBoolean;
    startedSequence: z.ZodNumber;
    completedSequence: z.ZodNumber;
    scopeId: z.ZodString;
    coverage: z.ZodEnum<{
        isolated: "isolated";
        unproven: "unproven";
        exceeded: "exceeded";
    }>;
    before: z.ZodNullable<z.ZodString>;
    after: z.ZodNullable<z.ZodString>;
    claim: z.ZodNullable<z.ZodString>;
}, z.core.$strict>;
export declare const eventSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    eventId: z.ZodUUID;
    runId: z.ZodString;
    turnId: z.ZodString;
    toolCallId: z.ZodString;
    sequence: z.ZodNumber;
    time: z.ZodNumber;
    host: z.ZodEnum<{
        "claude-code": "claude-code";
        codex: "codex";
        fixture: "fixture";
    }>;
    adapterVersion: z.ZodLiteral<"1">;
    hostVersion: z.ZodString;
    nodeMajor: z.ZodNumber;
    kind: z.ZodEnum<{
        error: "error";
        claim: "claim";
        "test-edit": "test-edit";
        health: "health";
    }>;
    claimClass: z.ZodEnum<{
        "tests-passed": "tests-passed";
        none: "none";
        ambiguous: "ambiguous";
    }>;
    errorClass: z.ZodEnum<{
        none: "none";
        "test-failed": "test-failed";
        "tool-failed": "tool-failed";
    }>;
    progressFingerprint: z.ZodNullable<z.ZodString>;
    evidence: z.ZodNullable<z.ZodObject<{
        runnerProfile: z.ZodEnum<{
            NODE_TAP_V1: "NODE_TAP_V1";
            NODE_TAP_ISOLATED_V1: "NODE_TAP_ISOLATED_V1";
            unsupported: "unsupported";
        }>;
        commandClass: z.ZodEnum<{
            unsupported: "unsupported";
            "approved-node-test": "approved-node-test";
            "approved-isolated-node-test": "approved-isolated-node-test";
        }>;
        exitCode: z.ZodNullable<z.ZodNumber>;
        tests: z.ZodNumber;
        pass: z.ZodNumber;
        fail: z.ZodNumber;
        cancelled: z.ZodNumber;
        skipped: z.ZodNumber;
        todo: z.ZodNumber;
        completed: z.ZodBoolean;
        fullOutput: z.ZodBoolean;
        background: z.ZodBoolean;
        loss: z.ZodBoolean;
        startedSequence: z.ZodNumber;
        completedSequence: z.ZodNumber;
        scopeId: z.ZodString;
        coverage: z.ZodEnum<{
            isolated: "isolated";
            unproven: "unproven";
            exceeded: "exceeded";
        }>;
        before: z.ZodNullable<z.ZodString>;
        after: z.ZodNullable<z.ZodString>;
        claim: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const batchSchema: z.ZodObject<{
    events: z.ZodArray<z.ZodObject<{
        schemaVersion: z.ZodLiteral<1>;
        eventId: z.ZodUUID;
        runId: z.ZodString;
        turnId: z.ZodString;
        toolCallId: z.ZodString;
        sequence: z.ZodNumber;
        time: z.ZodNumber;
        host: z.ZodEnum<{
            "claude-code": "claude-code";
            codex: "codex";
            fixture: "fixture";
        }>;
        adapterVersion: z.ZodLiteral<"1">;
        hostVersion: z.ZodString;
        nodeMajor: z.ZodNumber;
        kind: z.ZodEnum<{
            error: "error";
            claim: "claim";
            "test-edit": "test-edit";
            health: "health";
        }>;
        claimClass: z.ZodEnum<{
            "tests-passed": "tests-passed";
            none: "none";
            ambiguous: "ambiguous";
        }>;
        errorClass: z.ZodEnum<{
            none: "none";
            "test-failed": "test-failed";
            "tool-failed": "tool-failed";
        }>;
        progressFingerprint: z.ZodNullable<z.ZodString>;
        evidence: z.ZodNullable<z.ZodObject<{
            runnerProfile: z.ZodEnum<{
                NODE_TAP_V1: "NODE_TAP_V1";
                NODE_TAP_ISOLATED_V1: "NODE_TAP_ISOLATED_V1";
                unsupported: "unsupported";
            }>;
            commandClass: z.ZodEnum<{
                unsupported: "unsupported";
                "approved-node-test": "approved-node-test";
                "approved-isolated-node-test": "approved-isolated-node-test";
            }>;
            exitCode: z.ZodNullable<z.ZodNumber>;
            tests: z.ZodNumber;
            pass: z.ZodNumber;
            fail: z.ZodNumber;
            cancelled: z.ZodNumber;
            skipped: z.ZodNumber;
            todo: z.ZodNumber;
            completed: z.ZodBoolean;
            fullOutput: z.ZodBoolean;
            background: z.ZodBoolean;
            loss: z.ZodBoolean;
            startedSequence: z.ZodNumber;
            completedSequence: z.ZodNumber;
            scopeId: z.ZodString;
            coverage: z.ZodEnum<{
                isolated: "isolated";
                unproven: "unproven";
                exceeded: "exceeded";
            }>;
            before: z.ZodNullable<z.ZodString>;
            after: z.ZodNullable<z.ZodString>;
            claim: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type Event = z.infer<typeof eventSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type Finding = {
    detector: "D1" | "D2" | "edit" | "coverage";
    status: "detected" | "suspected" | "unknown" | "resolved";
    reason: string;
};
export declare function classifyClaim(text: string, role: string): Event["claimClass"];
export declare function judge(event: Event, previous?: readonly Event[]): Finding | null;
export declare function parseTap(output: string): Pick<Evidence, "tests" | "pass" | "fail" | "cancelled" | "skipped" | "todo" | "fullOutput">;
