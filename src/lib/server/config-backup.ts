import { randomUUID } from 'node:crypto';
import { decrypt, encrypt } from './crypto.ts';
import { BackupError } from './backup.ts';
import { deleteKv, getApiKey, getKv, setKv, sqlite } from './store.ts';
import { isRole, type Role } from '#lib/types.ts';
import { checkPortable, exportSettings, importSettings, load as loadNotify, type PortableSettings } from './notify/settings.ts';
import { checkHistory, exportHistory, importHistoryRows, previewHistory, type BackupHistory } from './history/backup.ts';

/**
 * What goes into a backup and how it merges back in. The audit log, sessions and API
 * tokens are deliberately left out: they're logs, transient state, or credentials
 * that should be re-issued.
 */

export interface BackupInclude {
	printers: boolean;
	users: boolean;
	settings: boolean;
	/** Notification channels (with their secrets), rules and options. */
	notifications: boolean;
	/** The print history (can be large). */
	history: boolean;
}

/** Export-only: put the history's pictures in too (bigger file). */
export interface SnapshotOptions {
	historyImages?: boolean;
}

export const NO_CATEGORIES: BackupInclude = { printers: false, users: false, settings: false, notifications: false, history: false };

export interface BackupPrinter {
	id: string;
	name: string;
	baseUrl: string;
	/** Decrypted; re-sealed with the target install's master key on restore. */
	apiKey: string | null;
	verifyTls: boolean;
	webcamUrl: string | null;
	color: string;
	sort: number;
	createdAt: string;
}

export interface BackupUser {
	id: string;
	email: string;
	name: string | null;
	role: Role;
	/** scrypt hash — already one-way. */
	passwordHash: string | null;
	oidcSub: string | null;
	disabled: boolean;
	printerAccess: 'all' | 'selected';
	createdAt: string;
}

export interface BackupSettings {
	sso: Record<string, unknown> | null;
	ssoClientSecret: string | null;
	localLoginDisabled: boolean | null;
	/** Failure detection: the `detect:settings` and `detect:printer:*` rows, the ML API token decrypted (learned baselines are left out). */
	detect?: { rows: Record<string, unknown>; mlToken: string | null };
}

const DETECT_GLOBAL = 'detect:settings';
const isDetectSetting = (key: string) => key === DETECT_GLOBAL || key.startsWith('detect:printer:');

function exportDetect(): BackupSettings['detect'] {
	const rows: Record<string, unknown> = {};
	let mlToken: string | null = null;
	for (const r of sqlite().prepare(`SELECT key, value FROM kv WHERE key LIKE 'detect:%' ORDER BY key`).all() as { key: string; value: string }[]) {
		if (!isDetectSetting(r.key)) continue;
		const v = JSON.parse(r.value);
		if (r.key === DETECT_GLOBAL && v && typeof v === 'object') {
			mlToken = v.sealedToken ? decrypt(v.sealedToken, 'detect:ml-api') : null;
			rows[r.key] = { ...v, sealedToken: null };
		} else rows[r.key] = v;
	}
	return { rows, mlToken };
}

/** Replaces the failure detection settings (call inside the restore's transaction). */
function importDetect(d: NonNullable<BackupSettings['detect']>) {
	const h = sqlite();
	for (const r of h.prepare(`SELECT key FROM kv WHERE key LIKE 'detect:%'`).all() as { key: string }[]) if (isDetectSetting(r.key)) deleteKv(r.key);
	for (const [key, value] of Object.entries(d.rows ?? {})) {
		if (!isDetectSetting(key)) continue;
		if (key === DETECT_GLOBAL && value && typeof value === 'object') setKv(key, { ...value, sealedToken: d.mlToken ? encrypt(d.mlToken, 'detect:ml-api') : null });
		else setKv(key, value);
	}
}

export interface BackupPayload {
	include: BackupInclude;
	printers?: BackupPrinter[];
	users?: BackupUser[];
	grants?: { userId: string; printerId: string }[];
	settings?: BackupSettings;
	notifications?: PortableSettings;
	history?: BackupHistory;
}

