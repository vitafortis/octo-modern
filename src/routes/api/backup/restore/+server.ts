import { json } from '@sveltejs/kit';
import { BackupError, decodeBackup } from '#lib/server/backup.ts';
import { applyRestore, NO_CATEGORIES, previewRestore, summarizeResult, validatePayload, type BackupInclude } from '#lib/server/config-backup.ts';
import { BadRequest, handler } from '#lib/server/http.ts';
import { printers } from '#lib/server/octoprint/manager.ts';
import { audit } from '#lib/server/permissions.ts';
import type { RequestHandler } from './$types';

const flag = (v: unknown) => v === true || v === 'true' || v === 'on' || v === '1';

/**
 * Restores a backup. Takes multipart (`file`, `passphrase`, `mode`, and `printers`
 * / `users` / `settings` / `notifications` / `history` / `queue` flags) or JSON (`{ file, passphrase, mode, apply: {...} }`,
 * where `file` is the file's text or parsed JSON). `mode: 'preview'` only decrypts and
 * reports what would change; `mode: 'apply'` merges the chosen categories.
 */
export const POST: RequestHandler = handler(async ({ request, locals }) => {
	let file: unknown;
	let passphrase: unknown;
	let mode: unknown;
	let choice: BackupInclude = { ...NO_CATEGORIES };
	if ((request.headers.get('content-type') ?? '').startsWith('multipart/form-data')) {
		const form = await request.formData();
		const f = form.get('file');
		file = typeof f === 'string' ? f : f ? await f.text() : undefined;
		passphrase = form.get('passphrase');
		mode = form.get('mode');
		choice = { printers: flag(form.get('printers')), users: flag(form.get('users')), settings: flag(form.get('settings')), notifications: flag(form.get('notifications')), history: flag(form.get('history')), queue: flag(form.get('queue')) };
	} else {
		const body = await request.json().catch(() => ({}));
		file = body.file;
		passphrase = body.passphrase;
		mode = body.mode;
		const a = body.apply && typeof body.apply === 'object' ? body.apply : {};
		choice = { printers: flag(a.printers), users: flag(a.users), settings: flag(a.settings), notifications: flag(a.notifications), history: flag(a.history), queue: flag(a.queue) };
	}
	if (!file) throw new BadRequest('Choose a backup file');
	if (typeof passphrase !== 'string' || !passphrase) throw new BadRequest('Enter the backup passphrase');
	if (mode !== 'preview' && mode !== 'apply') throw new BadRequest('"mode" must be preview or apply');

	try {
		const { envelope, payload: raw } = await decodeBackup(file, passphrase);
		const payload = validatePayload(raw);
		const actorId = locals.user?.id ?? null;
		if (mode === 'preview') {
			return json(previewRestore(payload, actorId, { createdAt: envelope.createdAt, appVersion: envelope.appVersion }));
		}
		if (!Object.values(choice).some(Boolean)) throw new BadRequest('Choose at least one thing to restore');
		const result = applyRestore(payload, choice, actorId);
		for (const id of result.changedPrinterIds) printers.forget(id);
		audit(locals, 'backup.restore', { detail: `from ${envelope.createdAt.slice(0, 10)}: ${summarizeResult(result)}` });
		return json(result);
	} catch (err) {
		if (err instanceof BackupError) throw new BadRequest(err.message);
		throw err;
	}
});
