/**
 * The MCP endpoint (POST /mcp): Streamable HTTP, stateless, plain JSON answers.
 *
 * Built on the official SDK: each request gets a fresh low-level `Server` and a web-standard
 * transport without sessions (`sessionIdGenerator: undefined`, `enableJsonResponse`), so the
 * SDK does the JSON-RPC framing, `initialize` and protocol-version negotiation (it answers
 * with the client's version when supported, else its latest, and rejects an unsupported
 * `MCP-Protocol-Version` header with 400). Tools come from ./tools.ts, filtered for the
 * token (./principal.ts). hooks.server.ts has already checked the Origin and the token.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { callTool, toolsFor, UnknownTool } from './tools.ts';
import { resolveContext, type McpContext } from './principal.ts';
import { authorizeMcpRequest } from '../api-tokens.ts';
import { sameHost } from '../origin.ts';

// __APP_VERSION__ is set at build time (vite.config.ts); tests run without it.
const VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

export const MCP_PATH = '/mcp';

const INSTRUCTIONS = `octo·modern runs 3D printers (OctoPrint and Klipper). Start with list_printers; refer to printers by name or id.
Read tools never change anything. Control tools (when this token has them) act on real machines:
- cancel_print and start_print do nothing without confirm: true — call them without it first, show the user what would happen, and only confirm when the user agrees.
- start_print needs the bed confirmed clear since the last print; only call confirm_bed_clear after a person has checked the bed.
- When start_print answers needs: "preprint" or "filament", ask the user and call again with preprint / ignore_filament_warning.`;

function createServer(ctx: McpContext): Server {
	const server = new Server({ name: 'octo-modern', title: 'octo·modern', version: VERSION }, { capabilities: { tools: { listChanged: false } }, instructions: INSTRUCTIONS });
	server.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: toolsFor(ctx).map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema as { type: 'object' }, annotations: t.annotations }))
	}));
	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		try {
			return await callTool(ctx, req.params.name, req.params.arguments);
		} catch (err) {
			if (err instanceof UnknownTool) throw new McpError(ErrorCode.InvalidParams, err.message);
			throw err;
		}
	});
	return server;
}

/** Answers one POST to /mcp for this token's context. */
export async function handleMcp(request: Request, ctx: McpContext): Promise<Response> {
	const server = createServer(ctx);
	const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
	try {
		await server.connect(transport);
		const res = await transport.handleRequest(request);
		res.headers.set('cache-control', 'no-store');
		return res;
	} finally {
		await transport.close().catch(() => {});
		await server.close().catch(() => {});
	}
}

/** GET (a server-to-client SSE stream) and DELETE (ending a session) aren't offered: stateless, no streams. */
export function methodNotAllowed(): Response {
	return Response.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this MCP server answers POST only (no SSE stream, no sessions)' }, id: null }, { status: 405, headers: { allow: 'POST' } });
}

/** JSON-RPC style error bodies for the hooks (auth, origin): `id` is null, there's no request to answer. */
export function mcpError(status: number, message: string, headers: Record<string, string> = {}): Response {
	return Response.json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }, { status, headers });
}

/**
 * Everything before a call reaches the tools (hooks.server.ts): a browser's Origin must be
 * this host (403, DNS-rebinding protection), POST only (405), a valid MCP token (401;
 * throttled, 429), whose creator is still an active user (403).
 */
export function mcpGate(req: { method: string; url: URL; headers: Headers; ip?: string }): { ok: true; ctx: McpContext } | { ok: false; response: Response } {
	const origin = req.headers.get('origin');
	if (origin && !sameHost(origin, req.url, req.headers)) return { ok: false, response: mcpError(403, 'Cross-origin request blocked') };
	if (req.method !== 'POST') return { ok: false, response: methodNotAllowed() };
	const auth = authorizeMcpRequest({ headers: req.headers, ip: req.ip });
	if (!auth.ok) return { ok: false, response: mcpError(auth.status, auth.message, auth.status === 401 ? { 'www-authenticate': 'Bearer' } : {}) };
	const ctx = resolveContext(auth.principal, req.ip);
	if (!ctx.ok) return { ok: false, response: mcpError(ctx.status, ctx.message) };
	return { ok: true, ctx: ctx.ctx };
}
