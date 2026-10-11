/**
 * Smart plug power control: switching (with the safety rules), readings, auto-connect
 * after power-on, auto power-off after a print, and `ensurePrinterOn` for features
 * that need the printer running (the print queue, sending a file to print).
 *
 * One process-wide instance (`power`), fed by the printers' live state
 * (`printers.observe`) and a 5 s background job (jobs/power.ts). A running auto
 * power-off countdown is kept in the store (pending.ts) and resumed after a restart.
 */
import { printers } from '../octoprint/manager.ts';
import { backendFor } from '../backend/index.ts';
import { currentState } from '../control.ts';
import { audit } from '../permissions.ts';
import { getPrinter, listPrinters } from '../store.ts';
import { notify } from '../notify/index.ts';
import { createAdapter, type PlugAdapter } from './adapters.ts';
import { getPlug, listPlugs, type StoredPlug } from './config.ts';
import { AutoOff, maxHotend } from './autooff.ts';
import { clearPending, loadPending, pendingPrinterIds, savePending } from './pending.ts';
import type { HttpDeps } from './http.ts';
import { isConnected, jobActive, type LiveSnapshot, type PrinterState } from '#lib/printer.ts';
import type { PlugReading, PowerInfo } from '#lib/power.ts';
import type { Printer, User } from '#lib/types.ts';

type Locals = { user: User | null; ip?: string };
/** Actions octo·modern takes by itself are audited without a user. */
const SYSTEM: Locals = { user: null };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms).unref?.());
const errMsg = (err: unknown) => {
	const e = err as { message?: string; hint?: string };
	return `${e.message ?? String(err)}${e.hint ? ` ${e.hint}` : ''}`;
};
/** Talking to the printer (not just OctoPrint). An error state isn't. */
const ready = (s: PrinterState | undefined) => !!s && isConnected(s) && s !== 'error';

interface Runtime {
	plug: StoredPlug;
	adapter: PlugAdapter;
	reading: PlugReading | null;
	readAt: number | null;
	error: string | null;
	reading$: Promise<PlugReading> | null;
	/** What we last switched it to (HTTP plugs without a status URL can't tell). */
	commanded: boolean | null;
	autoOff: AutoOff;
	/** `armedAt` of the countdown saved in the store (pending.ts); null: none saved. */
	savedArmedAt: number | null;
	/** An auto power-off is being carried out (its saved countdown stays until it's done). */
	firing: boolean;
	connect: PowerInfo['connect'];
	/** Bumped to cancel a running auto-connect. */
	connectRun: number;
	busy: boolean;
}

/** Why turning off needs (another) confirmation; the client resends with `field: true`. */
export interface OffConfirmation {
	stage: 'hot' | 'printing' | 'printing-final';
	field: 'confirm' | 'confirmPrinting';
	title: string;
	message: string;
}

export interface EnsureResult {
	/** The plug was switched on by this call. */
	changed: boolean;
	/** The plug's state afterwards (null: no plug, or unknown). */
	on: boolean | null;
	/** The printer is connected to OctoPrint and talking. */
	ready: boolean;
	state: PrinterState;
	/** Why nothing was done: no plug configured, auto power-on off, or the plug failed. */
	reason?: 'no-plug' | 'auto-on-disabled' | 'error';
	error?: string;
}

export class PowerService {
	/** Delays between auto-connect attempts after power-on (about 3 minutes in all). */
	connectDelays = [3_000, 3_000, 4_000, 5_000, 5_000, 10_000, 10_000, 15_000, 15_000, 20_000, 30_000, 60_000];
	/** Readings older than this are refreshed by the background job and on request. */
	readTtlMs = 15_000;
	/** How long `ensurePrinterOn` waits for the printer to connect. */
	ensureTimeoutMs = 150_000;
	/** HTTP options for the plugs (tests may shorten the timeout). */
	deps: HttpDeps = {};