type Row = Record<string, unknown>;

/** The running version (same value the sidebar shows). */
export function appVersion(): string {
	return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown';
}

// --- export ------------------------------------------------------------------

export function snapshot(include: BackupInclude, opts: SnapshotOptions = {}): BackupPayload {
	const h = sqlite();
	const payload: BackupPayload = { include };
	if (include.notifications) payload.notifications = exportSettings();
	if (include.history) payload.history = exportHistory(!!opts.historyImages);
	if (include.printers) {
		payload.printers = (h.prepare('SELECT * FROM printers ORDER BY sort, name COLLATE NOCASE').all() as Row[]).map((r) => ({
			id: r.id as string,
			name: r.name as string,
			baseUrl: r.base_url as string,
			apiKey: getApiKey(r.id as string) ?? null,
			verifyTls: r.verify_tls !== 0,
			webcamUrl: (r.webcam_url as string) ?? null,
			color: r.color as string,
			sort: (r.sort as number) ?? 0,
			createdAt: r.created_at as string
		}));
	}
	if (include.users) {
		payload.users = (h.prepare('SELECT * FROM users ORDER BY email').all() as Row[]).map((r) => ({
			id: r.id as string,
			email: r.email as string,
			name: (r.name as string) ?? null,
			role: r.role as Role,
			passwordHash: (r.password_hash as string) ?? null,
			oidcSub: (r.oidc_sub as string) ?? null,
			disabled: r.disabled === 1,
			printerAccess: r.printer_access === 'selected' ? 'selected' : 'all',
			createdAt: r.created_at as string
		}));
		payload.grants = (h.prepare('SELECT * FROM grants').all() as Row[]).map((r) => ({ userId: r.user_id as string, printerId: r.printer_id as string }));
	}
	if (include.settings) {
		const sealed = getKv<string | null>('sso-secret', null);
		payload.settings = {
			sso: getKv<Record<string, unknown> | null>('sso', null),
			ssoClientSecret: sealed ? decrypt(sealed, 'sso') : null,
			localLoginDisabled: getKv<boolean | null>('local-login-disabled', null),
			detect: exportDetect()
		};
	}
	return payload;
}

export function summarizeInclude(p: BackupPayload): string {
	const parts: string[] = [];
	if (p.printers) parts.push(`${p.printers.length} printers`);
	if (p.users) parts.push(`${p.users.length} users`, `${p.grants?.length ?? 0} grants`);
	if (p.settings) parts.push(`settings${p.settings.sso ? ' (SSO)' : ''}`);
	if (p.notifications) parts.push(`${p.notifications.channels.length} notification channels`);
	if (p.history) parts.push(`${p.history.prints.length} history entries${p.history.images ? ' with pictures' : ''}`);
	return parts.join(', ') || 'nothing';
}

// --- validation ----------------------------------------------------------------

function str(v: unknown, what: string): string {
	if (typeof v !== 'string' || !v) throw new BackupError(`Damaged backup: bad ${what}`);
	return v;
}

