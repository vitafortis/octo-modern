/**
 * Who an MCP call acts as, and on which printers.
 *
 * An MCP token (api-tokens.ts, scope `mcp`) acts on behalf of the user who created it,
 * re-read on every request: it can never do more than that user may do *now*. A disabled
 * or removed creator makes the token useless; a demoted one shrinks it (an operator
 * turned viewer loses the control tools; a lost printer grant hides that printer). On
 * top, the token limits itself: `read` tokens never control anything, and a token made
 * for some printers sees only those.
 */
import { getPrinter, getUser } from '../store.ts';
import { openUser } from '../auth.ts';
import { roleAllows } from '../access.ts';
import { canControl, canSee, visiblePrinters } from '../permissions.ts';
import type { McpTokenOptions, TokenPrincipal } from '../api-tokens.ts';
import type { Printer, User } from '#lib/types.ts';

export interface McpContext {
	token: { id: string; name: string };
	access: McpTokenOptions['access'];
	/** Every printer the creator can see, or only these ids. */
	printers: McpTokenOptions['printers'];
	/** The creator, as they are now. */
	user: User;
	/** For the shared actions and the audit log: acts as the creator, says it was through this token. */
	locals: { user: User; ip?: string; via: string };
}

export type McpResolve = { ok: true; ctx: McpContext } | { ok: false; status: number; message: string };

/** The creator of a token as they are now (the stand-in admin when sign-in is disabled). */
export function tokenCreator(createdById: string | null | undefined): User | null {
	if (!createdById) return null;
	// OCM_AUTH=disabled: tokens are created by the stand-in admin (auth.ts).
	if (createdById === 'open') return openUser();
	const u = getUser(createdById);
	return u && !u.disabled ? u : null;
}

/** The context of a call with this (valid) token, or why it can't do anything. */
export function resolveContext(p: TokenPrincipal, ip?: string): McpResolve {
	const mcp = p.options.mcp;
	if (!mcp) return { ok: false, status: 401, message: 'Not an MCP token' };
	const user = tokenCreator(p.createdById);
	if (!user) return { ok: false, status: 403, message: 'The account that created this MCP token is disabled or was removed; create a new token' };
	return {
		ok: true,
		ctx: { token: { id: p.id, name: p.name }, access: mcp.access, printers: mcp.printers, user, locals: { user, ip, via: `MCP token “${p.name}”` } }
	};
}

/** The token covers this printer (before asking whether the creator may see it). */
export function inScope(ctx: Pick<McpContext, 'printers'>, printerId: string): boolean {
	return ctx.printers === 'all' || ctx.printers.includes(printerId);
}

/** Printer ids the token covers that the creator can see. */
export function scopedPrinters(ctx: McpContext): Printer[] {
	return visiblePrinters(ctx.user).filter((p) => inScope(ctx, p.id));
}

/** Control tools are offered: a `control` token whose creator may still control printers. */
export function mayControl(ctx: McpContext): boolean {
	return ctx.access === 'control' && roleAllows(ctx.user.role, 'control');
}

/** The printer, if this call may see it (and control it, with `control`). */
export function canUsePrinter(ctx: McpContext, printer: Pick<Printer, 'id'>, need: 'view' | 'control'): boolean {
	if (!inScope(ctx, printer.id) || !canSee(ctx.user, printer)) return false;
	return need === 'view' || (mayControl(ctx) && canControl(ctx.user, printer));
}

export class ToolError extends Error {
	data?: Record<string, unknown>;
	constructor(message: string, data?: Record<string, unknown>) {
		super(message);
		this.name = 'ToolError';
		this.data = data;
	}
}

/**
 * A printer by id or name (case-insensitive; a unique prefix of a name works too).
 * Unknown or ambiguous references are errors that list the printers to choose from.
 */
export function resolvePrinter(ctx: McpContext, ref: unknown, need: 'view' | 'control' = 'view'): Printer {
	if (typeof ref !== 'string' || !ref.trim()) throw new ToolError('"printer" is required: a printer name or id (see list_printers)');
	const visible = scopedPrinters(ctx);
	const names = () => visible.map((p) => `“${p.name}”`).join(', ') || '(none)';
	const want = ref.trim().toLowerCase();
	let matches = visible.filter((p) => p.id === ref.trim());
	if (!matches.length) matches = visible.filter((p) => p.name.trim().toLowerCase() === want);
	if (!matches.length) matches = visible.filter((p) => p.name.trim().toLowerCase().startsWith(want));
	if (!matches.length) throw new ToolError(`No printer “${ref}” here. Printers this token can see: ${names()}`);
	if (matches.length > 1) {
		throw new ToolError(`“${ref}” matches several printers: ${matches.map((p) => `“${p.name}” (id ${p.id})`).join(', ')}. Pass the id instead.`, {
			matches: matches.map((p) => ({ id: p.id, name: p.name }))
		});
	}
	const printer = getPrinter(matches[0].id)!;
	if (need === 'control' && !canUsePrinter(ctx, printer, 'control')) {
		throw new ToolError(
			ctx.access !== 'control'
				? 'This MCP token is read-only'
				: !roleAllows(ctx.user.role, 'control')
					? 'The token’s owner can only watch printers now'
					: `The token’s owner can’t control ${printer.name}`
		);
	}
	return printer;
}

// --- for the Integrations page ---------------------------------------------------------------

/** `Read-only · all printers` / `Control · MK4, Voron`. */
export function describeMcpToken(o: McpTokenOptions): string {
	const which = o.printers === 'all' ? 'all printers' : o.printers.map((id) => getPrinter(id)?.name ?? 'removed printer').join(', ');
	return `${o.access === 'control' ? 'Control' : 'Read-only'} · ${which}`;
}

/** Why a token can't do (all) it was made for, or null. */
export function mcpTokenProblem(t: { options: { mcp?: McpTokenOptions }; createdById?: string | null }): string | null {
	const o = t.options.mcp;
	if (!o) return null;
	const user = tokenCreator(t.createdById);
	if (!user) return 'Its creator is disabled or was removed: it can’t do anything';
	if (o.printers !== 'all') {
		const gone = o.printers.filter((id) => !getPrinter(id));
		if (gone.length === o.printers.length) return 'Its printers were removed';
		if (o.printers.every((id) => !getPrinter(id) || !canSee(user, { id }))) return 'Its creator can no longer see its printers';
	}
	if (o.access === 'control' && !roleAllows(user.role, 'control')) return 'Its creator can only watch printers now: read-only';
	return null;
}
