# AGENTS.md — Perplexica MCP Server

This repo hosts a minimal **Model Context Protocol (MCP) tool server** exposing `perplexica.search`, a proxy to Perplexica’s `/api/search` for local LLM agents (e.g., Codex CLI, Claude Desktop, Open WebUI).

---

## What agents should know (TL;DR)

* **Primary tool:** `perplexica.search` (stdio transport).
* **Runtime:** Node ≥ 18.17, TypeScript, ESM (NodeNext), pnpm.
* **Key deps:** `@modelcontextprotocol/sdk`, `zod`, `tsx`, `typescript`, `@types/node`.
* **Env:** `PERPLEXICA_BASE_URL` (defaults to `http://localhost:3000`).
* **Request:** `{ query, focusMode, optimizationMode, chatModel?, embeddingModel?, systemInstructions?, history?, stream=false }`.
* **Response:** final synthesized **message** + **sources** list (title + URL).

---

## Repo map & entrypoints

* `src/server.ts` — MCP server; registers `perplexica.search` using **Zod** input schema via `registerTool`.
* `dist/server.js` — build output (don’t edit).
* `tsconfig.json` — NodeNext ESM, DOM + Node libs for `fetch` and `process` types.
* `package.json` — scripts (`dev`, `build`, `start`) and pnpm overrides.

---

## Dev environment tips (pnpm-first)

* Install deps: `pnpm install`
* Type-check & build: `pnpm build`
* Live dev (no build): `pnpm dev`
* Run with MCP Inspector (dev):

    * **Option A:** `pnpm dlx @modelcontextprotocol/inspector -- node --loader tsx src/server.ts`
    * **Option B (after build):** `pnpm dlx @modelcontextprotocol/inspector -- node dist/server.js`
* Inspector + config file:

    1. Create `mcp.json`:

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
    2. Run: `pnpm dlx @modelcontextprotocol/inspector --config ./mcp.json --server perplexica`

> If Inspector shows no input boxes: ensure we use **`registerTool` with a Zod schema** (not the JSON schema helper), and restart Inspector so it re-fetches the schema.

---

## How agents should call the tool

**Tool name:** `perplexica.search`
* For detailed HTTP API specs, see [Perplexica API Documentation](perplexica-api.md).

**Input schema (Zod shape):**

* `query` *(string, required)* — user question/search.
* `focusMode` *(enum)* — one of `webSearch | academicSearch | writingAssistant | wolframAlphaSearch | youtubeSearch | redditSearch` (default `webSearch`).
* `optimizationMode` *(enum)* — `speed | balanced` (default `balanced`).
* `baseUrl` *(string)* — Perplexica URL (default from env or `http://localhost:3000`).
* `chatModel` *(object, optional)* — `{ provider, name, customOpenAIBaseURL?, customOpenAIKey? }`.
* `embeddingModel` *(object, optional)* — `{ provider, name }`.
* `systemInstructions` *(string, optional)* — extra guidance for Perplexica.
* `history` *(array, optional)* — `[role, text][]` where role ∈ `human | assistant`.
* `stream` *(boolean, default false)* — we currently return only the final result.
* `timeoutMs` *(number, default 120000)* — HTTP abort timeout.

**Output:** a single text block combining the synthesized answer + a numbered **Sources** list.

---

## Local Perplexica expectations

* Perplexica must be reachable at `PERPLEXICA_BASE_URL` (default `http://localhost:3000`).
* We POST to `BASE_URL/api/search` with the fields above. If unavailable, the tool returns a clear MCP error.

---

## Common failure modes & playbook

1. **Inspector error `Missing focus mode or query`**

    * Cause: tool schema not rendered → empty `{}` sent.
    * Fix: use `registerTool` with **Zod** shape; restart Inspector.
2. **`--server requires --config`** when running Inspector

    * Use either `pnpm dlx @modelcontextprotocol/inspector pnpm tsx src/server.ts` (no `--server`) *or* supply `--config mcp.json --server <name>`.
