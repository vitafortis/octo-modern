import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.ts';
import { decrypt, encrypt } from './crypto.ts';
import type { AuditEvent, Printer, PrinterInput, Role, User } from '#lib/types.ts';

let handle: DatabaseSync | undefined;

/** Opens the store on first use, so importing this module (e.g. during build) has no side effects. */
function db(): DatabaseSync {
	if (handle) return handle;
	mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
	const dbPath = join(config.dataDir, 'octo-modern.db');
	handle = new DatabaseSync(dbPath);
	try {
		chmodSync(dbPath, 0o600);
	} catch {
		// Best effort — some mounted volumes don't support chmod.
	}
	handle.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA foreign_keys = ON;
		CREATE TABLE IF NOT EXISTS kv (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
	`);
	migrate(handle);
	return handle;
}

/**
 * Schema changes, applied in order, each exactly once (recorded in kv as
 * `migration:<name>`). Append new ones at the end; never edit an applied one.
 */
const MIGRATIONS: [string, (h: DatabaseSync) => void][] = [
	[
		'001-initial',
		(h) =>
			h.exec(`
			-- OctoPrint servers. The API key is sealed in "secret", bound to the printer id.
			CREATE TABLE IF NOT EXISTS printers (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				base_url TEXT NOT NULL,
				secret TEXT,
				verify_tls INTEGER NOT NULL DEFAULT 1,
				webcam_url TEXT,
				color TEXT NOT NULL DEFAULT 'violet',
				sort INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				last_seen_at TEXT,
				octoprint_version TEXT
			);

			CREATE TABLE IF NOT EXISTS users (
				id TEXT PRIMARY KEY,
				email TEXT NOT NULL UNIQUE COLLATE NOCASE,
				name TEXT,
				role TEXT NOT NULL DEFAULT 'viewer',
				password_hash TEXT,
				oidc_sub TEXT UNIQUE,
				disabled INTEGER NOT NULL DEFAULT 0,
				printer_access TEXT NOT NULL DEFAULT 'all',
				created_at TEXT NOT NULL,
				last_login_at TEXT
			);

			CREATE TABLE IF NOT EXISTS sessions (
				token_hash TEXT PRIMARY KEY,
				user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
				expires_at INTEGER NOT NULL
			);

			-- Printers a user whose printer_access is 'selected' may see.
			CREATE TABLE IF NOT EXISTS grants (
				user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
				printer_id TEXT NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
				PRIMARY KEY (user_id, printer_id)
			);

			-- Who did what. Printer and user names are copied so entries outlive them.
			CREATE TABLE IF NOT EXISTS audit (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				at TEXT NOT NULL,
				user_id TEXT,
				user_email TEXT,
				action TEXT NOT NULL,
				printer_id TEXT,
				printer_name TEXT,
				detail TEXT,
				ip TEXT
			);
			CREATE INDEX IF NOT EXISTS audit_time ON audit(id DESC);
			CREATE INDEX IF NOT EXISTS audit_printer ON audit(printer_id, id DESC);

			-- Read-only tokens for dashboards. Only a SHA-256 of the token is kept.
			CREATE TABLE IF NOT EXISTS api_tokens (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				token_hash TEXT NOT NULL UNIQUE,
				prefix TEXT NOT NULL,
				scope TEXT NOT NULL DEFAULT 'status',
				include_addresses INTEGER NOT NULL DEFAULT 0,
				expires_at TEXT,
				created_by TEXT,
				created_by_email TEXT,
				created_at TEXT NOT NULL,
				last_used_at TEXT,
				last_used_ip TEXT,
				revoked_at TEXT
			);
		`)
	],
	[
		'library-001',
		(h) =>
			h.exec(`
			-- Library sources: where G-code lives on the NAS. Credentials are sealed in "secret", bound to the id.
			CREATE TABLE IF NOT EXISTS library_sources (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				kind TEXT NOT NULL,
				config TEXT NOT NULL,
				secret TEXT,
				writable INTEGER NOT NULL DEFAULT 0,
				printers TEXT NOT NULL DEFAULT '"all"',
				sort INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			-- Slicer metadata and thumbnails read from library files, valid while size and mtime ("version") match.
			CREATE TABLE IF NOT EXISTS library_meta (
				source_id TEXT NOT NULL REFERENCES library_sources(id) ON DELETE CASCADE,
				path TEXT NOT NULL,
				version TEXT NOT NULL,
				meta TEXT NOT NULL,
				thumb BLOB,
				thumb_type TEXT,
				parsed_at INTEGER NOT NULL,
				PRIMARY KEY (source_id, path)
			);
			CREATE INDEX IF NOT EXISTS library_meta_age ON library_meta(parsed_at);
		`)
	],
	[
		'history-001-prints',
		(h) =>
			h.exec(`
			-- Print history (see history/store.ts). No foreign key: entries outlive their printer.
			CREATE TABLE IF NOT EXISTS prints (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				printer_id TEXT NOT NULL,
				printer_name TEXT NOT NULL,
				file_name TEXT NOT NULL,
				file_path TEXT NOT NULL,
				origin TEXT NOT NULL DEFAULT 'local',
				started_at TEXT NOT NULL,
				ended_at TEXT,
				duration_s REAL,
				result TEXT NOT NULL,
				reason TEXT,
				filament_mm REAL,
				estimated_s REAL,
				completion REAL,
				user_id TEXT,
				started_by TEXT,
				octoprint_user TEXT,
				source TEXT NOT NULL DEFAULT 'live',
				thumbnail BLOB,
				thumbnail_type TEXT,
				notes TEXT,
				external_key TEXT UNIQUE
			);
			CREATE INDEX IF NOT EXISTS prints_time ON prints(started_at DESC);
			CREATE INDEX IF NOT EXISTS prints_printer ON prints(printer_id, started_at DESC);
		`)
	],
	[
		'queue-001',
		(h) =>
			h.exec(`
			-- Print queue (see queue/store.ts). Jobs keep their order in "position".
			CREATE TABLE IF NOT EXISTS queue_jobs (
				id TEXT PRIMARY KEY,
				position REAL NOT NULL,
				name TEXT NOT NULL,
				source_kind TEXT NOT NULL,
				source_id TEXT,
				source_path TEXT NOT NULL DEFAULT '',
				size INTEGER,
				printer_id TEXT,
				tags TEXT NOT NULL DEFAULT '[]',
				copies INTEGER NOT NULL DEFAULT 1,
				done INTEGER NOT NULL DEFAULT 0,
				status TEXT NOT NULL DEFAULT 'queued',
				active_printer_id TEXT,
				active_path TEXT,
				error TEXT,
				created_by TEXT,
				created_by_label TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				finished_at TEXT
			);
			CREATE INDEX IF NOT EXISTS queue_jobs_order ON queue_jobs(position);
			-- Each print of a queued job, linked to its print history entry.
			CREATE TABLE IF NOT EXISTS queue_runs (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				job_id TEXT NOT NULL REFERENCES queue_jobs(id) ON DELETE CASCADE,
				printer_id TEXT NOT NULL,
				printer_name TEXT NOT NULL,
				print_id INTEGER,
				result TEXT NOT NULL DEFAULT 'printing',
				reason TEXT,
				started_at TEXT NOT NULL,
				ended_at TEXT
			);
			CREATE INDEX IF NOT EXISTS queue_runs_job ON queue_runs(job_id, id DESC);
			-- Per-printer queue state: tags, "awaiting bed clear", dispatch held.
			CREATE TABLE IF NOT EXISTS queue_printers (
				printer_id TEXT PRIMARY KEY REFERENCES printers(id) ON DELETE CASCADE,
				tags TEXT NOT NULL DEFAULT '[]',
				awaiting_clear INTEGER NOT NULL DEFAULT 1,
				awaiting_since TEXT,
				held INTEGER NOT NULL DEFAULT 0,
				held_reason TEXT,
				updated_at TEXT NOT NULL
			);
			-- Per-token options: a slicer upload key's destination, a status token's bed-clear permission.
			ALTER TABLE api_tokens ADD COLUMN options TEXT;
		`)
	],
	[
		'notify-001',
		(h) =>
			h.exec(`
			-- Notification deliveries, newest kept (see notify/log.ts).
			CREATE TABLE IF NOT EXISTS notify_log (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				at TEXT NOT NULL,
				channel_id TEXT NOT NULL,
				channel_name TEXT NOT NULL,
				channel_type TEXT NOT NULL,
				kind TEXT NOT NULL,
				printer_name TEXT,
				title TEXT NOT NULL,
				status TEXT NOT NULL,
				error TEXT,
				ms INTEGER,
				image INTEGER NOT NULL DEFAULT 0
			);
			-- Snapshots shared by unguessable link with channels that show images by URL (see notify/media.ts).
			CREATE TABLE IF NOT EXISTS notify_media (
				token_hash TEXT PRIMARY KEY,
				data BLOB NOT NULL,
				type TEXT NOT NULL,
				expires_at INTEGER NOT NULL
			);
		`)
	],
	[
		'power-001-plugs',
		(h) =>
			h.exec(`
			-- Smart plug per printer (see power/config.ts). Credentials are sealed in "secret", bound to the printer id.
			CREATE TABLE IF NOT EXISTS power_plugs (
				printer_id TEXT PRIMARY KEY REFERENCES printers(id) ON DELETE CASCADE,
				kind TEXT NOT NULL,
				label TEXT,
				config TEXT NOT NULL,
				secret TEXT,
				settings TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
		`)
	],
	[
		'spools-001',
		(h) =>
			h.exec(`
			-- Active Spoolman spool per printer and tool (see spools/assignments.ts).
			CREATE TABLE IF NOT EXISTS spool_assignments (
				printer_id TEXT NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
				tool INTEGER NOT NULL,
				spool_id INTEGER NOT NULL,
				assigned_at TEXT NOT NULL,
				assigned_by TEXT,
				PRIMARY KEY (printer_id, tool)
			);
			-- Filament use per print and tool, and how much of it Spoolman has been told (spools/usage.ts).
			CREATE TABLE IF NOT EXISTS spool_usage (
				print_id INTEGER NOT NULL REFERENCES prints(id) ON DELETE CASCADE,
				tool INTEGER NOT NULL,
				spool_id INTEGER NOT NULL,
				planned_mm REAL,
				target_mm REAL NOT NULL DEFAULT 0,
				reported_mm REAL NOT NULL DEFAULT 0,
				final INTEGER NOT NULL DEFAULT 0,
				updated_at TEXT NOT NULL,
				last_error TEXT,
				PRIMARY KEY (print_id, tool)
			);
			-- Cost per print (costs.ts).
			ALTER TABLE prints ADD COLUMN filament_g REAL;
			ALTER TABLE prints ADD COLUMN cost_filament REAL;
			ALTER TABLE prints ADD COLUMN cost_energy REAL;
			ALTER TABLE prints ADD COLUMN cost_source TEXT;
			ALTER TABLE prints ADD COLUMN material TEXT;
			ALTER TABLE prints ADD COLUMN price_per_kg REAL;
			-- Maintenance reminders (maintenance.ts).
			CREATE TABLE IF NOT EXISTS maintenance_tasks (
				id TEXT PRIMARY KEY,
				printer_id TEXT NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
				name TEXT NOT NULL,
				metric TEXT NOT NULL,
				interval REAL NOT NULL,
				notes TEXT,
				sort INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL,
				last_done_at TEXT,
				last_done_by TEXT,
				notified_at TEXT
			);
			CREATE TABLE IF NOT EXISTS maintenance_log (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				task_id TEXT NOT NULL,
				printer_id TEXT NOT NULL,
				printer_name TEXT NOT NULL,
				task_name TEXT NOT NULL,
				metric TEXT NOT NULL,
				interval REAL NOT NULL,
				used REAL NOT NULL,
				done_at TEXT NOT NULL,
				user_id TEXT,
				done_by TEXT,
				notes TEXT
			);
			CREATE INDEX IF NOT EXISTS maintenance_log_printer ON maintenance_log(printer_id, id DESC);
		`)
	]
];

function migrate(h: DatabaseSync) {
	const done = new Set(
		(h.prepare(`SELECT key FROM kv WHERE key LIKE 'migration:%'`).all() as { key: string }[]).map((r) => r.key.slice('migration:'.length))
	);
	for (const [name, run] of MIGRATIONS) {
		if (done.has(name)) continue;
		h.exec('BEGIN');
		try {
			run(h);
			h.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run(`migration:${name}`, JSON.stringify(new Date().toISOString()));
			h.exec('COMMIT');
		} catch (err) {
			h.exec('ROLLBACK');
			throw err;
		}
	}
}

/** Names of applied migrations, for tests and diagnostics. */
export function appliedMigrations(): string[] {
	return (db().prepare(`SELECT key FROM kv WHERE key LIKE 'migration:%' ORDER BY key`).all() as { key: string }[]).map((r) =>
		r.key.slice('migration:'.length)
	);
}

type Row = Record<string, unknown>;

// --- printers ----------------------------------------------------------------

function toPrinter(r: Row): Printer {
	return {
		id: r.id as string,
		name: r.name as string,
		baseUrl: r.base_url as string,
		hasApiKey: r.secret != null,
		verifyTls: r.verify_tls !== 0,
		webcamUrl: (r.webcam_url as string) ?? null,
		color: r.color as string,
		createdAt: r.created_at as string,
		updatedAt: r.updated_at as string,
		lastSeenAt: (r.last_seen_at as string) ?? null,
		octoprintVersion: (r.octoprint_version as string) ?? null
	};
}

export function listPrinters(): Printer[] {
	return (db().prepare('SELECT * FROM printers ORDER BY sort, name COLLATE NOCASE').all() as Row[]).map(toPrinter);
}

export function getPrinter(id: string): Printer | undefined {
	const row = db().prepare('SELECT * FROM printers WHERE id = ?').get(id) as Row | undefined;
	return row && toPrinter(row);
}

/** The decrypted API key; never leaves the server. */
export function getApiKey(id: string): string | undefined {
	const row = db().prepare('SELECT secret FROM printers WHERE id = ?').get(id) as Row | undefined;
	if (!row?.secret) return undefined;
	return JSON.parse(decrypt(row.secret as string, `printer:${id}`)).apiKey;
}

export function sealApiKey(id: string, apiKey: string | undefined | null): string | null {
	return apiKey ? encrypt(JSON.stringify({ apiKey }), `printer:${id}`) : null;
}

export function createPrinter(input: PrinterInput): Printer {
	const id = randomUUID();
	const now = new Date().toISOString();
	const sort = (db().prepare('SELECT coalesce(max(sort), 0) + 1 AS n FROM printers').get() as { n: number }).n;
	db()
		.prepare(
			`INSERT INTO printers (id, name, base_url, secret, verify_tls, webcam_url, color, sort, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(id, input.name, input.baseUrl, sealApiKey(id, input.apiKey), input.verifyTls ? 1 : 0, input.webcamUrl, input.color, sort, now, now);
	return getPrinter(id)!;
}

export function updatePrinter(id: string, input: PrinterInput): Printer | undefined {
	if (!getPrinter(id)) return undefined;
	db()
		.prepare('UPDATE printers SET name = ?, base_url = ?, verify_tls = ?, webcam_url = ?, color = ?, updated_at = ? WHERE id = ?')
		.run(input.name, input.baseUrl, input.verifyTls ? 1 : 0, input.webcamUrl, input.color, new Date().toISOString(), id);
	if (input.apiKey !== undefined) db().prepare('UPDATE printers SET secret = ? WHERE id = ?').run(sealApiKey(id, input.apiKey), id);
	return getPrinter(id);
}

/** Per-printer settings kept in kv (failure detection, history import); removed with the printer. */
const PRINTER_KV_KEYS = (id: string) => [`detect:printer:${id}`, `detect:baseline:${id}`, `history:imported:${id}`];

export function deletePrinter(id: string): boolean {
	const removed = Number(db().prepare('DELETE FROM printers WHERE id = ?').run(id).changes) > 0;
	if (removed) for (const key of PRINTER_KV_KEYS(id)) db().prepare('DELETE FROM kv WHERE key = ?').run(key);
	return removed;
}

/** Records a successful contact (and the version), at most once a minute per printer. */
const lastTouch = new Map<string, { at: number; version: string | null }>();
export function touchPrinter(id: string, version: string | null) {
	const prev = lastTouch.get(id);
	const now = Date.now();
	if (prev && now - prev.at < 60_000 && prev.version === version) return;
	lastTouch.set(id, { at: now, version });
	db()
		.prepare('UPDATE printers SET last_seen_at = ?, octoprint_version = coalesce(?, octoprint_version) WHERE id = ?')
		.run(new Date(now).toISOString(), version, id);
}

// --- settings (kv) -------------------------------------------------------------

export function getKv<T>(key: string, fallback: T): T {
	const row = db().prepare('SELECT value FROM kv WHERE key = ?').get(key) as Row | undefined;
	return row ? (JSON.parse(row.value as string) as T) : fallback;
}

export function setKv(key: string, value: unknown) {
	db().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}

export function deleteKv(key: string) {
	db().prepare('DELETE FROM kv WHERE key = ?').run(key);
}

// --- users -------------------------------------------------------------------

function toUser(r: Row): User {
	return {
		id: r.id as string,
		email: r.email as string,
		name: (r.name as string) ?? null,
		role: r.role as Role,
		hasPassword: r.password_hash != null,
		sso: r.oidc_sub != null,
		disabled: r.disabled === 1,
		printerAccess: r.printer_access === 'selected' ? 'selected' : 'all',
		createdAt: r.created_at as string,
		lastLoginAt: (r.last_login_at as string) ?? null
	};
}

export function countUsers(): number {
	return (db().prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n;
}

export function countAdmins(): number {
	return (db().prepare(`SELECT count(*) AS n FROM users WHERE role = 'admin' AND disabled = 0`).get() as { n: number }).n;
}

export function listUsers(): User[] {
	return (db().prepare('SELECT * FROM users ORDER BY email').all() as Row[]).map(toUser);
}

export function getUser(id: string): User | undefined {
	const row = db().prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
	return row && toUser(row);
}

export function findUserByEmail(email: string): User | undefined {
	const row = db().prepare('SELECT * FROM users WHERE email = ?').get(email.trim()) as Row | undefined;
	return row && toUser(row);
}

export function findUserBySub(sub: string): User | undefined {
	const row = db().prepare('SELECT * FROM users WHERE oidc_sub = ?').get(sub) as Row | undefined;
	return row && toUser(row);
}

export function getPasswordHash(userId: string): string | undefined {
	const row = db().prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as Row | undefined;
	return (row?.password_hash as string) ?? undefined;
}

export function createUser(input: { email: string; name?: string | null; role: Role; passwordHash?: string; oidcSub?: string }): User {
	const id = randomUUID();
	db()
		.prepare('INSERT INTO users (id, email, name, role, password_hash, oidc_sub, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
		.run(id, input.email.trim(), input.name ?? null, input.role, input.passwordHash ?? null, input.oidcSub ?? null, new Date().toISOString());
	return getUser(id)!;
}

export function updateUser(
	id: string,
	patch: {
		role?: Role;
		disabled?: boolean;
		name?: string | null;
		email?: string;
		passwordHash?: string | null;
		oidcSub?: string;
		printerAccess?: User['printerAccess'];
	}
) {
	const sets: string[] = [];
	const values: (string | number | null)[] = [];
	if (patch.role !== undefined) sets.push('role = ?'), values.push(patch.role);
	if (patch.disabled !== undefined) sets.push('disabled = ?'), values.push(patch.disabled ? 1 : 0);
	if (patch.name !== undefined) sets.push('name = ?'), values.push(patch.name);
	if (patch.passwordHash !== undefined) sets.push('password_hash = ?'), values.push(patch.passwordHash);
	if (patch.oidcSub !== undefined) sets.push('oidc_sub = ?'), values.push(patch.oidcSub);
	if (patch.email !== undefined) sets.push('email = ?'), values.push(patch.email.trim());
	if (patch.printerAccess !== undefined) sets.push('printer_access = ?'), values.push(patch.printerAccess);
	if (!sets.length) return getUser(id);
	db().prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
	if (patch.disabled || patch.role) deleteUserSessions(id); // take effect immediately
	return getUser(id);
}

export function touchUserLogin(id: string) {
	db().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}

export function deleteUser(id: string): boolean {
	return Number(db().prepare('DELETE FROM users WHERE id = ?').run(id).changes) > 0;
}

// --- sessions ----------------------------------------------------------------

export function createSession(tokenHash: string, userId: string, ttlMs: number) {
	db().prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
	db().prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(tokenHash, userId, Date.now() + ttlMs);
}

/** The signed-in user for a session token, if the session is live and the user enabled. */
export function sessionUser(tokenHash: string): User | undefined {
	const row = db()
		.prepare(
			`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
			 WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0`
		)
		.get(tokenHash, Date.now()) as Row | undefined;
	return row && toUser(row);
}

export function deleteSession(tokenHash: string) {
	db().prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

export function deleteUserSessions(userId: string) {
	db().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

// --- printer grants ----------------------------------------------------------

export function listGrants(userId: string): string[] {
	return (db().prepare('SELECT printer_id FROM grants WHERE user_id = ?').all(userId) as Row[]).map((r) => r.printer_id as string);
}

export function hasGrant(userId: string, printerId: string): boolean {
	return !!db().prepare('SELECT 1 FROM grants WHERE user_id = ? AND printer_id = ?').get(userId, printerId);
}

export function setGrants(userId: string, printerIds: string[]) {
	const h = db();
	h.exec('BEGIN');
	try {
		h.prepare('DELETE FROM grants WHERE user_id = ?').run(userId);
		const ins = h.prepare('INSERT OR IGNORE INTO grants (user_id, printer_id) VALUES (?, ?)');
		for (const id of printerIds) if (getPrinter(id)) ins.run(userId, id);
		h.exec('COMMIT');
	} catch (err) {
		h.exec('ROLLBACK');
		throw err;
	}
}

// --- audit -------------------------------------------------------------------

export function addAudit(e: Omit<AuditEvent, 'id' | 'at'>) {
	db()
		.prepare('INSERT INTO audit (at, user_id, user_email, action, printer_id, printer_name, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
		.run(new Date().toISOString(), e.userId, e.userEmail, e.action, e.printerId, e.printerName, e.detail, e.ip);
	db().prepare('DELETE FROM audit WHERE id <= (SELECT max(id) - 50000 FROM audit)').run();
}

export interface AuditFilter {
	userId?: string;
	printerId?: string;
	/** Prefix, e.g. `printer.` or `job.cancel`. */
	action?: string;
	q?: string;
	before?: number;
	limit?: number;
}

export function searchAudit(f: AuditFilter): AuditEvent[] {
	const where: string[] = [];
	const values: (string | number)[] = [];
	if (f.userId) where.push('user_id = ?'), values.push(f.userId);
	if (f.printerId) where.push('printer_id = ?'), values.push(f.printerId);
	if (f.action) where.push('action LIKE ?'), values.push(`${f.action}%`);
	if (f.q) where.push('(detail LIKE ? OR printer_name LIKE ? OR user_email LIKE ? OR action LIKE ?)'), values.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`, `%${f.q}%`);
	if (f.before) where.push('id < ?'), values.push(f.before);
	const rows = db()
		.prepare(`SELECT * FROM audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`)
		.all(...values, Math.min(f.limit ?? 100, 500)) as Row[];
	return rows.map((r) => ({
		id: r.id as number,
		at: r.at as string,
		userId: (r.user_id as string) ?? null,
		userEmail: (r.user_email as string) ?? null,
		action: r.action as string,
		printerId: (r.printer_id as string) ?? null,
		printerName: (r.printer_name as string) ?? null,
		detail: (r.detail as string) ?? null,
		ip: (r.ip as string) ?? null
	}));
}

// --- raw handle ----------------------------------------------------------------

/** The raw handle, for API tokens and backup/restore, which read and write whole tables in one transaction. */
export function sqlite(): DatabaseSync {
	return db();
}