	private cache = new Map<string, Runtime | null>();
	private ensuring = new Map<string, Promise<EnsureResult>>();
	private stopObserve: (() => void) | null = null;
	/**
	 * Reasons to hold back an auto power-off that is due, registered by other features
	 * (the print queue: jobs waiting for the bed to be cleared). Each returns a reason or null.
	 */
	readonly keepOnChecks = new Set<(printerId: string) => string | null>();

	/** Starts following the printers' live state (auto power-off). Safe to call repeatedly. */
	start() {
		this.stopObserve ??= printers.observe((id, e) => {
			if (e.type === 'update') this.observe(id, e.snapshot);
		});
	}

	stop() {
		this.stopObserve?.();
		this.stopObserve = null;
	}

	/** Forgets cached state after the plug's configuration changed (or was removed). */
	invalidate(printerId: string) {
		const rt = this.cache.get(printerId);
		if (rt) rt.connectRun++;
		this.cache.delete(printerId);
	}

	private runtime(printerId: string): Runtime | null {
		const cached = this.cache.get(printerId);
		if (cached !== undefined) return cached;
		const plug = getPlug(printerId);
		const rt: Runtime | null = plug
			? { plug, adapter: createAdapter(plug.kind, plug.config, plug.secrets, this.deps), reading: null, readAt: null, error: null, reading$: null, commanded: null, autoOff: new AutoOff(), savedArmedAt: null, firing: false, connect: null, connectRun: 0, busy: false }
			: null;
		this.cache.set(printerId, rt);
		if (rt) this.resumePending(printerId, rt);
		return rt;
	}

	/** Picks up a countdown saved before a restart (or before the plug's settings changed). */
	private resumePending(printerId: string, rt: Runtime) {
		let saved;
		try {
			saved = loadPending(printerId);
		} catch {
			return;
		}
		if (!saved) return;
		if (saved.plugKind !== rt.plug.kind || !rt.plug.settings.autoOff.enabled) {
			clearPending(printerId);
			return;
		}
		rt.autoOff.restore(saved.armedAt);
		rt.savedArmedAt = saved.armedAt;
	}

	/** Keeps the saved countdown in step with the state machine. */
	private syncPending(printerId: string, rt: Runtime) {
		const armedAt = rt.autoOff.armedAt;
		if (armedAt === rt.savedArmedAt) return;
		try {
			if (armedAt == null) clearPending(printerId);
			else {
				const s = rt.plug.settings.autoOff;
				savePending({ printerId, plugKind: rt.plug.kind, plugLabel: rt.plug.label, armedAt, offAt: armedAt + s.idleMinutes * 60_000, idleMinutes: s.idleMinutes, hotendC: s.hotendC, waitForQueue: s.waitForQueue, savedAt: Date.now() });
			}
			rt.savedArmedAt = armedAt;
		} catch (err) {
			console.warn(`[octo-modern] couldn’t save the auto power-off countdown: ${errMsg(err)}`);
		}
	}

	has(printerId: string): boolean {
		return !!this.runtime(printerId);
	}

	// --- readings ------------------------------------------------------------------------

	/** Reads the plug (shared with a read already running). Throws on failure (and records it). */
	async read(printerId: string): Promise<PlugReading> {
		const rt = this.runtime(printerId);
		if (!rt) throw new Error('No smart plug is set up for this printer');
		rt.reading$ ??= (async () => {
			try {
				const r = await rt.adapter.status();
				if (r.on == null && rt.commanded != null) r.on = rt.commanded;
				rt.reading = r;
				rt.readAt = Date.now();
				rt.error = null;
				return r;
			} catch (err) {
				rt.error = errMsg(err);
				throw err;
			} finally {
				rt.reading$ = null;
			}
		})();
		return rt.reading$;
	}

	/** Reads the plug if the last reading is older than `maxAgeMs`; never throws. */
	async refresh(printerId: string, maxAgeMs = this.readTtlMs): Promise<void> {
		const rt = this.runtime(printerId);
		if (!rt || (rt.readAt && Date.now() - rt.readAt < maxAgeMs && !rt.error)) return;
		await this.read(printerId).catch(() => {});
	}