3. **Inspector message: `Command not found, transports removed`**

    * Inspector couldn’t spawn `pnpm`. Workarounds:

        * Build then run with `node dist/server.js`, or
        * Use absolute path to pnpm, or
        * Start Inspector with no command and connect via UI (stdio: `node dist/server.js`).
4. **Type errors about `process` or missing DOM types**

    * Ensure `@types/node` is installed and `tsconfig.json` includes `"types": ["node"], "lib": ["ES2022", "DOM"]`.
5. **Zod type mismatches (`ZodRawShape` vs `z.object`)**

    * `registerTool` expects a **shape** (record of Zod types), not a `z.object(...)`. Export a shape and pass it directly.
6. **Two Zod copies in the tree**

    * Deduplicate with a `pnpm.overrides` pin for `zod`, then `pnpm install && pnpm dedupe`.

---

## Coding standards

* Keep the server minimal and deterministic; avoid logging secrets.
* ESM only (no CJS). Prefer `async/await` and top-level `await` for transport startup.
* Use `AbortController` for HTTP timeouts; default 120s.
* Handle non-OK HTTP statuses by returning `isError: true` with the upstream text payload.
* Sort and format source links as: `1. **Title**: URL`.

---

## Testing instructions

* **Manual (Inspector):**

    * Invoke `perplexica.search` with: `{ "query": "Latest CUDA updates in 2025", "focusMode": "webSearch" }`.
    * Expect: a coherent message + source list.
* **Smoke script (optional):** Add a small Node script that `spawn`s `dist/server.js`, sends an MCP `callTool` request, and asserts non-empty text content.
* **Lint/typecheck:** `pnpm build` must succeed; add `pnpm dlx tsc -p tsconfig.json --noEmit` in CI.

---

## PR workflow

* Branch from `main`, keep changes scoped.
* Before commit: `pnpm build` (typecheck) and a manual Inspector run.
* Commit messages: imperative, present tense; include **What**/**Why**/**Notes** for behavior changes.
* In PR description, include: repro steps (if bug), risk areas, and any config changes.

---

## Secrets & configuration

* Never echo `customOpenAIKey` or other secrets in logs or tool output.
* Prefer secrets via environment (`process.env`) inside the tool.
* Do not commit `.env` files.

---

## Extending the server

* **Add streaming:** Register `perplexica.search.stream` that sets `stream: true` and parses NDJSON, emitting incremental MCP messages.
* **Add healthcheck tool:** `perplexica.health` that GETs `BASE_URL/health` (if Perplexica exposes it) and returns status.
* **Extra focus modes:** If Perplexica adds modes (e.g., `arxivSearch`), extend the Zod enum and payload.

---

## Triage checklist (for agents)

* [ ] Is Perplexica reachable at `PERPLEXICA_BASE_URL`?
* [ ] Does Inspector show input boxes? If not, restart after ensuring `registerTool` + Zod shape.
* [ ] Are `@types/node`, `zod`, `typescript`, `tsx` installed and tsconfig includes Node + DOM libs?
* [ ] Any duplicate `zod` versions? Run `pnpm ls zod` and pin via overrides if needed.
* [ ] Using `node dist/server.js` when Inspector can’t find `pnpm`?

---

## Example invocations (Codex CLI style)

* **Goal prompt:** “Add support for `redditSearch` focus mode and document it.”
* **Context to load:** `src/server.ts`, `tsconfig.json`, `package.json`.
* **Run/test plan:**

    1. Edit Zod enum, rebuild.
    2. Start Inspector and invoke with `{ "query": "Best 2025 LLM eval threads", "focusMode": "redditSearch" }`.
    3. Validate response contains message + source links.

---

## Appendix: Commands

```bash
# Install
pnpm install

# Build (typecheck)
pnpm build

# Start (built)
pnpm start    # node dist/server.js

# Inspector (dev, TypeScript without build)
pnpm dlx @modelcontextprotocol/inspector -- node --loader tsx src/server.ts

# Inspector (after build)
pnpm dlx @modelcontextprotocol/inspector -- node dist/server.js
```
