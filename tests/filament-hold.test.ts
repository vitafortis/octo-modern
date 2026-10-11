// The pre-print filament check where it used to be skipped: jobs started by the print
// queue (held, with the reason, and a spool.low notification) and the job "restart"
// action (the same 409 confirm as start). Local mocks only: Spoolman on 127.0.0.1:5130,
// OctoPrint on :5131.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.OCM_DATA_DIR = mkdtempSync(join(tmpdir(), 'ocm-filament-hold-test-'));
process.env.OCM_SECRET_KEY = 'test-key-for-filament-hold';
const store = await import('../src/lib/server/store.ts');
const sm = await import('../src/lib/server/spools/spoolman.ts');
const asg = await import('../src/lib/server/spools/assignments.ts');
const qs = await import('../src/lib/server/queue/store.ts');
const svc = await import('../src/lib/server/queue/service.ts');
const { dispatcher, planDispatch } = await import('../src/lib/server/queue/dispatcher.ts');
const { tempUploadPath } = await import('../src/lib/server/queue/files.ts');
const { printers } = await import('../src/lib/server/octoprint/manager.ts');
const jobRoute = await import('../src/routes/api/printers/[id]/job/+server.ts');
const queueJobRoute = await import('../src/routes/api/queue/[job]/+server.ts');
// @ts-expect-error plain JS helper shared with the e2e scripts
const { startMockSpoolman } = await import('../scripts/e2e/mock-spoolman.mjs');

const SPOOLMAN_PORT = 5130;
const OP_PORT = 5131;

// Spool 1 of the mock inventory (Galaxy Black PLA) has 687.6 g ≈ 230 m left.
const BIG_MM = 300_000;
const SMALL_MM = 20_000;

const op = { files: new Map<string, number>([['big.gcode', BIG_MM], ['small.gcode', SMALL_MM]]), selects: [] as string[], uploads: [] as string[], commands: [] as string[], jobMm: BIG_MM };
const readBody = (req: IncomingMessage) => new Promise<Buffer>((r) => { const c: Buffer[] = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
let opServer: Server;
let spoolman: { close: () => Promise<void> };

before(async () => {
	opServer = createServer(async (req, res) => {
		const url = new URL(req.url!, 'http://x');
		const body = await readBody(req);
		const send = (status: number, j?: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(j === undefined ? '' : JSON.stringify(j));
		if (req.headers['x-api-key'] !== 'op-key') return send(403, { error: 'Forbidden' });
		if (url.pathname === '/api/job' && req.method === 'GET') {
			return send(200, { state: 'Operational', job: { file: { name: 'big.gcode', path: 'big.gcode', display: 'big.gcode', origin: 'local' }, filament: { tool0: { length: op.jobMm, volume: 1 } } }, progress: {} });
		}
		if (url.pathname === '/api/job' && req.method === 'POST') {
			op.commands.push(JSON.parse(body.toString()).command);
			return send(204);
		}
		if (url.pathname === '/api/files/local' && req.method === 'POST') {
			const name = /filename="([^"]+)"/.exec(body.toString('latin1'))![1];
			op.uploads.push(name);
			return send(201, { done: true, files: { local: { path: name } }, effectivePrint: true, effectiveSelect: true });
		}
		const m = /^\/api\/files\/local\/(.+)$/.exec(url.pathname);
		if (m) {
			const path = decodeURIComponent(m[1]);
			if (req.method === 'POST') {
				op.selects.push(path);
				return send(204);
			}
			const mm = op.files.get(path);
			return mm == null ? send(404, { error: 'not found' }) : send(200, { name: path, path, size: 10, gcodeAnalysis: { filament: { tool0: { length: mm, volume: 1 } } } });
		}
		send(404, {});
	});
	await new Promise<void>((r) => opServer.listen(OP_PORT, '127.0.0.1', () => r()));
	spoolman = await startMockSpoolman({ port: SPOOLMAN_PORT });
	sm.saveSpoolmanSettings({ url: `http://127.0.0.1:${SPOOLMAN_PORT}`, authHeader: null, lowThresholdG: 50 });
});

after(async () => {
	opServer.closeAllConnections();
	opServer.close();
	await spoolman.close();
	for (const p of store.listPrinters()) printers.forget(p.id);
});

const admin = store.createUser({ email: 'admin@x.io', role: 'admin' });
const mk4 = store.createPrinter({ name: 'MK4', baseUrl: `http://127.0.0.1:${OP_PORT}`, apiKey: 'op-key', verifyTls: true, webcamUrl: null, color: 'violet' });
asg.assignSpool(mk4.id, 0, 1, 'Ada');
qs.setAwaitingClear(mk4.id, false);

const sent: { event: string; title: string; message: string }[] = [];
dispatcher.notify = async (event, o) => void sent.push({ event, title: o.title, message: o.message });

type Ev = Parameters<typeof queueJobRoute.PATCH>[0];
const patchJob = async (id: string, b: unknown) => (await queueJobRoute.PATCH({ locals: { user: admin }, params: { job: id }, request: new Request('http://x', { method: 'PATCH', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } }) } as unknown as Ev)) as Response;
type JEv = Parameters<typeof jobRoute.POST>[0];
const jobCmd = async (b: unknown) => (await jobRoute.POST({ locals: { user: admin }, params: { id: mk4.id }, request: new Request('http://x', { method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } }) } as unknown as JEv)) as Response;