	info(printerId: string): PowerInfo | null {
		const rt = this.runtime(printerId);
		if (!rt) return null;
		return {
			printerId,
			kind: rt.plug.kind,
			label: rt.plug.label,
			reading: rt.reading,
			readAt: rt.readAt,
			error: rt.error,
			settings: rt.plug.settings,
			countdown: rt.autoOff.countdown(rt.plug.settings.autoOff),
			connect: rt.connect,
			busy: rt.busy
		};
	}

	/** Info for the printers that have a plug; waits briefly for plugs never read yet. */
	async infos(printerIds: string[], waitMs = 3_000): Promise<PowerInfo[]> {
		const ids = printerIds.filter((id) => this.runtime(id));
		const fresh = Promise.all(ids.map((id) => this.refresh(id)));
		if (ids.some((id) => !this.runtime(id)!.readAt && !this.runtime(id)!.error)) await Promise.race([fresh, sleep(waitMs)]);
		return ids.map((id) => this.info(id)!).filter(Boolean);
	}

	// --- switching ----------------------------------------------------------------------------

	private async switchPlug(printer: Printer, on: boolean, locals: Locals, action: string, detail?: string): Promise<void> {
		const rt = this.runtime(printer.id);
		if (!rt) throw new Error('No smart plug is set up for this printer');
		rt.busy = true;
		try {
			await rt.adapter.set(on);
		} catch (err) {
			rt.error = errMsg(err);
			audit(locals, action, { printer, detail: `failed: ${rt.error}`.slice(0, 480) });
			throw err;
		} finally {
			rt.busy = false;
		}
		rt.commanded = on;
		rt.error = null;
		rt.reading = { ...(rt.reading ?? { powerW: null, energyWh: null, voltageV: null }), on };
		rt.readAt = Date.now();
		// Read back what the device now says (power draw changes too); a failure here isn't the switch's.
		await this.read(printer.id).catch(() => {});
		const cancelled = rt.autoOff.cancel(on ? 'Powered on' : 'Powered off');
		if (cancelled && !on) rt.connectRun++;
		this.syncPending(printer.id, rt);
		audit(locals, action, { printer, detail });
		const who = locals.user ? (locals.user.name ?? locals.user.email) : 'octo·modern';
		// No snapshot: the camera may well be on the same plug.
		void notify({
			kind: on ? 'power.on' : 'power.off',
			printerId: printer.id,
			printerName: printer.name,
			title: `${on ? 'Power on' : 'Power off'}: ${printer.name}`,
			message: `${printer.name} was powered ${on ? 'on' : 'off'} by ${who}${detail ? ` (${detail})` : ''}.`,
			dedupeKey: `${on ? 'on' : 'off'}:${Date.now()}`,
			snapshot: false
		});
	}

	/** Switches the plug on and, when set up to, connects OctoPrint to the printer afterwards. */
	async powerOn(printerId: string, locals: Locals, opts: { action?: string; detail?: string; connect?: boolean } = {}): Promise<void> {
		const printer = getPrinter(printerId);
		const rt = this.runtime(printerId);
		if (!printer || !rt) throw new Error('No smart plug is set up for this printer');
		await this.switchPlug(printer, true, locals, opts.action ?? 'power.on', opts.detail);
		if (opts.connect ?? rt.plug.settings.autoConnect) this.startAutoConnect(printer);
	}

