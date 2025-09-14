import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { logger, redact } from "./logger.js";

type HistoryTurn = ["human" | "assistant", string];

// Response schemas to validate upstream payloads and infer types
const SourceSchema = z
  .object({
    metadata: z
      .object({
        title: z.string().optional(),
        url: z.string().optional(),
      })
      .partial()
      .optional(),
  })
  .passthrough();

const SearchResponseSchema = z
  .object({
    message: z.string().optional(),
    sources: z.array(SourceSchema).optional(),
  })
  .passthrough();
type PerplexicaSearchResponse = z.infer<typeof SearchResponseSchema>;

const ModelsResponseSchema = z
  .object({
    models: z.record(z.array(z.unknown())).optional(),
  })
  .passthrough();
type PerplexicaModelsResponse = z.infer<typeof ModelsResponseSchema>;

// Tool input Zod shape (record) and a full object schema for parsing
const DEFAULT_TIMEOUT_MS = Number(process.env.MCP_REQUEST_TIMEOUT_MS) || 120_000;
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
const InputSchema = z.object(inputShape);
type ToolInput = z.infer<typeof InputSchema>;

type FocusMode = ToolInput["focusMode"];
type OptimizationMode = ToolInput["optimizationMode"];

interface PerplexicaChatModel {
  provider?: string;
  name?: string;
  customOpenAIBaseURL?: string;
  customOpenAIKey?: string;
}

interface PerplexicaEmbeddingModel {
  provider?: string;
  name?: string;
}

interface PerplexicaSearchRequestPayload {
  query: string;
  focusMode: FocusMode;
  optimizationMode: OptimizationMode;
  chatModel?: PerplexicaChatModel;
  embeddingModel?: PerplexicaEmbeddingModel;
  systemInstructions?: string;
  history?: HistoryTurn[];
  stream: boolean;
}

// Unified error codes for programmatic handling
type ErrorCode =
  | "VALIDATION_ERROR"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "UPSTREAM_ERROR"
  | "UPSTREAM_INVALID_JSON";

function errorResult(code: ErrorCode, message: string, details?: Record<string, unknown>) {
  const lines = [`[${code}] ${message}`];
  if (details && Object.keys(details).length) {
    lines.push("", "Details:", JSON.stringify(redact(details)));
  }
  const textContent = { type: "text" as const, text: lines.join("\n") };
  return { isError: true, content: [textContent] };
}

const server = new McpServer({ name: "perplexica-mcp", version: "0.1.0" });

