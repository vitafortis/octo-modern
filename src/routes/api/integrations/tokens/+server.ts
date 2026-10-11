import { json } from '@sveltejs/kit';
import { BadRequest, handler } from '#lib/server/http.ts';
import { audit } from '#lib/server/permissions.ts';
import { createToken, listTokens, parseTokenInput } from '#lib/server/api-tokens.ts';
import { describeUploadTarget, uploadTargetProblem } from '#lib/server/octoprint-compat.ts';
import type { RequestHandler } from './$types';

// /api/integrations/* is admin-only (access.ts).

/** Tokens, with a readable destination for upload keys. */
export const GET: RequestHandler = handler(() =>
	json(listTokens().map((t) => (t.options.upload ? { ...t, destination: describeUploadTarget(t.options.upload), problem: uploadTargetProblem(t.options.upload) } : t)))
);

/** Creates a status token or a slicer upload key; the response is the only time the full token is shown. */
export const POST: RequestHandler = handler(async ({ request, locals }) => {
	const input = parseTokenInput(await request.json().catch(() => null));
	const upload = input.options?.upload;
	if (upload) {
		const problem = uploadTargetProblem(upload);
		if (problem) throw new BadRequest(problem);
	}
	const { token, record } = createToken(input, locals.user);
	audit(locals, 'token.create', {
		detail: `${record.name} (${record.prefix}…)${upload ? `, slicer upload → ${describeUploadTarget(upload)}` : ''}${record.options.bedClear ? ', may confirm bed clear' : ''}${record.includeAddresses ? ', with addresses' : ''}${record.expiresAt ? `, expires ${record.expiresAt.slice(0, 10)}` : ''}`
	});
	return json({ token, record: upload ? { ...record, destination: describeUploadTarget(upload), problem: null } : record }, { status: 201 });
});