/** Checks the decrypted payload's shape before anything touches the store. */
export function validatePayload(raw: unknown): BackupPayload {
	if (!raw || typeof raw !== 'object') throw new BackupError('Damaged backup: no payload');
	const p = raw as BackupPayload;
	const inc: Partial<BackupInclude> = p.include ?? { printers: !!p.printers, users: !!p.users, settings: !!p.settings };
	if (p.printers !== undefined) {
		if (!Array.isArray(p.printers)) throw new BackupError('Damaged backup: printers');
		for (const s of p.printers) {
			str(s.id, 'printer id');
			str(s.name, 'printer name');
			if (!/^https?:\/\//.test(str(s.baseUrl, 'printer URL'))) throw new BackupError(`Damaged backup: URL of ${s.name}`);
			if (s.apiKey !== null && typeof s.apiKey !== 'string') throw new BackupError(`Damaged backup: API key of ${s.name}`);
			if (s.webcamUrl !== null && s.webcamUrl !== undefined && typeof s.webcamUrl !== 'string') s.webcamUrl = null;
		}
	}
	if (p.users !== undefined) {
		if (!Array.isArray(p.users)) throw new BackupError('Damaged backup: users');
		for (const u of p.users) {
			str(u.id, 'user id');
			str(u.email, 'user email');
			if (!isRole(u.role)) throw new BackupError(`Damaged backup: role of ${u.email}`);
			if (u.printerAccess !== 'all' && u.printerAccess !== 'selected') u.printerAccess = 'all';
		}
	}
	if (p.grants !== undefined && !Array.isArray(p.grants)) throw new BackupError('Damaged backup: grants');
	if (p.settings !== undefined && (typeof p.settings !== 'object' || !p.settings)) throw new BackupError('Damaged backup: settings');
	try {
		if (p.notifications !== undefined) checkPortable(p.notifications);
		if (p.history !== undefined) checkHistory(p.history);
	} catch (err) {
		throw new BackupError(`Damaged backup: ${(err as Error).message}`);
	}
	return {
		...p,
		include: { printers: !!inc.printers, users: !!inc.users, settings: !!inc.settings, notifications: !!inc.notifications && !!p.notifications, history: !!inc.history && !!p.history }
	};
}

// --- preview -------------------------------------------------------------------

export type ChangeStatus = 'new' | 'update' | 'self' | 'same' | 'remove';

export interface RestorePreview {
	createdAt: string;
	appVersion: string;
	contains: BackupInclude;
	printers: { id: string; name: string; target: string; hasApiKey: boolean; status: 'new' | 'update' }[];
	users: { email: string; name: string | null; role: Role; status: 'new' | 'update' | 'self' }[];
	grants: number;
	settings: { label: string; detail: string; status: ChangeStatus }[];
	notifications: { channels: { name: string; type: string; status: 'new' | 'update' }[]; rules: number; replaces: number } | null;
	history: { total: number; added: number; images: boolean } | null;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function previewRestore(p: BackupPayload, actorId: string | null, meta: { createdAt: string; appVersion: string }): RestorePreview {
	const h = sqlite();
	const exists = h.prepare('SELECT 1 FROM printers WHERE id = ?');
	const userByEmail = h.prepare('SELECT id FROM users WHERE email = ?');
	const preview: RestorePreview = {
		...meta,
		contains: p.include,
		printers: (p.printers ?? []).map((s) => ({ id: s.id, name: s.name, target: s.baseUrl, hasApiKey: !!s.apiKey, status: exists.get(s.id) ? 'update' : 'new' })),
		users: (p.users ?? []).map((u) => {
			const existing = userByEmail.get(u.email) as { id: string } | undefined;
			return { email: u.email, name: u.name, role: u.role, status: !existing ? 'new' : existing.id === actorId ? 'self' : 'update' };
		}),
		grants: p.grants?.length ?? 0,
		settings: [],
		notifications: null,
		history: null
	};
	if (p.notifications) {
		const here = loadNotify();
		const ids = new Set(here.channels.map((c) => c.id));
		preview.notifications = {
			channels: p.notifications.channels.map((c) => ({ name: c.name, type: c.type, status: ids.has(c.id) ? 'update' : 'new' })),
			rules: p.notifications.rules.length,
			replaces: here.channels.length
		};
	}
	if (p.history) preview.history = { ...previewHistory(p.history), images: !!p.history.images };
	if (p.settings) {
		const s = p.settings;
		const status = (incoming: unknown, current: unknown): ChangeStatus =>
			same(incoming, current) ? 'same' : incoming == null ? 'remove' : current == null ? 'new' : 'update';
		const sso = s.sso as { name?: string; issuer?: string } | null;
		preview.settings.push({
			label: 'Single sign-on',
			detail: sso ? `${sso.name ?? 'SSO'} · ${sso.issuer ?? ''}${s.ssoClientSecret ? ' · with client secret' : ''}` : 'not configured',
			status: status(s.sso, getKv('sso', null))
		});
		if (s.detect) {
			const g = s.detect.rows?.[DETECT_GLOBAL] as { mlApiUrl?: string | null } | undefined;
			const printersSet = Object.keys(s.detect.rows ?? {}).filter((k) => k.startsWith('detect:printer:')).length;
			preview.settings.push({
				label: 'Failure detection',
				detail: `${g?.mlApiUrl ? `ML API ${g.mlApiUrl}${s.detect.mlToken ? ' · with token' : ''}` : 'no ML API'} · ${printersSet} printer setting${printersSet === 1 ? '' : 's'}`,
				status: g || printersSet ? 'update' : 'same'
			});
		}
		preview.settings.push({
			label: 'Password sign-in',
			detail: s.localLoginDisabled ? 'disabled (SSO only)' : 'enabled',
			status: same(!!s.localLoginDisabled, getKv<boolean>('local-login-disabled', false)) ? 'same' : 'update'
		});
	}
	return preview;
}

// --- apply ---------------------------------------------------------------------

export interface RestoreResult {
	printers: { added: number; updated: number };
	users: { added: number; updated: number; skipped: number };
	grants: number;
	settings: boolean;
	notifications: boolean;
	history: { added: number; skipped: number };
	/** Printers whose live connections should be rebuilt. */
	changedPrinterIds: string[];
}

/**
 * Merges a backup into this install in one transaction: printers by id (API keys
 * re-sealed with this install's master key), users by email. The signed-in admin's own
 * account is never touched, and the restore fails rather than leave no enabled admin.
 */
export function applyRestore(p: BackupPayload, choice: BackupInclude, actorId: string | null): RestoreResult {
	const h = sqlite();
	const result: RestoreResult = {
		printers: { added: 0, updated: 0 },
		users: { added: 0, updated: 0, skipped: 0 },
		grants: 0,
		settings: false,
		notifications: false,
		history: { added: 0, skipped: 0 },
		changedPrinterIds: []
	};
	const now = new Date().toISOString();
	h.exec('BEGIN IMMEDIATE');
	try {
		const restoredPrinters = new Set<string>();
		if (choice.printers && p.printers) {
			const exists = h.prepare('SELECT 1 FROM printers WHERE id = ?');
			const update = h.prepare('UPDATE printers SET name = ?, base_url = ?, secret = ?, verify_tls = ?, webcam_url = ?, color = ?, sort = ?, updated_at = ? WHERE id = ?');
			const insert = h.prepare(
				`INSERT INTO printers (id, name, base_url, secret, verify_tls, webcam_url, color, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			);
			for (const s of p.printers) {
				const secret = s.apiKey ? encrypt(JSON.stringify({ apiKey: s.apiKey }), `printer:${s.id}`) : null;
				const fields = [s.name, s.baseUrl, secret, s.verifyTls === false ? 0 : 1, s.webcamUrl ?? null, s.color || 'violet', Number(s.sort) || 0] as const;
				if (exists.get(s.id)) {
					update.run(...fields, now, s.id);
					result.printers.updated++;
				} else {
					insert.run(s.id, ...fields, s.createdAt || now, now);
					result.printers.added++;
				}
				restoredPrinters.add(s.id);
			}
			result.changedPrinterIds = [...restoredPrinters];
		}

		// Backup user id → local user id (users are matched by email).
		const userMap = new Map<string, string>();
		const byEmail = h.prepare('SELECT * FROM users WHERE email = ?');
		for (const u of p.users ?? []) {
			const local = byEmail.get(u.email) as Row | undefined;
			if (local) userMap.set(u.id, local.id as string);
		}

		const restoredUsers = new Set<string>();
		if (choice.users && p.users) {
			const idTaken = h.prepare('SELECT 1 FROM users WHERE id = ?');
			const subOwner = h.prepare('SELECT id FROM users WHERE oidc_sub = ?');
			const update = h.prepare('UPDATE users SET name = ?, role = ?, password_hash = ?, oidc_sub = ?, disabled = ?, printer_access = ? WHERE id = ?');
			const insert = h.prepare(
				'INSERT INTO users (id, email, name, role, password_hash, oidc_sub, disabled, printer_access, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
			);
			const dropSessions = h.prepare('DELETE FROM sessions WHERE user_id = ?');
			for (const u of p.users) {
				const local = byEmail.get(u.email) as Row | undefined;
				if (local && local.id === actorId) {
					result.users.skipped++;
					continue;
				}
				const id = local ? (local.id as string) : idTaken.get(u.id) ? randomUUID() : u.id;
				const owner = u.oidcSub ? (subOwner.get(u.oidcSub) as { id: string } | undefined) : undefined;
				const sub = owner && owner.id !== id ? null : (u.oidcSub ?? null);
				const fields = [u.name ?? null, u.role, u.passwordHash ?? null, sub, u.disabled ? 1 : 0, u.printerAccess] as const;
				if (local) {
					const changed = local.role !== u.role || local.password_hash !== (u.passwordHash ?? null) || (local.disabled === 1) !== !!u.disabled;
					update.run(...fields, id);
					if (changed) dropSessions.run(id);
					result.users.updated++;
				} else {
					insert.run(id, u.email.trim(), ...fields, u.createdAt || now);
					result.users.added++;
				}
				userMap.set(u.id, id);
				restoredUsers.add(id);
			}
			const admins = (h.prepare(`SELECT count(*) AS n FROM users WHERE role = 'admin' AND disabled = 0`).get() as { n: number }).n;
			if (admins === 0) throw new BackupError('Restoring these users would leave no enabled admin');
		}

		if ((restoredUsers.size || restoredPrinters.size) && p.grants) {
			const printerExists = h.prepare('SELECT 1 FROM printers WHERE id = ?');
			const clear = h.prepare('DELETE FROM grants WHERE user_id = ?');
			const put = h.prepare('INSERT OR IGNORE INTO grants (user_id, printer_id) VALUES (?, ?)');
			for (const id of restoredUsers) clear.run(id);
			for (const g of p.grants) {
				const userId = userMap.get(g.userId);
				if (!userId || userId === actorId) continue;
				if (!restoredUsers.has(userId) && !restoredPrinters.has(g.printerId)) continue;
				if (!printerExists.get(g.printerId)) continue;
				put.run(userId, g.printerId);
				result.grants++;
			}
		}

		if (choice.settings && p.settings) {
			const s = p.settings;
			if (s.sso) setKv('sso', s.sso);
			else deleteKv('sso');
			if (s.ssoClientSecret) setKv('sso-secret', encrypt(s.ssoClientSecret, 'sso'));
			else deleteKv('sso-secret');
			if (s.localLoginDisabled != null) setKv('local-login-disabled', !!s.localLoginDisabled);
			else deleteKv('local-login-disabled');
			// Backups from before failure detection have no `detect`: leave it as it is.
			if (s.detect && typeof s.detect === 'object') importDetect(s.detect);
			result.settings = true;
		}

		if (choice.notifications && p.notifications) {
			// Replaced as a whole, secrets re-sealed with this install's key.
			importSettings(p.notifications);
			result.notifications = true;
		}
		if (choice.history && p.history) {
			const userHere = h.prepare('SELECT 1 FROM users WHERE id = ?');
			result.history = importHistoryRows(p.history, (id) => userMap.get(id) ?? (userHere.get(id) ? id : null));
		}
		h.exec('COMMIT');
	} catch (err) {
		h.exec('ROLLBACK');
		throw err;
	}
	return result;
}

export function summarizeResult(r: RestoreResult): string {
	const parts: string[] = [];
	if (r.printers.added || r.printers.updated) parts.push(`printers +${r.printers.added} ~${r.printers.updated}`);
	if (r.users.added || r.users.updated || r.users.skipped) parts.push(`users +${r.users.added} ~${r.users.updated} (kept ${r.users.skipped})`);
	if (r.grants) parts.push(`${r.grants} grants`);
	if (r.settings) parts.push('settings replaced');
	if (r.notifications) parts.push('notifications replaced');
	if (r.history.added || r.history.skipped) parts.push(`history +${r.history.added} (had ${r.history.skipped})`);
	return parts.join('; ') || 'nothing changed';
}
