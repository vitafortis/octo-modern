import { handleMcp, methodNotAllowed } from '#lib/server/mcp/server.ts';
import type { RequestHandler } from './$types';

/**
 * The MCP server (Streamable HTTP, stateless). hooks.server.ts checks the Origin and the
 * MCP token and puts the call's context in `locals.mcp`; nothing else reaches here.
 */
export const POST: RequestHandler = ({ request, locals }) => handleMcp(request, locals.mcp!);

export const GET: RequestHandler = () => methodNotAllowed();
export const DELETE: RequestHandler = () => methodNotAllowed();