test('planDispatch never starts a held job', () => {
	const view = { id: 'a', tags: [], awaitingClear: false, held: false, state: 'operational' as const, hasApiKey: true, busy: false, tracking: false };
	assert.deepEqual(planDispatch(false, [view], [{ id: 'h', status: 'held', printerId: null, tags: [] }]), []);
	assert.deepEqual(planDispatch(false, [view], [{ id: 'h', status: 'held', printerId: null, tags: [] }, { id: 'q', status: 'queued', printerId: null, tags: [] }]), [{ printerId: 'a', jobId: 'q' }], 'the next job goes ahead');
});

test('queue: a job the spool won’t last is held with the reason and a notification; check again or print anyway', async () => {
	const job = await svc.addPrinterFileJob(admin, { printerId: mk4.id, path: 'big.gcode' });
	await dispatcher.startJob(qs.getJob(job.id)!, store.getPrinter(mk4.id)!);
	let cur = qs.getJob(job.id)!;
	assert.equal(cur.status, 'held');
	assert.equal(cur.activePrinterId, null);
	assert.match(cur.error!, /^Not enough filament on MK4: Galaxy Black \(PLA\) has 688 g \/ 2\d\d\.\d m left; this print needs about \d+ g \/ 300\.0 m\./);
	assert.ok(!/anyway\?/.test(cur.error!), 'no question nobody can answer');
	assert.deepEqual(op.selects, [], 'not started');
	assert.equal(cur.runs.length, 0, 'no run recorded');
	assert.equal(sent.length, 1);
	assert.equal(sent[0].event, 'spool.low');
	assert.equal(sent[0].title, 'Queue held: not enough filament on MK4');
	assert.match(sent[0].message, /big\.gcode wasn’t started on MK4/);
	assert.ok(store.searchAudit({ action: 'queue.hold' }).some((e) => /big\.gcode: Not enough filament/.test(e.detail ?? '')));
	// The browser sees the held job and its reason.
	const seen = svc.queueState(admin).jobs.find((j) => j.id === job.id)!;
	assert.equal(seen.status, 'held');
	assert.match(seen.error!, /Not enough filament/);
	// Held jobs aren't requeued, only released.
	assert.equal((await patchJob(job.id, { requeue: true })).status, 400);

	// "Check again" with the same spool: held again.
	assert.equal((await patchJob(job.id, { release: true })).status, 200);
	assert.equal(qs.getJob(job.id)!.status, 'queued');
	assert.equal(qs.getJob(job.id)!.error, null);
	await dispatcher.startJob(qs.getJob(job.id)!, store.getPrinter(mk4.id)!);
	assert.equal(qs.getJob(job.id)!.status, 'held');
	assert.deepEqual(op.selects, []);

	// "Print anyway": the next start skips the check (once).
	assert.equal((await patchJob(job.id, { release: true, printAnyway: true })).status, 200);
	assert.ok(qs.filamentOverride(job.id));
	await dispatcher.startJob(qs.getJob(job.id)!, store.getPrinter(mk4.id)!);
	cur = qs.getJob(job.id)!;
	assert.equal(cur.status, 'printing', cur.error ?? '');
	assert.deepEqual(op.selects, ['big.gcode']);
	assert.ok(!qs.filamentOverride(job.id), 'used up');
	assert.ok(store.searchAudit({ action: 'queue.edit' }).some((e) => /print anyway/.test(e.detail ?? '')));
	assert.equal((await patchJob(job.id, { release: true })).status, 400, 'only held jobs');
	qs.transition(job.id, 'printing', { status: 'done', activePrinterId: null });
});