	/**
	 * What turning off needs confirmed first, if anything: a running print needs two
	 * confirmations (`confirm`, then `confirmPrinting`); a hot hotend or bed one.
	 */
	async offCheck(printerId: string, given: { confirm?: boolean; confirmPrinting?: boolean }): Promise<{ confirm: OffConfirmation | null; overridden: string | null }> {
		const printer = getPrinter(printerId);
		const rt = this.runtime(printerId);
		if (!printer || !rt) return { confirm: null, overridden: null };
		let state: PrinterState = printers.snapshot(printerId)?.state ?? 'unknown';
		try {
			state = await currentState(printerId, backendFor(printer));
		} catch {
			// No API key: what we last saw.
		}
		const snap = printers.snapshot(printerId);
		if (jobActive(state)) {
			const file = snap?.job?.file?.display;
			if (!given.confirm) {
				return { overridden: null, confirm: {
					stage: 'printing',
					field: 'confirm',
					title: `${printer.name} is printing`,
					message: `${file ? `${file} is printing. ` : 'A print is running. '}Cutting the power stops it mid-layer and it can’t be resumed. Turn the printer off anyway?`
				} };
			}
			if (!given.confirmPrinting) {
				return { overridden: null, confirm: {
					stage: 'printing-final',
					field: 'confirmPrinting',
					title: 'Cut the power mid-print?',
					message: `Second confirmation: ${printer.name} loses power immediately, the print is lost and the hotend fan stops while the hotend is hot.`
				} };
			}
			return { confirm: null, overridden: `during a print${file ? ` of ${file}` : ''} (${state}), confirmed twice` };
		}
		const s = rt.plug.settings;
		const hot: string[] = [];
		for (const [k, t] of Object.entries(snap?.temps ?? {})) {
			if (t.actual == null) continue;
			if (k.startsWith('tool') && t.actual >= s.hotHotendC) hot.push(`hotend ${Math.round(t.actual)} °C`);
			if (k === 'bed' && t.actual >= s.hotBedC) hot.push(`bed ${Math.round(t.actual)} °C`);
		}
		if (hot.length && given.confirm) return { confirm: null, overridden: `while hot (${hot.join(', ')}), confirmed` };
		if (hot.length) {
			return { overridden: null, confirm: {
				stage: 'hot',
				field: 'confirm',
				title: `${printer.name} is still hot`,
				message: `The ${hot.join(' and ')}. Without power the hotend fan stops, which can cause heat creep and clogs. Turn it off anyway?`
			} };
		}
		return { confirm: null, overridden: null };
	}

	/** Disconnects OctoPrint from the printer (best effort), then switches the plug off. */
	async powerOff(printerId: string, locals: Locals, opts: { action?: string; detail?: string } = {}): Promise<void> {
		const printer = getPrinter(printerId);
		const rt = this.runtime(printerId);
		if (!printer || !rt) throw new Error('No smart plug is set up for this printer');
		rt.connectRun++;
		rt.connect = null;
		const state = printers.snapshot(printerId)?.state;
		if (state && state !== 'offline' && state !== 'disconnected' && state !== 'unknown') {
			try {
				await backendFor(printer).disconnect();
			} catch {
				// OctoPrint may be unreachable; the plug still switches.
			}
		}
		await this.switchPlug(printer, false, locals, opts.action ?? 'power.off', opts.detail);
		setTimeout(() => void printers.poll(printerId), 1_000).unref?.();
	}

	/** Cancels the auto power-off countdown ("Keep on"). Returns false if none was running. */
	keepOn(printerId: string, locals: Locals): boolean {
		const rt = this.runtime(printerId);
		const printer = getPrinter(printerId);
		if (!rt || !printer || !rt.autoOff.cancel('Kept on')) return false;
		this.syncPending(printerId, rt);
		audit(locals, 'power.keep_on', { printer, detail: 'auto power-off cancelled' });
		return true;
	}

	// --- auto-connect ----------------------------------------------------------------------------

