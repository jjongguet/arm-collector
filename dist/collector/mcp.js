// Minimal MCP (Model Context Protocol) server over stdio for the read path.
//
// This is the consumer half of the SDK: an agent asks ARM what it observed
// instead of pushing more data. It speaks JSON-RPC 2.0 line-delimited, exposes
// two read-only tools, and never sends events, credentials or source text.
// No dependencies: the protocol subset here is small and stable.
import { readFileSync } from "node:fs";
import { join } from "node:path";
const PROTOCOL_VERSION = "2024-11-05";
const MAX_TOOL_TEXT = 20000;
function asRecord(value) {
    return value && typeof value === "object"
        ? value
        : null;
}
export function toolList() {
    return {
        tools: [
            {
                name: "arm_issues",
                description: "List the issues the ARM server currently holds for this device's project. Read-only; these are evidence summaries, not a final verdict.",
                inputSchema: { type: "object", properties: {} },
            },
            {
                name: "arm_evidence",
                description: "Read the stored event and context behind one issue id. Read-only; returns 404-shaped errors for issues outside this device's project.",
                inputSchema: {
                    type: "object",
                    properties: { id: { type: "string" } },
                    required: ["id"],
                },
            },
        ],
    };
}
export function createMcpHandler(deps) {
    const http = deps.fetch ?? fetch;
    const call = async (path) => {
        const response = await http(`${deps.origin}${path}`, {
            headers: { authorization: `Bearer ${deps.token}` },
            redirect: "error",
        });
        const body = await response.text();
        if (!response.ok)
            return {
                text: JSON.stringify({ status: response.status, error: "read_failed" }),
                isError: true,
            };
        return { text: body.slice(0, MAX_TOOL_TEXT), isError: false };
    };
    return async function handle(request) {
        const method = request.method ?? "";
        const id = request.id ?? null;
        if (method === "initialize")
            return {
                jsonrpc: "2.0",
                id,
                result: {
                    protocolVersion: PROTOCOL_VERSION,
                    capabilities: { tools: {} },
                    serverInfo: { name: "arm-collector", version: "1" },
                },
            };
        if (method === "tools/list")
            return { jsonrpc: "2.0", id, result: toolList() };
        if (method === "tools/call") {
            const params = asRecord(request.params);
            const name = params?.name;
            if (name === "arm_issues") {
                const out = await call("/api/issues");
                return {
                    jsonrpc: "2.0",
                    id,
                    result: {
                        content: [{ type: "text", text: out.text }],
                        ...(out.isError ? { isError: true } : {}),
                    },
                };
            }
            if (name === "arm_evidence") {
                const args = asRecord(params?.arguments);
                const issueId = typeof args?.id === "string" ? args.id : "";
                if (!/^[a-zA-Z0-9_-]{1,80}$/.test(issueId))
                    return {
                        jsonrpc: "2.0",
                        id,
                        result: {
                            content: [{ type: "text", text: "invalid_issue_id" }],
                            isError: true,
                        },
                    };
                const out = await call(`/api/evidence/${issueId}`);
                return {
                    jsonrpc: "2.0",
                    id,
                    result: {
                        content: [{ type: "text", text: out.text }],
                        ...(out.isError ? { isError: true } : {}),
                    },
                };
            }
            return {
                jsonrpc: "2.0",
                id,
                error: { code: -32601, message: "unknown tool" },
            };
        }
        // Notifications (no id) get no response at all.
        if (request.id === undefined)
            return null;
        return { jsonrpc: "2.0", id, error: { code: -32601, message: "unknown method" } };
    };
}
/** Reads the paired device credential from the collector state directory. */
export function readCredential(dir) {
    const connection = JSON.parse(readFileSync(join(dir, "connection.json"), "utf8"));
    if (!connection.origin || !connection.token)
        throw new Error("Paired device required: run connect and redeem first");
    return { origin: connection.origin, token: connection.token };
}