test('queue: enough filament starts as before; uploads are checked from their slicer metadata; Spoolman down never holds', async () => {
	op.selects.length = 0;
	const small = await svc.addPrinterFileJob(admin, { printerId: mk4.id, path: 'small.gcode' });
	await dispatcher.startJob(qs.getJob(small.id)!, store.getPrinter(mk4.id)!);
	assert.equal(qs.getJob(small.id)!.status, 'printing');
	qs.transition(small.id, 'printing', { status: 'done', activePrinterId: null });

	const upload = async (name: string, mm: number) => {
		const tmp = (await tempUploadPath()) + `-${name}`;
		writeFileSync(tmp, `; generated by PrusaSlicer 2.8.1\nG28\nG1 X1\n; filament used [mm] = ${mm}\n; filament used [g] = ${Math.round(mm * 0.00298)}\n`);
		return svc.addUploadJob({ tmpFile: tmp, filename: name, size: 100, printerId: mk4.id, tags: [], copies: 1, createdById: admin.id, createdBy: 'Ada' });
	};
	const big = await upload('big-upload.gcode', BIG_MM);
	await dispatcher.startJob(qs.getJob(big.id)!, store.getPrinter(mk4.id)!);
	assert.equal(qs.getJob(big.id)!.status, 'held');
	assert.deepEqual(op.uploads, [], 'not transferred');
	const fits = await upload('fits.gcode', SMALL_MM);
	await dispatcher.startJob(qs.getJob(fits.id)!, store.getPrinter(mk4.id)!);
	assert.equal(qs.getJob(fits.id)!.status, 'printing');
	assert.deepEqual(op.uploads, ['fits.gcode']);
	qs.transition(fits.id, 'printing', { status: 'done', activePrinterId: null });

	// Spoolman unreachable: the check is skipped, never a reason to hold.
	sm.saveSpoolmanSettings({ url: 'http://127.0.0.1:9', authHeader: null, lowThresholdG: 50 });
	sm.clearSpoolCache();
	await patchJob(big.id, { release: true });
	await dispatcher.startJob(qs.getJob(big.id)!, store.getPrinter(mk4.id)!);
	assert.equal(qs.getJob(big.id)!.status, 'printing');
	qs.transition(big.id, 'printing', { status: 'done', activePrinterId: null });
	sm.saveSpoolmanSettings({ url: `http://127.0.0.1:${SPOOLMAN_PORT}`, authHeader: null, lowThresholdG: 50 });
	sm.clearSpoolCache();
});

test('restart: the same 409 confirm as start when the spool won’t last; goes straight through otherwise', async () => {
	op.commands.length = 0;
	op.jobMm = BIG_MM;
	for (const command of ['restart', 'start']) {
		const r = await jobCmd({ command });
		assert.equal(r.status, 409, command);
		const b = await r.json();
		assert.equal(b.confirmRequired, true);
		assert.equal(b.title, 'Not enough filament');
		assert.equal(b.confirmLabel, 'Print anyway');
		assert.match(b.message, /Galaxy Black \(PLA\) has 688 g/);
	}
	assert.deepEqual(op.commands, [], 'nothing sent without confirming');
	assert.equal((await jobCmd({ command: 'restart', confirm: true })).status, 200);
	assert.deepEqual(op.commands, ['restart']);
	op.jobMm = SMALL_MM;
	assert.equal((await jobCmd({ command: 'restart' })).status, 200, 'enough filament: no question');
	assert.deepEqual(op.commands, ['restart', 'restart']);
	assert.equal(store.searchAudit({ action: 'job.restart' }).length, 2);
});