	/** After power-on: waits for the printer, then asks OctoPrint to connect, with retries. */
	startAutoConnect(printer: Printer): Promise<boolean> {
		const rt = this.runtime(printer.id);
		if (!rt) return Promise.resolve(false);
		const run = ++rt.connectRun;
		const live = () => rt.connectRun === run && this.cache.get(printer.id) === rt;
		rt.connect = { phase: 'waiting', attempt: 0, message: 'Waiting for the printer to start', at: Date.now() };
		return (async () => {
			for (let i = 0; i < this.connectDelays.length; i++) {
				await sleep(this.connectDelays[i]);
				if (!live()) return false;
				await printers.poll(printer.id);
				const state = printers.snapshot(printer.id)?.state;
				const attempt = i + 1;
				if (ready(state)) {
					rt.connect = { phase: 'connected', attempt, message: null, at: Date.now() };
					audit(SYSTEM, 'power.autoconnect', { printer, detail: `connected (attempt ${attempt})` });
					return true;
				}
				if (state === 'connecting') {
					rt.connect = { phase: 'connecting', attempt, message: 'OctoPrint is connecting', at: Date.now() };
					continue;
				}
				if (!state || state === 'offline' || state === 'unknown') {
					rt.connect = { phase: 'waiting', attempt, message: 'Waiting for OctoPrint', at: Date.now() };
					continue;
				}
				try {
					await backendFor(printer).connect({});
					rt.connect = { phase: 'connecting', attempt, message: 'Asked OctoPrint to connect', at: Date.now() };
				} catch (err) {
					rt.connect = { phase: 'waiting', attempt, message: errMsg(err), at: Date.now() };
				}
			}
			if (!live()) return false;
			rt.connect = { phase: 'failed', attempt: this.connectDelays.length, message: 'The printer didn’t connect; connect it from the printer page', at: Date.now() };
			audit(SYSTEM, 'power.autoconnect', { printer, detail: `failed after ${this.connectDelays.length} attempts` });
			return false;
		})();
	}

	// --- auto power-on --------------------------------------------------------------------------

	/**
	 * Makes sure a printer is powered and connected before something prints on it (the
	 * queue, sending a file to print). Acts only when the printer has a plug with
	 * auto power-on enabled (or `force`); switches it on if it's off and waits for the
	 * printer to connect (up to `ensureTimeoutMs`). Never throws.
	 */
	ensurePrinterOn(printerId: string, opts: { force?: boolean; locals?: Locals; reason?: string } = {}): Promise<EnsureResult> {
		const running = this.ensuring.get(printerId);
		if (running) return running;
		const p = this.doEnsure(printerId, opts).finally(() => this.ensuring.delete(printerId));
		this.ensuring.set(printerId, p);
		return p;
	}

	private async doEnsure(printerId: string, opts: { force?: boolean; locals?: Locals; reason?: string }): Promise<EnsureResult> {
		const printer = getPrinter(printerId);
		const rt = this.runtime(printerId);
		const state = () => printers.snapshot(printerId)?.state ?? 'unknown';
		if (!printer || !rt) return { changed: false, on: null, ready: ready(state()), state: state(), reason: 'no-plug' };
		if (!opts.force && !rt.plug.settings.autoOn) return { changed: false, on: rt.reading?.on ?? null, ready: ready(state()), state: state(), reason: 'auto-on-disabled' };
		let changed = false;
		try {
			const r = await this.read(printerId);
			if (r.on !== true) {
				await this.powerOn(printerId, opts.locals ?? SYSTEM, { action: 'power.auto_on', detail: opts.reason ?? 'a print was sent while it was off', connect: false });
				changed = true;
			}
		} catch (err) {
			return { changed: false, on: rt.reading?.on ?? null, ready: ready(state()), state: state(), reason: 'error', error: errMsg(err) };
		}
		await printers.poll(printerId);
		if (!ready(state())) {
			const connected = this.startAutoConnect(printer);
			await Promise.race([connected, sleep(this.ensureTimeoutMs)]);
		}
		return { changed, on: true, ready: ready(state()), state: state() };
	}

	// --- auto power-off -------------------------------------------------------------------------

