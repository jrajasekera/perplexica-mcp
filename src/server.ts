import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { logger, redact } from "./logger.js";

type HistoryTurn = ["human" | "assistant", string];

const server = new McpServer({ name: "perplexica-mcp", version: "0.1.0" });

// Allow overriding the default HTTP timeout to avoid MCP client timeouts
const DEFAULT_TIMEOUT_MS = Number(process.env.MCP_REQUEST_TIMEOUT_MS) || 120_000;

// ✅ define a Zod shape (Record<string, ZodTypeAny>)
const inputShape = {
    query: z.string().describe("Search query or question"),
    focusMode: z
        .enum([
            "webSearch",
            "academicSearch",
            "writingAssistant",
            "wolframAlphaSearch",
            "youtubeSearch",
            "redditSearch",
        ])
        .default("webSearch")
        .describe("What to focus on"),
    optimizationMode: z.enum(["speed", "balanced"]).default("balanced"),
    baseUrl: z
        .string()
        .default(process.env.PERPLEXICA_BASE_URL || "http://localhost:3000")
        .describe("Perplexica base URL"),
    chatModel: z
        .object({
            provider: z.string().optional(),
            name: z.string().optional(),
            customOpenAIBaseURL: z.string().optional(),
            customOpenAIKey: z.string().optional(),
        })
        .optional(),
    embeddingModel: z
        .object({
            provider: z.string().optional(),
            name: z.string().optional(),
        })
        .optional(),
    systemInstructions: z.string().optional(),
    history: z.array(z.tuple([z.enum(["human", "assistant"]), z.string()])).optional(),
    stream: z.boolean().default(false),
    timeoutMs: z.number().int().positive().default(DEFAULT_TIMEOUT_MS),
} satisfies Record<string, z.ZodTypeAny>;

server.registerTool(
    "perplexica.search",
    {
        title: "Perplexica Search",
        description: "Search the internet via Perplexica and return answer with sources.",
        // ✅ pass the SHAPE here, not z.object(...)
        inputSchema: inputShape,
    },
    async (args) => {
        logger.debug("perplexica.search invoked", { args: redact(args) });
        const baseUrl =
            (args.baseUrl as string) || process.env.PERPLEXICA_BASE_URL || "http://localhost:3000";
        const url = `${baseUrl.replace(/\/$/, "")}/api/search`;

        const query = (args.query as string) || "";
        const focusMode = (args.focusMode as string) || "webSearch";
        if (!query) {
            logger.warn("Missing query in tool input");
            return { isError: true, content: [{ type: "text", text: "Missing query." }] };
        }

        const payload: Record<string, unknown> = {
            query,
            focusMode,
            optimizationMode: args.optimizationMode ?? "balanced",
            stream: false,
        };
        if (args.chatModel) payload.chatModel = args.chatModel;
        if (args.embeddingModel) payload.embeddingModel = args.embeddingModel;
        if (args.systemInstructions) payload.systemInstructions = args.systemInstructions;
        if (args.history) payload.history = args.history as HistoryTurn[];

        logger.debug("Prepared payload for Perplexica API", { url, payload: redact(payload) });

        const ac = new AbortController();
        const tid = setTimeout(() => ac.abort(), (args.timeoutMs as number) ?? DEFAULT_TIMEOUT_MS);

        try {
            logger.info("POST /api/search", { url, timeoutMs: (args.timeoutMs as number) ?? DEFAULT_TIMEOUT_MS });
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
                signal: ac.signal,
            });
            clearTimeout(tid);

            logger.info("Received response from Perplexica", { status: res.status, ok: res.ok });

            if (!res.ok) {
                const text = await res.text().catch(() => "");
                logger.warn("Perplexica returned non-OK status", { status: res.status, bodyPreview: text.slice(0, 500) });
                return { isError: true, content: [{ type: "text", text: `Perplexica error ${res.status}: ${text}` }] };
            }

            const data: any = await res.json();
            const message: string = data?.message ?? "";
            const sources: any[] = Array.isArray(data?.sources) ? data.sources : [];

            logger.debug("Parsed Perplexica response", { messageLength: message?.length ?? 0, sourcesCount: sources.length });

            const formattedSources = sources
                .map((s: any, i: number) => `${i + 1}. **${s?.metadata?.title ?? "Untitled"}**: ${s?.metadata?.url ?? ""}`)
                .join("\n");

            const body = formattedSources
                ? `${message}\n\n---\n\nSources:\n${formattedSources}`
                : message || "No message returned.";

            return { content: [{ type: "text", text: body }] };
        } catch (e: any) {
            clearTimeout(tid);
            const errMsg = e?.name === "AbortError" ? "Request aborted (timeout)" : e?.message || String(e);
            logger.error("Error calling Perplexica API", { message: errMsg });
            return { isError: true, content: [{ type: "text", text: `Failed to reach Perplexica: ${errMsg}` }] };
        }
    }
);