server.registerTool(
    "perplexica.search",
    {
        title: "Perplexica Search",
        description: "Search the internet via Perplexica and return answer with sources.",
        // ✅ pass the SHAPE here, not z.object(...)
        inputSchema: inputShape,
    },
    async (rawArgs) => {
      logger.debug("perplexica.search invoked", { args: redact(rawArgs) });
      const args = InputSchema.parse(rawArgs);

      const baseUrl = args.baseUrl || process.env.PERPLEXICA_BASE_URL || "http://localhost:3000";
      const url = `${baseUrl.replace(/\/$/, "")}/api/search`;

      if (!args.query) {
        logger.warn("Missing query in tool input");
        return errorResult("VALIDATION_ERROR", "Missing required field: query");
      }

      const payload: PerplexicaSearchRequestPayload = {
        query: args.query,
        focusMode: args.focusMode,
        optimizationMode: args.optimizationMode,
        stream: false,
      };
      if (args.chatModel) payload.chatModel = args.chatModel;
      if (args.embeddingModel) payload.embeddingModel = args.embeddingModel;
      if (args.systemInstructions) payload.systemInstructions = args.systemInstructions;
      if (args.history) payload.history = args.history;

      logger.debug("Prepared payload for Perplexica API", { url, payload: redact(payload) });

      const ac = new AbortController();
      const timeout = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const tid = setTimeout(() => ac.abort(), timeout);

      try {
        logger.info("POST /api/search", { url, timeoutMs: timeout });
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
          return errorResult("UPSTREAM_ERROR", `Perplexica responded with status ${res.status}.`, {
            status: res.status,
            statusText: res.statusText,
            bodyPreview: (text || "").slice(0, 1000),
            url,
          });
        }

        let json: unknown;
        try {
          json = await res.json();
        } catch (parseErr) {
          logger.warn("Failed to parse Perplexica JSON", { message: (parseErr as Error)?.message });
          return errorResult("UPSTREAM_INVALID_JSON", "Response from Perplexica was not valid JSON.", { url });
        }
        const parsed = SearchResponseSchema.safeParse(json);
        if (!parsed.success) {
          logger.warn("Search response failed validation", { issues: parsed.error.issues });
        }
        const data: PerplexicaSearchResponse = parsed.success ? parsed.data : {};

        const message = data.message ?? "";
        const sources = Array.isArray(data.sources) ? data.sources : [];

        logger.debug("Parsed Perplexica response", { messageLength: message.length, sourcesCount: sources.length });

        const formattedSources = sources
          .map((s, i) => `${i + 1}. **${s?.metadata?.title ?? "Untitled"}**: ${s?.metadata?.url ?? ""}`)
          .join("\n");

        const body = formattedSources
          ? `${message}\n\n---\n\nSources:\n${formattedSources}`
          : message || "No message returned.";

        return { content: [{ type: "text", text: body }] };
      } catch (e: unknown) {
        clearTimeout(tid);
        const err: any = e;
        if (err?.name === "AbortError") {
          logger.error("Search request timed out", { timeoutMs: timeout, url });
          return errorResult("TIMEOUT", `Request to Perplexica timed out after ${timeout}ms.`, { url, timeoutMs: timeout });
        }
        const cause = err?.cause ?? {};
        const code = cause.code || err?.code;
        logger.error("Network error calling Perplexica API", { message: err?.message, code });
        return errorResult("NETWORK_ERROR", err?.message || "Network error while reaching Perplexica.", {
          url,
          code,
        });
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
    async (rawArgs) => {
      logger.debug("perplexica.health invoked", { args: redact(rawArgs) });
      const HealthInputSchema = z.object({
        baseUrl: z.string().default(process.env.PERPLEXICA_BASE_URL || "http://localhost:3000"),
        timeoutMs: z.number().int().positive().default(DEFAULT_TIMEOUT_MS),
      });
      const args = HealthInputSchema.parse(rawArgs);

      const baseUrl = args.baseUrl || process.env.PERPLEXICA_BASE_URL || "http://localhost:3000";
      const modelsUrl = `${baseUrl.replace(/\/$/, "")}/api/models`;

      const ac = new AbortController();
      const timeout = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const tid = setTimeout(() => ac.abort(), timeout);
      try {
        logger.info("GET /api/models", { url: modelsUrl, timeoutMs: timeout });
        const res = await fetch(modelsUrl, { signal: ac.signal });
        clearTimeout(tid);
        logger.info("Received response from Perplexica (models)", { status: res.status, ok: res.ok });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          logger.warn("Models probe returned non-OK status", { status: res.status, bodyPreview: text.slice(0, 500) });
          return errorResult("UPSTREAM_ERROR", `Perplexica models probe failed with status ${res.status}.`, {
            status: res.status,
            statusText: res.statusText,
            bodyPreview: (text || "").slice(0, 1000),
            url: modelsUrl,
          });
        }
        let json: unknown;
        try {
          json = await res.json();
        } catch (parseErr) {
          logger.warn("Failed to parse models JSON", { message: (parseErr as Error)?.message });
          return errorResult("UPSTREAM_INVALID_JSON", "Response from Perplexica models endpoint was not valid JSON.", {
            url: modelsUrl,
          });
        }
        const parsed = ModelsResponseSchema.safeParse(json);
        const data: PerplexicaModelsResponse = parsed.success ? parsed.data : {};
        const providers = Object.keys(data.models ?? {});
        const count = providers.reduce((n, p) => n + (Array.isArray((data.models as Record<string, unknown[]>)[p]) ? (data.models as Record<string, unknown[]>)[p].length : 0), 0);
        const summary = `OK: reachable at ${baseUrl}. Providers: ${providers.length}, total models: ${count}.`;
        logger.debug("Health probe summary", { providers: providers.length, count });
        return { content: [{ type: "text", text: summary }] };
      } catch (e: unknown) {
        clearTimeout(tid);
        const err: any = e;
        if (err?.name === "AbortError") {
          logger.error("Models probe timed out", { timeoutMs: timeout, url: modelsUrl });
          return errorResult("TIMEOUT", `Request to Perplexica timed out after ${timeout}ms.`, { url: modelsUrl, timeoutMs: timeout });
        }
        const cause = err?.cause ?? {};
        const code = cause.code || err?.code;
        logger.error("Network error probing Perplexica models", { message: err?.message, code });
        return errorResult("NETWORK_ERROR", err?.message || "Network error while reaching Perplexica.", {
          url: modelsUrl,
          code,
        });
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
