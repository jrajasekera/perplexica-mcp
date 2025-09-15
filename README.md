# Perplexica MCP Server

A minimal Model Context Protocol (MCP) tool server that exposes `perplexica.search`, a proxy to Perplexica’s `/api/search`. It lets local LLM agents (e.g., Codex CLI, Claude Desktop, Open WebUI) perform high-quality web/academic searches and receive a synthesized answer plus sources.

---

## What is Perplexica?

[Perplexica](https://github.com/ItzCrazyKns/Perplexica) is an open‑source, privacy‑respecting, AI‑powered metasearch engine. It orchestrates search (web, academic, YouTube, Reddit, Wolfram Alpha, etc.), retrieves and ranks results, and uses LLMs to synthesize clear, source‑grounded answers. You can self‑host it or connect to a remote instance.

---

## TL;DR (Quickstart)

1) Prerequisites

- Node.js ≥ 18.17
- pnpm (recommended): `npm i -g pnpm`
- A running Perplexica instance (default assumed at `http://localhost:3000`).

2) Clone, install, build

```bash
git clone https://github.com/jrajasekera/perplexica-mcp.git
cd perplexica-mcp
pnpm install
pnpm build
```

3) Run with MCP Inspector (fastest way to try)

- One‑liner (after build):

```bash
pnpm dlx @modelcontextprotocol/inspector -- node dist/server.js
```

- Or run in dev (TypeScript, no build):

```bash
pnpm dlx @modelcontextprotocol/inspector -- node --loader tsx src/server.ts
```

- Optional: use a config file `mcp.json` for cleaner env/args:

```json
{
  "mcpServers": {
    "perplexica": {
      "type": "stdio",
      "command": "node",
      "args": ["dist/server.js"],
      "env": { "PERPLEXICA_BASE_URL": "http://localhost:3000" }
    }
  }
}
```

Run Inspector with config:

```bash
pnpm dlx @modelcontextprotocol/inspector --config ./mcp.json --server perplexica
```

4) Test a call in Inspector

Use this input for the `perplexica.search` tool:

```json
{
  "query": "Latest CUDA updates in 2025",
  "focusMode": "webSearch"
}
```

You should see a final answer and a numbered Sources list.

---

## What this server provides

- Tool: `perplexica.search` (stdio transport)
- Runtime: Node, TypeScript, ESM (NodeNext), pnpm
- HTTP timeouts via `AbortController` (default 120s)
- Clean result text containing a synthesized answer plus formatted sources

This MCP server simply forwards requests to `PERPLEXICA_BASE_URL/api/search`, handling timeouts and surfacing any upstream errors clearly.

---

## Using in your agent

Add a stdio MCP server entry in your agent’s configuration that launches `node dist/server.js` and sets `PERPLEXICA_BASE_URL` if it differs from the default.

Example (generic MCP config shape):

```json
{
  "mcpServers": {
    "perplexica": {
      "type": "stdio",
      "command": "node",
      "args": ["dist/server.js"],
      "env": { "PERPLEXICA_BASE_URL": "http://localhost:3000" }
    }
  }
}
```

After starting your agent, call the `perplexica.search` tool with the input schema below.

---

## Tool API

Tool name: `perplexica.search`

Input (Zod shape):

- `query` (string, required): The user’s question/search.
- `focusMode` (enum): `webSearch | academicSearch | writingAssistant | wolframAlphaSearch | youtubeSearch | redditSearch` (default `webSearch`).
- `optimizationMode` (enum): `speed | balanced` (default `balanced`).
- `baseUrl` (string): Perplexica base URL (defaults to `PERPLEXICA_BASE_URL` or `http://localhost:3000`).
- `chatModel` (object, optional): `{ provider, name, customOpenAIBaseURL?, customOpenAIKey? }`.
- `embeddingModel` (object, optional): `{ provider, name }`.
- `systemInstructions` (string, optional): Extra guidance for Perplexica.
- `history` (array, optional): Tuples like `[role, text][]` where role ∈ `human | assistant`.
- `stream` (boolean): Currently returns final result only (default `false`).
- `timeoutMs` (number): HTTP abort timeout (default 120000).

Output:

- A single text block containing the synthesized answer followed by a numbered Sources list (`1. Title: URL`).

---

## Environment variables

- `PERPLEXICA_BASE_URL` (default `http://localhost:3000`): Where to reach Perplexica.
- `MCP_REQUEST_TIMEOUT_MS` (default `120000`): Default HTTP timeout used by the tool. Lower this to avoid Inspector‑side timeouts on slow searches.

---

## Development

- Install deps: `pnpm install`
- Type‑check & build: `pnpm build`
- Live dev (no build): `pnpm dev`
- Start (built): `pnpm start` (runs `node dist/server.js`)

Recommended workflow:

```bash
# 1) Install and build
pnpm install && pnpm build

# 2) Try it fast via Inspector
pnpm dlx @modelcontextprotocol/inspector -- node dist/server.js

# 3) Iterate in TypeScript
pnpm dlx @modelcontextprotocol/inspector -- node --loader tsx src/server.ts
```

Project notes:

- ESM only (NodeNext). Uses `async/await` and `AbortController` for timeouts.
- Input validation is done with Zod; the MCP inspector UI is driven by the Zod shape.
- Source links are formatted and sorted as `1. **Title**: URL`.

---

## Troubleshooting

- Inspector shows no input boxes / sends `{}`
  - Ensure the server uses `registerTool` with a Zod shape and restart the Inspector so it re‑fetches the schema.

- `--server requires --config` error
  - Either run Inspector without `--server` and pass the command directly, or provide `--config mcp.json --server perplexica`.

- Inspector says: `Command not found, transports removed`
  - Inspector couldn’t spawn `pnpm`. Workarounds: build then run with `node dist/server.js`, use an absolute path to pnpm, or start Inspector with no command and connect via UI.

- Type errors about `process` or missing DOM types
  - Ensure `@types/node` is installed and `tsconfig.json` includes `"types": ["node"], "lib": ["ES2022", "DOM"]`.

- Zod type mismatch (`ZodRawShape` vs `z.object`)
  - `registerTool` expects a Zod shape (record of Zod types), not a `z.object(...)` instance.

- Multiple Zod copies in the tree
  - Pin/dedupe via `pnpm.overrides` for `zod` then `pnpm install && pnpm dedupe`.

- Inspector timeouts on slow searches
  - Lower the tool input `timeoutMs` (e.g., `20000`) or set `MCP_REQUEST_TIMEOUT_MS` below the Inspector’s timeout so the tool returns a clear error.

- Can’t reach Perplexica
  - Verify `PERPLEXICA_BASE_URL` and that your Perplexica instance is running and accessible (default `http://localhost:3000`).

---

## Example: quick invocation

Inside Inspector, call `perplexica.search` with:

```json
{
  "query": "Best 2025 LLM eval threads",
  "focusMode": "redditSearch",
  "optimizationMode": "balanced"
}
```

Expect a concise answer followed by a numbered list of source links.

---

## Why this exists

MCP makes it easy for tools to interoperate across AI agents. This server offers a small, audited surface area that cleanly bridges local agents to Perplexica’s powerful search and synthesis, without leaking secrets or adding heavy dependencies.