// Lightweight healthcheck: verifies Perplexica is reachable and lists model count
server.registerTool(
    "perplexica.health",
    {
        title: "Perplexica Health",
        description: "Check connectivity to Perplexica and basic API health.",
        inputSchema: {
            baseUrl: z
                .string()
                .default(process.env.PERPLEXICA_BASE_URL || "http://localhost:3000")
                .describe("Perplexica base URL"),
            timeoutMs: z.number().int().positive().default(DEFAULT_TIMEOUT_MS),
        },
    },
    async (args) => {
        logger.debug("perplexica.health invoked", { args: redact(args) });
        const baseUrl =
            (args.baseUrl as string) || process.env.PERPLEXICA_BASE_URL || "http://localhost:3000";
        const modelsUrl = `${baseUrl.replace(/\/$/, "")}/api/models`;

        const ac = new AbortController();
        const tid = setTimeout(() => ac.abort(), (args.timeoutMs as number) ?? DEFAULT_TIMEOUT_MS);
        try {
            logger.info("GET /api/models", { url: modelsUrl, timeoutMs: (args.timeoutMs as number) ?? DEFAULT_TIMEOUT_MS });
            const res = await fetch(modelsUrl, { signal: ac.signal });
            clearTimeout(tid);
            logger.info("Received response from Perplexica (models)", { status: res.status, ok: res.ok });
            if (!res.ok) {
                const text = await res.text().catch(() => "");
                logger.warn("Models probe returned non-OK status", { status: res.status, bodyPreview: text.slice(0, 500) });
                return { isError: true, content: [{ type: "text", text: `Perplexica models probe failed ${res.status}: ${text}` }] };
            }
            const data: any = await res.json().catch(() => ({}));
            const providers = Object.keys(data?.models || {});
            const count = providers.reduce((n, p) => n + (Array.isArray(data.models[p]) ? data.models[p].length : 0), 0);
            const summary = `OK: reachable at ${baseUrl}. Providers: ${providers.length}, total models: ${count}.`;
            logger.debug("Health probe summary", { providers: providers.length, count });
            return { content: [{ type: "text", text: summary }] };
        } catch (e: any) {
            clearTimeout(tid);
            const errMsg = e?.name === "AbortError" ? "Request aborted (timeout)" : e?.message || String(e);
            logger.error("Error probing Perplexica models", { message: errMsg });
            return { isError: true, content: [{ type: "text", text: `Failed to reach Perplexica at ${baseUrl}: ${errMsg}` }] };
        }
    }
);

const transport = new StdioServerTransport();
logger.info("Starting MCP server", {
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    baseUrl: process.env.PERPLEXICA_BASE_URL || "http://localhost:3000",
    logLevel: process.env.MCP_LOG_LEVEL || "info",
});
await server.connect(transport);
logger.info("MCP server connected (stdio)");
