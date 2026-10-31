import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { readFileSync, existsSync, mkdirSync, lstatSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import {
  Collector,
  baseEvent,
  isOwnedFixture,
  isCurrentIsolatedObservation,
} from "../collector/public.ts";
import type {
  SelectedScope,
  IsolatedObservation,
} from "../collector/public.ts";
import {
  atomicPrivate,
  noSymlinks,
  removePrivate,
} from "../collector/storage.ts";
import { classifyClaim, parseTap } from "../core/public.ts";
import type { Event, Evidence } from "../core/public.ts";

/**
 * Generic host envelope for any coding agent that is not Claude Code or Codex.
 * It carries only the observation itself: a claim's text is classified and
 * discarded, and no evidence is accepted. A host cannot certify its own work,
 * so generic claims stay `unknown` in judgement and only the collector's own
 * approved test runs can produce stronger verdicts.
 */
export const genericHostSchema = z
  .object({
    kind: z.enum(["claim", "error", "test-edit", "health"]),
    hostVersion: z
      .string()
      .regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/)
      .optional(),
    runId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,80}$/)
      .optional(),
    turnId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,80}$/)
      .optional(),
    claim: z
      .object({ role: z.string().max(40), text: z.string().max(32768) })
      .strict()
      .optional(),
    error: z
      .object({
        class: z.enum(["test-failed", "tool-failed"]),
        progress: z.string().max(4096).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// Explicit local diagnostic claim, not a claim that the model ran these tests.
// Only the original in-process observation can authorize isolated evidence;
// replayed JSON and ordinary Codex command transcripts cannot do so.
export function isolatedClaimEvent(
  collector: Collector,
  observation: IsolatedObservation,
  claim: string,
): Event {
  const event = baseEvent("fixture", randomUUID(), 2);
  event.kind = "claim";
  event.claimClass = classifyClaim(claim, "assistant");
  event.nodeMajor = 0;
  if (!isCurrentIsolatedObservation(collector, observation)) return event;
  event.nodeMajor = 24;
  event.hostVersion = "24.15.0";
  event.evidence = {
    runnerProfile: observation.runnerProfile,
    commandClass: observation.commandClass,
    exitCode: observation.exitCode,
    tests: observation.tests,
    pass: observation.pass,
    fail: observation.fail,
    cancelled: observation.cancelled,
    skipped: observation.skipped,
    todo: observation.todo,
    completed: observation.completed,
    fullOutput: observation.fullOutput,
    background: false,
    loss: observation.loss || !observation.cleanup.verified,
    startedSequence: 0,
    completedSequence: 1,
    scopeId: observation.scopeId,
    coverage: observation.coverage,
    before: observation.selectionDigest,
    after: observation.selectionDigest,
    claim: observation.selectionDigest,
  };
  return event;
}

export type HostContext = {
  scope: SelectedScope;
  version: string;
  runId: string;
  pending: Map<string, { before: string | null; sequence: number }>;
  seen: Set<string>;
  latest: Evidence | null;
  latestToolId: string | null;
  turn: number;
  loss: boolean;
};
export function hostContext(
  scope: SelectedScope,
  version: string,
  runId: string,
): HostContext {
  return {
    scope,
    version,
    runId,
    pending: new Map(),
    seen: new Set(),
    latest: null,
    latestToolId: null,
    turn: 0,
    loss:
      version === "0.0.0" ||
      !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version),
  };
}
// Parse only the observed shell transport's exact safe argv. Never evaluate it.
export function approvedTestCommand(
  command: unknown,
  scope: SelectedScope,
): boolean {
  if (typeof command !== "string" || command.length > 4096) return false;
  let text = command;
  const transport = /^(?:\/bin\/)?(?:sh|bash|zsh) -lc (["'])(.*)\1$/s.exec(
    text,
  );
  if (transport) text = transport[2]!;
  if (/[;&|<>`$\\\n\r]/.test(text)) return false;
  const tokens = text.match(/'[^']*'|"[^"]*"|[^\s'\"]+/g);
  if (!tokens || tokens.join(" ") !== text.trim().replace(/ +/g, " "))
    return false;
  const argv = tokens.map((v) => (/^["']/.test(v) ? v.slice(1, -1) : v));
  if (
    !(isOwnedFixture(scope)
      ? argv[0] === process.execPath
      : ["node", process.execPath].includes(argv[0]!)) ||
    argv[1] !== "--test" ||
    argv[2] !== "--test-reporter=tap"
  )
    return false;
  const files = argv.slice(3);
  return (
    files.length === scope.tests.length &&
    files.every((v, i) =>
      isOwnedFixture(scope)
        ? v === resolve(scope.root, scope.tests[i]!)
        : v === scope.tests[i] || v === resolve(scope.root, scope.tests[i]!),
    )
  );
}
export function genericEvent(
  raw: unknown,
  host: string,
  collector: Collector,
  sequence: number,
): Event | null {
  const parsed = genericHostSchema.safeParse(raw);
  if (!parsed.success) return null;
  const p = parsed.data;
  if (p.kind === "claim" && !p.claim) return null;
  if (p.kind === "error" && !p.error) return null;
  const key = collector.key();
  const opaque = (v: string) =>
    createHmac("sha256", key).update(v.slice(0, 32768)).digest("hex");
  const event = baseEvent(host, opaque(p.runId ?? randomUUID()), sequence);
  event.hostVersion = p.hostVersion ?? "0.0.0";
  event.turnId = opaque(p.turnId ?? `turn:${sequence}`);
  // No generic host establishes the runner's Node version, scope digests or
  // coverage. Evidence stays null, so D1 can only answer `unknown`.
  event.nodeMajor = 0;
  event.kind = p.kind;
  if (p.kind === "claim")
    event.claimClass = classifyClaim(p.claim!.text, p.claim!.role);
  if (p.kind === "error") {
    event.errorClass = p.error!.class;
    event.progressFingerprint = p.error!.progress
      ? opaque(`generic:${p.error!.class}:${p.error!.progress}`)
      : null;
  }
  return event;
}
export function normalizeHost(
  raw: unknown,
  host: string,
  collector: Collector,
  sequence: number,
  context?: HostContext,
): Event | null {
  if (
    !raw ||
    typeof raw !== "object" ||
    Buffer.byteLength(JSON.stringify(raw)) > 262144
  )
    return null;
  // Every other coding agent reports through the generic envelope. There is no
  // per-host parser to add: the contract is the SDK, not the host brand.
  if (host !== "claude-code" && host !== "codex")
    return genericEvent(raw, host, collector, sequence);
  const p = raw as Record<string, unknown>,
    key = collector.key();
  const opaque = (v: unknown) =>
    createHmac("sha256", key)
      .update(typeof v === "string" ? v.slice(0, 32768) : "unknown")
      .digest("hex");
  const event = baseEvent(
    host,
    opaque(p.session_id ?? p.thread_id ?? randomUUID()),
    sequence,
  );
  event.hostVersion =
    context?.version &&
    /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(context.version)
      ? context.version
      : "0.0.0";
  // Only owned fixtures require this exact Node executable. Native/general
  // shell aliases do not establish the runner's actual Node version.
  if (!context || !isOwnedFixture(context.scope)) event.nodeMajor = 0;
  if (context) event.runId = context.runId;
  event.turnId = opaque(
    p.prompt_id ?? (context ? String(context.turn) : "unknown"),
  );
  event.toolCallId = opaque(p.tool_use_id ?? "unknown");
  const isTestPath = (value: unknown) =>
    typeof value === "string" &&
    value.length <= 4096 &&
    /^(?:[-\w]+\.(?:test|spec)\.[cm]?[jt]s|test[-\w]*\.[cm]?[jt]s)$/u.test(
      basename(value),
    );
  if (host === "claude-code") {
    if (p.hook_event_name === "Stop") {
      event.kind = "claim";
      event.claimClass = classifyClaim(
        typeof p.last_assistant_message === "string"
          ? p.last_assistant_message
          : "",
        "assistant",
      );
    } else if (p.hook_event_name === "PostToolUseFailure") {
      event.kind = "error";
      event.errorClass = "tool-failed";
      // HMAC only bounded cause metadata; raw error payload is never retained.
      const cause = errorCause(p.error);
      event.progressFingerprint = opaque(
        `claude:${p.tool_name}:${cause}:${context ? collector.snapshot(context.scope.root, context.scope.files) : "unobserved"}`,
      );
    } else if (
      p.hook_event_name === "PostToolUse" &&
      (p.tool_name === "Edit" || p.tool_name === "Write")
    ) {
      const input = p.tool_input as Record<string, unknown> | undefined;
      if (!isTestPath(input?.file_path)) return null;
      event.kind = "test-edit";
    } else return null;
  } else {
    const item = p.item as Record<string, unknown> | undefined;
    if (context && item?.type === "file_change") context.latest = null;
    if (context && p.type === "turn.started") {
      context.turn++;
      context.latest = null;
      return null;
    }
    const toolId =
      typeof item?.id === "string" &&
      item.id.length > 0 &&
      item.id.length <= 32768
        ? opaque(item.id)
        : null;
    if (toolId) event.toolCallId = toolId;
    if (context) {
      const itemSpan =
        p.type === "item.started" ||
        p.type === "item.updated" ||
        p.type === "item.completed";
      const missingCommandId = item?.type === "command_execution" && !toolId;
      const unknownSpan =
        itemSpan &&
        (!item ||
          ![
            "command_execution",
            "file_change",
            "agent_message",
            "reasoning",
          ].includes(String(item.type)));
      const unknownCommandSpan =
        item?.type === "command_execution" &&
        p.type !== "item.started" &&
        p.type !== "item.completed";
      if (
        missingCommandId ||
        unknownSpan ||
        unknownCommandSpan ||
        p.type === "turn.failed" ||
        p.type === "error"
      ) {
        context.latest = null;
        context.latestToolId = null;
        context.loss = true;
        collector.gap();
      }
    }
    if (context && item?.type === "command_execution" && toolId) {
      if (p.type === "item.started") {
        context.latest = null;
        if (
          context.pending.size >= 100 ||
          context.seen.has(toolId) ||
          context.pending.has(toolId)
        ) {
          context.loss = true;
          return null;
        }
        if (approvedTestCommand(item.command, context.scope))
          context.pending.set(toolId, {
            before: collector.snapshot(context.scope.root, context.scope.files),
            sequence,
          });
        return null;
      }
      if (p.type === "item.completed") {
        if (context.seen.has(toolId)) {
          context.loss = true;
          context.latest = null;
          return null;
        }
        if (context.seen.size >= 1000) {
          context.loss = true;
          context.latest = null;
          return null;
        }
        context.seen.add(toolId);
        const start = context.pending.get(toolId);
        context.pending.delete(toolId);
        context.latest = null;
        if (start && approvedTestCommand(item.command, context.scope)) {
          const output =
            typeof item.aggregated_output === "string"
              ? item.aggregated_output
              : "";
          context.latest = {
            runnerProfile: "NODE_TAP_V1",
            commandClass: "approved-node-test",
            exitCode:
              typeof item.exit_code === "number" &&
              Number.isInteger(item.exit_code) &&
              item.exit_code >= 0 &&
              item.exit_code <= 255
                ? item.exit_code
                : null,
            ...parseTap(output),
            completed:
              item.status === "completed" ||
              (item.status === "failed" && item.exit_code !== 0),
            background: item.status !== "completed" && item.status !== "failed",
            loss: context.loss,
            startedSequence: start.sequence,
            completedSequence: sequence,
            scopeId: opaque(
              JSON.stringify({
                root: isOwnedFixture(context.scope)
                  ? "owned-fixture"
                  : context.scope.root,
                files: [...context.scope.files].sort(),
                tests: [...context.scope.tests].sort(),
              }),
            ),
            coverage: isOwnedFixture(context.scope) ? "isolated" : "unproven",
            before: start.before,
            after: collector.snapshot(context.scope.root, context.scope.files),
            claim: null,
          };
          context.latestToolId = toolId;
        }
      }
    }
    if (p.type === "item.completed" && item?.type === "agent_message") {
      event.kind = "claim";
      event.claimClass = classifyClaim(
        typeof item.text === "string" ? item.text : "",
        "assistant",
      );
      if (context?.latest) {
        event.evidence = {
          ...context.latest,
          loss: context.loss || context.pending.size > 0,
          claim: collector.snapshot(context.scope.root, context.scope.files),
        };
        if (context.latestToolId) event.toolCallId = context.latestToolId;
        context.latest = null;
      }
    } else if (
      p.type === "item.completed" &&
      item?.type === "command_execution" &&
      typeof item.exit_code === "number" &&
      item.exit_code !== 0
    ) {
      event.kind = "error";
      event.errorClass = "tool-failed";
      const cause = errorCause(item.aggregated_output);
      event.progressFingerprint = opaque(
        `codex:${opaque(item.command)}:${item.exit_code}:${cause}:${context ? collector.snapshot(context.scope.root, context.scope.files) : "unobserved"}`,
      );
    } else if (p.type === "item.completed" && item?.type === "file_change") {
      if (
        !Array.isArray(item.changes) ||
        !item.changes.some((v: Record<string, unknown>) => isTestPath(v.path))
      )
        return null;
      event.kind = "test-edit";
      if (context) context.latest = null;
    } else return null;
  }
  if (event.evidence && collector.hasGap()) event.evidence.loss = true;
  return event;
}
function errorCause(value: unknown) {
  if (typeof value !== "string") return "unavailable";
  // Stable cause, not timestamps, stack addresses, TAP durations or whole output.
  const lines = value
    .slice(0, 32768)
    .split(/\r?\n/)
    .filter((line) => /(?:Error\b|error:|code:|not ok|errorCode:)/.test(line))
    .slice(0, 8);
  return (lines.join("\n") || "unclassified")
    .slice(0, 2048)
    .replace(/\d+(?:\.\d+)?/g, "#");
}
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
export function claudeSetup(
  project: string,
  collectorDir: string,
  cliPath: string,
  apply = false,
  uninstall = false,
) {
  const root = resolve(project),
    directory = join(root, ".claude"),
    file = join(directory, "settings.local.json");
  noSymlinks(file);
  let settings: Record<string, unknown> = {};
  if (existsSync(file)) {
    if (lstatSync(file).size > 262144) throw new Error("Config cap");
    settings = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >;
  }
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks))
    throw new Error("Invalid existing hooks");
  const command = `${quote(process.execPath)} ${quote(resolve(cliPath))} receive --host claude-code --dir ${quote(resolve(collectorDir))} # arm-owned-v1`;
  // Ownership is the marker, not byte equality: a re-apply after a path move
  // must replace the previous owned entry instead of orphaning it.
  const owned = (h: Record<string, unknown>) =>
    typeof h.command === "string" && h.command.includes("# arm-owned-v1");
  const updated = { ...hooks };
  for (const name of ["Stop", "PostToolUseFailure", "PostToolUse"]) {
    const groups = hooks[name] ?? [];
    if (!Array.isArray(groups)) throw new Error("Invalid existing hook group");
    const kept = groups
      .map((g: Record<string, unknown>) => {
        if (!Array.isArray(g.hooks)) throw new Error("Invalid hook handlers");
        return {
          ...g,
          hooks: g.hooks.filter((h: Record<string, unknown>) => !owned(h)),
        };
      })
      .filter(
        (g: Record<string, unknown>) => (g.hooks as unknown[]).length > 0,
      );
    updated[name] = uninstall
      ? kept
      : [
          ...kept,
          {
            matcher:
              name === "PostToolUse"
                ? "Edit|Write"
                : name === "PostToolUseFailure"
                  ? "Bash"
                  : "",
            hooks: [
              {
                type: "command",
                command,
                // Async Stop and test-edit events were observed to be dropped
                // at session exit; only the high-frequency Bash failure feed
                // stays non-blocking.
                ...(name === "PostToolUseFailure" ? { async: true } : {}),
                timeout: 3,
              },
            ],
          },
        ];
  }
  const next = { ...settings, hooks: updated };
  const preview = {
    file: ".claude/settings.local.json",
    operation: uninstall ? "remove owned entries" : "add owned entries",
    events: ["Stop", "PostToolUseFailure", "PostToolUse"],
    delivery: "sync Stop and test-edit; async Bash failure feed",
    requiresExplicitApply: !apply,
  };
  if (apply) {
    noSymlinks(directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if ((lstatSync(directory).mode & 0o077) !== 0)
      throw new Error(
        "Project .claude must be private 0700 for owned config write",
      );
    atomicPrivate(file, JSON.stringify(next, null, 2));
  }
  return preview;
}
