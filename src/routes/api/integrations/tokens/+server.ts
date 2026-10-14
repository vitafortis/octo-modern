import { json } from '@sveltejs/kit';
import { BadRequest, handler } from '#lib/server/http.ts';
import { audit } from '#lib/server/permissions.ts';
import { createToken, listTokens, parseTokenInput, publicToken, type ApiToken } from '#lib/server/api-tokens.ts';
import { describeUploadTarget, uploadTargetProblem } from '#lib/server/octoprint-compat.ts';
import { describeMcpToken, mcpTokenProblem } from '#lib/server/mcp/principal.ts';
import { getPrinter } from '#lib/server/store.ts';
import type { RequestHandler } from './$types';

// /api/integrations/* is admin-only (access.ts).

/** For the browser: a readable destination for upload keys, what an MCP token may do. */
function view(t: ApiToken) {
	const out = publicToken(t);
	if (t.options.upload) return { ...out, destination: describeUploadTarget(t.options.upload), problem: uploadTargetProblem(t.options.upload) };
	if (t.options.mcp) return { ...out, destination: describeMcpToken(t.options.mcp), problem: mcpTokenProblem(t) };
	return out;
}

/** Tokens, with a readable destination for upload keys. */
export const GET: RequestHandler = handler(() => json(listTokens().map(view)));

/** Creates a status token, a slicer upload key or an MCP token; the response is the only time the full token is shown. */
export const POST: RequestHandler = handler(async ({ request, locals }) => {
	const input = parseTokenInput(await request.json().catch(() => null));
	const upload = input.options?.upload;
	if (upload) {
		const problem = uploadTargetProblem(upload);
		if (problem) throw new BadRequest(problem);
	}
	const mcp = input.options?.mcp;
	if (mcp && mcp.printers !== 'all' && mcp.printers.some((id) => !getPrinter(id))) throw new BadRequest('One of the chosen printers doesn’t exist');
	const { token, record } = createToken(input, locals.user);
	audit(locals, 'token.create', {
		detail: `${record.name} (${record.prefix}…)${upload ? `, slicer upload → ${describeUploadTarget(upload)}` : ''}${mcp ? `, MCP: ${describeMcpToken(mcp)}` : ''}${record.options.bedClear ? ', may confirm bed clear' : ''}${record.includeAddresses ? ', with addresses' : ''}${record.expiresAt ? `, expires ${record.expiresAt.slice(0, 10)}` : ''}`
	});
	return json({ token, record: view(record) }, { status: 201 });
});
