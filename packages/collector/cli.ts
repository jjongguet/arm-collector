import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  Collector,
  request,
  approvedOrigin,
  collectorWorker,
  createOwnedFixture,
  prepareIsolatedSelection,
  runIsolatedNodeTest,
  closeIsolatedSelection,
  IsolatedRefusal,
} from "./public.ts";
import type { SelectedScope } from "./public.ts";
import { readPrivate, atomicPrivate, removePrivate } from "./storage.ts";
import { normalizeHost, claudeSetup, hostContext } from "../adapters/public.ts";
export function validateCodexArgs(args: string[]) {
  // Allowlist: no output files, config overrides, resumes, alternate working dirs,
  // sandbox/approval overrides, attachments, search, or persistence controls.
  if (
    args.length !== 1 ||
    args[0]!.startsWith("-") ||
    Buffer.byteLength(args[0]!) > 32768
  )
    throw new Error(
      "Only one bounded prompt argument is supported; flags are forbidden",
    );
  return args;
}
export async function runCodex(
  collector: Collector,
  scope: SelectedScope,
  supplied: string[],
  probe = false,
  launch: typeof spawn = spawn,
) {
  validateCodexArgs(supplied);
  // Version query is bounded and metadata-only; no provider credentials are read.
  const version = await new Promise<string>((done) => {
    const child = launch("codex", ["--version"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let text = "",
      settled = false;
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish("0.0.0");
    }, 3000);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(text) + chunk.length <= 256)
        text += chunk.toString();
      else {
        child.kill("SIGKILL");
        finish("0.0.0");
      }
    });
    child.once("error", () => finish("0.0.0"));
    child.once("close", (code) =>
      finish(
        code === 0
          ? (/^codex-cli (\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?)\s*$/.exec(
              text,
            )?.[1] ?? "0.0.0")
          : "0.0.0",
      ),
    );
  });
  const context = hostContext(scope, version, randomUUID());
  // Tamper evidence: the opted-in scope is hashed immediately before and after
  // the observed run. Isolation of the Codex child itself is not proven here,
  // so coverage stays "unproven" even when both digests match.
  const beforeDigest = collector.snapshot(scope.root, scope.files);
  const child = launch(
    "codex",
    [
      "exec",
      "--ignore-user-config",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--json",
      ...supplied,
    ],
    { cwd: scope.root, stdio: ["inherit", "pipe", "pipe"] },
  );
  let buffer = "",
    sequence = 0,
    bytes = 0,
    events = 0,
    dropping = false;
  const accept = (line: string) => {
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      const event = normalizeHost(raw, "codex", collector, sequence++, context);
      if (event) {
        if (collector.enqueue(event)) events++;
        else {
          context.loss = true;
          context.latest = null;
        }
      }
    } catch {
      context.loss = true;
      context.latest = null;
      collector.gap();
    }
  };
  child.stdout?.on("data", (chunk: Buffer) => {
    if (!probe) process.stdout.write(chunk);
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) {
      context.loss = true;
      collector.gap();
      child.kill("SIGKILL");
      return;
    }
    // Bound each JSON line; a truncated line must not corrupt the following one.
    for (const part of chunk.toString().split(/(?<=\n)/)) {
      if (
        !dropping &&
        Buffer.byteLength(buffer) + Buffer.byteLength(part) > 262144
      ) {
        dropping = true;
        buffer = "";
        context.loss = true;
        context.latest = null;
        collector.gap();
      }
      if (!dropping) buffer += part;
      if (part.endsWith("\n")) {
        if (!dropping) accept(buffer);
        buffer = "";
        dropping = false;
      }
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    if (!probe) process.stderr.write(chunk);
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) {
      context.loss = true;
      collector.gap();
      child.kill("SIGKILL");
    }
  });
  const cancellation = () => {
    context.loss = true;
    child.kill("SIGKILL");
  };
  process.once("SIGTERM", cancellation);
  process.once("SIGINT", cancellation);
  const exit = await new Promise<number | null>((done) => {
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(code);
    };
    const timer = setTimeout(() => {
      cancellation();
      collector.gap();
      finish(null);
    }, 120000);
    child.once("error", () => {
      context.loss = true;
      collector.gap();
      finish(null);
    });
    child.once("close", finish);
  });
  process.removeListener("SIGTERM", cancellation);
  process.removeListener("SIGINT", cancellation);
  if (context.loss || buffer || dropping || context.pending.size)
    collector.gap();
  const afterDigest = collector.snapshot(scope.root, scope.files);
  const changed = beforeDigest !== afterDigest;
  // A null digest means the scope could not be hashed: that is an unknown, not
  // a clean run, so it records a gap just like a changed scope.
  const unreadable = beforeDigest === null || afterDigest === null;
  if (changed || unreadable) collector.gap();
  const result = {
    hostVersion: version,
    versionKnown: version !== "0.0.0",
    processExitCode: exit,
    events,
    loss: context.loss || Boolean(buffer || dropping || context.pending.size),
    digest: { before: beforeDigest, after: afterDigest, changed },
    coverage: "unproven" as const,
    coverageReason: unreadable
      ? "The opted-in scope could not be fully hashed, so no before/after claim is made."
      : changed
        ? "The opted-in scope changed during the run, so passing output cannot be tied to the observed source."
        : "The wrapper hashes the opted-in scope only; child-process isolation and general workspace coverage remain unproven.",
  };
  if (probe) console.log(JSON.stringify(result));
  return result;
}
export async function main(args = process.argv.slice(2)) {
  const [command] = args;
  const option = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const dir = resolve(option("--dir") ?? ".agent-reliability-monitor");
  const collector = new Collector(dir);
  switch (command) {
    case "connect": {
      const origin = approvedOrigin(option("--origin") ?? "");
      if (!args.includes("--approve-origin"))
        throw new Error("Explicit --approve-origin required");
      const pairing = await request(origin, "/api/pairing", {});
      atomicPrivate(
        join(dir, "pairing.json"),
        JSON.stringify({ origin, ...pairing }),
      );
      console.log(
        JSON.stringify({
          code: pairing.code,
          expiresIn: pairing.expiresIn,
          approveAt: origin,
          action: "Approve in dashboard, then redeem",
        }),
      );
      break;
    }
    case "redeem": {
      const pairing = JSON.parse(
        readPrivate(join(dir, "pairing.json")),
      ) as Record<string, unknown>;
      const result = await request(
        String(pairing.origin),
        "/api/pairing/redeem",
        { code: pairing.code, deviceSecret: pairing.deviceSecret },
      );
      if (result.pending) {
        console.log(
          "Awaiting dashboard approval. Poll no more than every five seconds.",
        );
        break;
      }
      collector.configure({
        origin: pairing.origin,
        ...Object.fromEntries(
          ["token", "deviceId", "projectId", "expires"].map((k) => [
            k,
            result[k],
          ]),
        ),
      });
      removePrivate(join(dir, "pairing.json"));
      console.log("Paired. No events received until opted-in adapters run.");
      break;
    }
    case "status":
      console.log(JSON.stringify(collector.statusReceipt()));
      break;
    case "report":
      console.log(JSON.stringify(collector.report(), null, 2));
      break;
    case "flush":
      await collector.flush();
      console.log(JSON.stringify(collector.report()));
      break;
    case "worker": {
      if (!args.includes("--opt-in"))
        throw new Error("Explicit --opt-in required");
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
      try {
        await collectorWorker(collector, controller.signal);
      } finally {
        process.removeListener("SIGTERM", stop);
        process.removeListener("SIGINT", stop);
      }
      break;
    }
    case "rotate": {
      const c = collector.load(),
        next = await request(c.origin, "/api/rotate", {}, c.token);
      collector.configure({ ...c, ...next });
      console.log("Credential rotated. Previous credential is invalid.");
      break;
    }
    case "disconnect":
      console.log(
        JSON.stringify({
          ...(await collector.disconnect()),
          adapterConfiguration: "unchanged",
        }),
      );
      break;
    case "setup": {
      if (option("--host") !== "claude-code")
        throw new Error(
          "Codex is an opt-in exec wrapper only; no passive hook installation",
        );
      const project = option("--project");
      if (!project) throw new Error("Explicit --project required");
      console.log(
        JSON.stringify(
          claudeSetup(
            project,
            dir,
            fileURLToPath(import.meta.url),
            args.includes("--apply"),
            args.includes("--uninstall"),
          ),
        ),
      );
      break;
    }
    case "receive": {
      // Host hooks must never fail a session: every outcome prints one receipt
      // line with an explicit reason and the process exits 0.
      let received = false,
        reason = "receive-error";
      try {
        const host = option("--host");
        if (host !== "claude-code" && host !== "codex")
          throw new Error("Explicit host required");
        let input = "",
          over = false;
        // Native async hooks do not enforce their configured timeout.
        const deadline = setTimeout(() => {
          over = true;
          process.stdin.destroy();
        }, 3000);
        try {
          for await (const chunk of process.stdin) {
            if (Buffer.byteLength(input) + chunk.length > 262144) {
              over = true;
              break;
            }
            input += chunk.toString();
          }
        } catch {
          over = true;
        } finally {
          clearTimeout(deadline);
        }
        if (over) {
          collector.gap();
          reason = "payload-too-large";
        } else {
          try {
            const event = normalizeHost(JSON.parse(input), host, collector, 0);
            if (event) {
              event.sequence = collector.nextSequence(event.runId);
              received = collector.enqueue(event);
              reason = received ? "queued" : "duplicate";
            } else reason = "unsupported-event";
          } catch {
            collector.gap();
            reason = "invalid-event";
          }
        }
      } catch {
        reason = "receive-error";
      }
      console.log(JSON.stringify({ received, reason }));
      break;
    }
    case "codex-fixture":
    case "codex-exec": {
      if (!args.includes("--opt-in"))
        throw new Error("Explicit --opt-in required");
      const fixture =
        command === "codex-fixture"
          ? createOwnedFixture(args.includes("--passing"))
          : null;
      try {
        const project = option("--project"),
          files = option("--scope")?.split(","),
          tests = option("--tests")?.split(",");
        if (
          !fixture &&
          (!project ||
            !files?.length ||
            !tests?.length ||
            tests.some((f) => !files.includes(f)))
        )
          throw new Error("Explicit --project, --scope and --tests required");
        const scope = fixture?.scope ?? {
          root: resolve(project!),
          files: files!,
          tests: tests!,
        };
        const separator = args.indexOf("--");
        const supplied = fixture
          ? [
              `Run exactly ${process.execPath} --test --test-reporter=tap ${resolve(scope.root, scope.tests[0]!)} using the shell tool, wait for completion, then respond with exactly All tests passed. Do not modify any files. This is an intentional reliability-monitor contradiction probe, not a real correctness assertion.`,
            ]
          : args.slice(separator + 1);
        if (!fixture && separator < 0)
          throw new Error("Put one prompt after --");
        const result = await runCodex(
          collector,
          scope,
          supplied,
          args.includes("--capability-probe"),
        );
        process.exitCode = result.processExitCode ?? 1;
      } finally {
        fixture?.close();
      }
      break;
    }
    case "isolated-test": {
      // Opt-in, single selected worktree. The fixed profile and argv live in
      // isolated-node.ts; no caller-supplied command, file, or flag is used.
      const seen = new Set<string>();
      for (let index = 1; index < args.length; index++) {
        const flag = args[index]!;
        if (
          !["--opt-in", "--project", "--dir"].includes(flag) ||
          seen.has(flag)
        )
          throw new Error("Only explicit isolated-test options are supported");
        seen.add(flag);
        if (
          flag !== "--opt-in" &&
          (!args[++index] || args[index]!.startsWith("--"))
        )
          throw new Error("An explicit option value is required");
      }
      if (!args.includes("--opt-in"))
        throw new Error("Explicit --opt-in required");
      const project = option("--project");
      if (!project) throw new Error("Explicit --project PATH required");
      const selection = prepareIsolatedSelection(collector, resolve(project));
      try {
        const result = await runIsolatedNodeTest(collector, selection);
        console.log(JSON.stringify(result));
        process.exitCode =
          result.completed &&
          !result.loss &&
          result.fullOutput &&
          result.tests === 5 &&
          result.skipped + result.todo === 0 &&
          result.cleanup.verified
            ? (result.exitCode ?? 1)
            : 1;
      } finally {
        closeIsolatedSelection(selection);
      }
      break;
    }
    default:
      console.log(
        "Commands: connect, redeem, status, report, flush, worker --opt-in, rotate, disconnect, receive, setup, codex-fixture --opt-in [--passing] [--capability-probe], codex-exec --opt-in --project PATH --scope FILES --tests FILES -- PROMPT, isolated-test --opt-in --project PATH. Use --dir PRIVATE_DIR. General workspace coverage remains unproven.",
      );
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    if (process.argv[2] === "receive") return;
    // Map only reproduced, non-sensitive failure shapes to a next action. Raw
    // payloads, paths and credentials are never echoed.
    const message = error instanceof Error ? error.message : "";
    const status = (error as { status?: number } | null)?.status;
    const action =
      message === "Symlink refused"
        ? "The state path resolves through a symlink. Pass a real path to --dir (for example a directory under your home) instead of a symlinked one such as /tmp on macOS."
        : message === "Private owned 0700 directory required" ||
            message === "Private owned 0600 file required"
          ? "The state directory must be owned by you with 0700 and its files with 0600. Do not share the state path with other users."
          : status === 429
            ? "The service temporarily rate limited the request (429). Wait briefly and run the same command again."
            : status === 401 || status === 403
              ? "The service rejected the credential (401/403). Pair again with a new connect -> web approval -> redeem, then retry."
              : status === 400
                ? "The service rejected the request format (400). Re-check the pairing code and that every command uses the same --dir."
                : error instanceof IsolatedRefusal
                  ? `The isolated test profile was refused before launch (${error.code}). Keep the approved worktree unchanged and verify macOS sandbox availability. No unsandboxed fallback exists.`
                  : "Collector operation failed. Check private permissions, explicit options, approval and service availability. No secrets displayed.";
    console.error(action);
    process.exitCode = 1;
  });
}
