import { addAudit, getPrinter, hasGrant, listPrinters } from './store.ts';
import { Forbidden, NotFound } from './http.ts';
import { roleAllows } from './access.ts';
import type { Printer, PrinterAccess, User } from '#lib/types.ts';

/**
 * Who can see and control which printer:
 * - admins see and control everything
 * - operators control the printers they can see
 * - viewers only watch
 * Non-admins see every printer, or only those granted to them (`printerAccess`).
 */
export function canSee(user: User | null, printer: Pick<Printer, 'id'>): boolean {
	if (!user) return false;
	if (user.role === 'admin' || user.printerAccess === 'all') return true;
	return hasGrant(user.id, printer.id);
}

export function canControl(user: User | null, printer: Pick<Printer, 'id'>): boolean {
	return !!user && roleAllows(user.role, 'control') && canSee(user, printer);
}

export function accessFor(user: User | null, printer: Pick<Printer, 'id'>): PrinterAccess {
	return { control: canControl(user, printer) };
}

/** Printers the user can see, each annotated with their access. */
export function visiblePrinters(user: User | null): Printer[] {
	if (!user) return [];
	return listPrinters()
		.filter((p) => canSee(user, p))
		.map((p) => ({ ...p, access: accessFor(user, p) }));
}

export function withAccess(user: User | null, printer: Printer): Printer {
	return { ...printer, access: accessFor(user, printer) };
}

/** The printer, if the user may see it (404 otherwise, so hidden printers don't exist). */
export function requirePrinter(user: User | null, id: string): Printer {
	const p = getPrinter(id);
	if (!p || !canSee(user, p)) throw new NotFound('Printer not found');
	return p;
}

/** The printer, if the user may control it. */
export function requireControl(user: User | null, id: string): Printer {
	const p = requirePrinter(user, id);
	if (!canControl(user, p)) throw new Forbidden('Your role can only watch this printer');
	return p;
}

/**
 * Records who did what; printer names are copied so entries outlive them. `locals.via`
 * (an MCP call: `MCP token “Name”`) is added to the detail, so the log says how it was done.
 */
export function audit(
	locals: { user: User | null; ip?: string; via?: string },
	action: string,
	opts: { printer?: Pick<Printer, 'id' | 'name'>; detail?: string; /** Acting user, when not yet signed in (logins). */ as?: Pick<User, 'id' | 'email'> } = {}
) {
	try {
		addAudit({
			userId: (opts.as ?? locals.user)?.id ?? null,
			userEmail: (opts.as ?? locals.user)?.email ?? null,
			action,
			printerId: opts.printer?.id ?? null,
			printerName: opts.printer?.name ?? null,
			detail: locals.via ? (opts.detail ? `${opts.detail} (via ${locals.via})` : `via ${locals.via}`).slice(0, 500) : (opts.detail ?? null),
			ip: locals.ip ?? null
		});
	} catch (err) {
		console.error('[octo-modern] audit write failed', err);
	}
}
