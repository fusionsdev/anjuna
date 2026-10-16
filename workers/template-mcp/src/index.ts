import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { authenticate } from "./auth";
import type { Env } from "./env";
import { registerTools } from "./tools";

/** The MCP protocol endpoint. Authentication happens in the Worker's fetch handler before a request gets here. */
export class TemplateMcp extends McpAgent<Env> {
  server = new McpServer({ name: "anjuna-template-mcp", version: "0.1.0" });

  async init(): Promise<void> {
    registerTools(this.server, this.env);
  }
}

/** The agents SDK default allow-list plus the key headers some clients send instead of Authorization. */
const corsOptions = { headers: "Content-Type, Accept, Authorization, X-API-Key, Api-Key, mcp-session-id, mcp-protocol-version" };

const mcp = TemplateMcp.serve("/mcp", { transport: "streamable-http", corsOptions });
/** Legacy SSE transport: GET /sse opens the stream, POST /sse/message?sessionId=... carries requests. */
const sse = TemplateMcp.serveSSE("/sse", { corsOptions });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") return json({ ok: true });
    const handler = pathname === "/mcp" ? mcp : pathname === "/sse" || pathname === "/sse/message" ? sse : null;
    if (!handler) return json({ error: "not_found" }, 404);
    if (request.method === "OPTIONS") return handler.fetch(request, env, ctx);
    const auth = await authenticate(request, env);
    if (!auth.ok) return auth.response;
    return handler.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
