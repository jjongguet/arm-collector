export type McpDeps = {
    origin: string;
    token: string;
    /** Injected for tests; defaults to the global fetch. */
    fetch?: typeof fetch;
};
export type JsonRpcRequest = {
    jsonrpc?: string;
    id?: number | string | null;
    method?: string;
    params?: unknown;
};
export declare function toolList(): {
    tools: ({
        name: string;
        description: string;
        inputSchema: {
            type: string;
            properties: {
                id?: undefined;
            };
            required?: undefined;
        };
    } | {
        name: string;
        description: string;
        inputSchema: {
            type: string;
            properties: {
                id: {
                    type: string;
                };
            };
            required: string[];
        };
    })[];
};
export declare function createMcpHandler(deps: McpDeps): (request: JsonRpcRequest) => Promise<{
    jsonrpc: string;
    id: string | number | null;
    result: {
        protocolVersion: string;
        capabilities: {
            tools: {};
        };
        serverInfo: {
            name: string;
            version: string;
        };
    };
    error?: undefined;
} | {
    jsonrpc: string;
    id: string | number | null;
    result: {
        tools: ({
            name: string;
            description: string;
            inputSchema: {
                type: string;
                properties: {
                    id?: undefined;
                };
                required?: undefined;
            };
        } | {
            name: string;
            description: string;
            inputSchema: {
                type: string;
                properties: {
                    id: {
                        type: string;
                    };
                };
                required: string[];
            };
        })[];
    };
    error?: undefined;
} | {
    jsonrpc: string;
    id: string | number | null;
    result: {
        isError?: boolean | undefined;
        content: {
            type: string;
            text: string;
        }[];
        protocolVersion?: undefined;
        capabilities?: undefined;
        serverInfo?: undefined;
    };
    error?: undefined;
} | {
    jsonrpc: string;
    id: string | number | null;
    error: {
        code: number;
        message: string;
    };
    result?: undefined;
} | null>;
/** Reads the paired device credential from the collector state directory. */
export declare function readCredential(dir: string): McpDeps;