	/** Feeds one live update into the auto power-off countdown. */
	observe(printerId: string, snap: LiveSnapshot, now = Date.now()) {
		const rt = this.runtime(printerId);
		if (!rt) return;
		const s0 = rt.plug.settings.autoOff;
		const holdReason = rt.autoOff.armedAt != null && s0.waitForQueue ? this.holdReason(printerId) : null;
		const resumed = rt.autoOff.resumed;
		const ev = rt.autoOff.observe({ now, state: snap.state, hotendC: maxHotend(snap.temps), plugOn: rt.reading?.on ?? null, holdReason }, s0);
		// A fired countdown stays saved until the plug is off (a restart in between re-checks it).
		if (ev?.type !== 'fire' && !rt.firing) this.syncPending(printerId, rt);
		if (!ev) return;
		const printer = getPrinter(printerId);
		if (!printer) return;
		const s = rt.plug.settings.autoOff;
		if (ev.type === 'armed') audit(SYSTEM, 'power.auto_off.armed', { printer, detail: `off after ${s.idleMinutes} min idle and the hotend below ${s.hotendC} °C` });
		else if (ev.type === 'cancelled') audit(SYSTEM, 'power.auto_off.cancelled', { printer, detail: resumed ? `${ev.reason} (countdown resumed after a restart)` : ev.reason });
		else if (ev.type === 'fire') {
			rt.firing = true;
			void this.autoPowerOff(printer, resumed).finally(() => {
				rt.firing = false;
				this.syncPending(printerId, rt);
			});
		}
	}

	private holdReason(printerId: string): string | null {
		for (const check of this.keepOnChecks) {
			try {
				const r = check(printerId);
				if (r) return r;
			} catch (err) {
				console.error('[octo-modern] keep-on check failed', err);
			}
		}
		return null;
	}

	/** Auto power-on is set up for this printer. */
	autoOnEnabled(printerId: string): boolean {
		return !!this.runtime(printerId)?.plug.settings.autoOn;
	}

	private async autoPowerOff(printer: Printer, resumed = false) {
		try {
			// Ask the printer itself: a print may have just started.
			try {
				if (jobActive(await currentState(printer.id, backendFor(printer)))) {
					audit(SYSTEM, 'power.auto_off.cancelled', { printer, detail: 'A new print started' });
					return;
				}
			} catch {}
			const s = this.runtime(printer.id)?.plug.settings.autoOff;
			try {
				const detail = s ? `idle ${s.idleMinutes} min, hotend below ${s.hotendC} °C${resumed ? ' (countdown resumed after a restart)' : ''}` : undefined;
				await this.powerOff(printer.id, SYSTEM, { action: 'power.auto_off', detail });
			} catch (err) {
				console.warn(`[octo-modern] auto power-off of ${printer.name} failed: ${errMsg(err)}`);
			}
		} finally {
			if (!this.cache.get(printer.id)) clearPending(printer.id);
		}
	}

	/** The background job: refreshes stale readings and lets countdowns run out. */
	async tick(now = Date.now()) {
		const plugs = listPlugs();
		const ids = new Set(plugs.map((p) => p.printerId));
		for (const id of [...this.cache.keys()]) if (this.cache.get(id) && !ids.has(id)) this.invalidate(id);
		for (const p of plugs) {
			const rt = this.runtime(p.printerId);
			if (rt && rt.plug.updatedAt !== p.updatedAt) this.invalidate(p.printerId);
		}
		// Saved countdowns of printers that no longer have a plug.
		for (const id of pendingPrinterIds()) if (!ids.has(id)) clearPending(id);
		await Promise.all(plugs.map((p) => this.refresh(p.printerId)));
		for (const p of plugs) {
			const snap = printers.snapshot(p.printerId);
			if (snap) this.observe(p.printerId, snap, now);
		}
	}
}

const KEY = Symbol.for('octo-modern.power');
type G = typeof globalThis & { [KEY]?: PowerService };

/** The process-wide power service (survives dev-server module reloads). */
export const power: PowerService = ((globalThis as G)[KEY] ??= new PowerService());

/**
 * Makes sure the printer is on and connected before printing on it; see
 * `PowerService.ensurePrinterOn`. For the print queue and anything else that starts prints.
 */
export function ensurePrinterOn(printerId: string, opts?: Parameters<PowerService['ensurePrinterOn']>[1]): Promise<EnsureResult> {
	return power.ensurePrinterOn(printerId, opts);
}

/** Printers with a plug, for listings. */
export function plugPrinterIds(): string[] {
	const ids = new Set(listPlugs().map((p) => p.printerId));
	return listPrinters()
		.filter((p) => ids.has(p.id))
		.map((p) => p.id);
}
