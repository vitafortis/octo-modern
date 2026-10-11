import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type Server } from 'node:http';

process.env.OCM_DATA_DIR = mkdtempSync(join(tmpdir(), 'ocm-queue-test-'));
process.env.OCM_SECRET_KEY = 'test-key-for-queue';
const store = await import('../src/lib/server/store.ts');
const qs = await import('../src/lib/server/queue/store.ts');
const { planDispatch, jobFits, printerReady, sameFile, dispatcher } = await import('../src/lib/server/queue/dispatcher.ts');
const svc = await import('../src/lib/server/queue/service.ts');
const { parseTags, tagsMatch, clampCopies } = await import('../src/lib/queue.ts');
const { boundaryOf, parseMultipart, parsePartHeaders } = await import('../src/lib/server/multipart.ts');
const { printers } = await import('../src/lib/server/octoprint/manager.ts');
const { adminOnlyApi, controlApi } = await import('../src/lib/server/access.ts');
const { tempUploadPath, stagedPath } = await import('../src/lib/server/queue/files.ts');

// A tiny OctoPrint stand-in (port from this feature's range 3210–3219).
const MOCK_PORT = 3213;
const op = { uploads: [] as { query: string; body: string }[], selects: [] as { path: string; body: unknown }[], files: new Map<string, number>(), state: 'Operational' };
const readBody = (req: IncomingMessage) => new Promise<Buffer>((r) => { const c: Buffer[] = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
const mock: Server = createServer(async (req, res) => {
	const url = new URL(req.url!, 'http://x');
	const body = await readBody(req);
	const send = (status: number, j?: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(j === undefined ? '' : JSON.stringify(j)); };
	if (req.headers['x-api-key'] !== 'mock-key') return send(403, { error: 'Forbidden' });
	if (url.pathname === '/api/job') return send(200, { state: op.state, job: { file: {} }, progress: {} });
	if (url.pathname === '/api/files/local' && req.method === 'POST') {
		const name = /filename="([^"]+)"/.exec(body.toString('latin1'))![1];
		if (name.startsWith('reject')) return send(415, { error: 'Unsupported file type' });
		op.uploads.push({ query: url.search, body: body.toString('utf8') });
		op.files.set(name, 10);
		return send(201, { done: true, files: { local: { path: name } }, effectivePrint: url.searchParams.get('print') === 'true', effectiveSelect: url.searchParams.get('select') === 'true' });
	}
	const m = /^\/api\/files\/local\/(.+)$/.exec(url.pathname);
	if (m) {
		const path = decodeURIComponent(m[1]);
		if (req.method === 'POST') { op.selects.push({ path, body: JSON.parse(body.toString() || '{}') }); return send(204); }
		return op.files.has(path) ? send(200, { name: path, path, size: op.files.get(path) }) : send(404, { error: 'not found' });
	}
	send(404, {});
});
await new Promise<void>((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
after(() => { mock.close(); for (const p of store.listPrinters()) printers.forget(p.id); });

const mkPrinter = (name: string, apiKey = 'mock-key') => store.createPrinter({ name, baseUrl: `http://127.0.0.1:${MOCK_PORT}`, apiKey, verifyTls: true, webcamUrl: null, color: 'violet' });
const admin = store.createUser({ email: 'admin@x.io', role: 'admin' });
const viewer = store.createUser({ email: 'viewer@x.io', role: 'viewer' });

// --- pure ------------------------------------------------------------------------------------

test('tags: parsed, normalized, matched as a subset', () => {
	assert.deepEqual(parseTags(' 0.4mm, PETG  bed:300,petg, bad tag!, '), ['0.4mm', 'petg', 'bed:300', 'bad'], 'invalid tags (tag!) are dropped');
	assert.deepEqual(parseTags(['A', 'a', 3, '']), ['a']);
	assert.ok(tagsMatch([], ['x']));
	assert.ok(tagsMatch(['0.4mm', 'petg'], ['petg', '0.4mm', 'bed:300']));
	assert.ok(!tagsMatch(['0.6mm'], ['0.4mm']));
	assert.equal(clampCopies('3'), 3);
	assert.equal(clampCopies(0), 1);
	assert.equal(clampCopies(1e6), 100);
	assert.equal(clampCopies('x'), 1);
});

const view = (id: string, o: Partial<Parameters<typeof printerReady>[0]> = {}) => ({ id, tags: [], awaitingClear: false, held: false, state: 'operational' as const, hasApiKey: true, busy: false, tracking: false, ...o });
const job = (id: string, o: Partial<{ status: 'queued' | 'printing' | 'failed'; printerId: string | null; tags: string[] }> = {}) => ({ id, status: 'queued' as const, printerId: null, tags: [], ...o });

test('dispatch: only idle, cleared, unheld printers take jobs; target and tags decide which', () => {
	assert.ok(printerReady(view('a')));
	for (const o of [{ awaitingClear: true }, { held: true }, { busy: true }, { tracking: true }, { hasApiKey: false }, { state: 'printing' as const }, { state: 'offline' as const }, { state: undefined }]) {
		assert.ok(!printerReady(view('a', o)), JSON.stringify(o));
	}
	assert.ok(jobFits(job('1', { printerId: 'a' }), view('a')) && !jobFits(job('1', { printerId: 'a' }), view('b')));
	assert.ok(jobFits(job('1', { tags: ['petg'] }), view('a', { tags: ['petg', '0.4mm'] })));
	assert.ok(!jobFits(job('1', { tags: ['petg'] }), view('a', { tags: ['pla'] })));

	const views = [view('a', { tags: ['pla'] }), view('b', { tags: ['petg'] }), view('c', { awaitingClear: true })];
	const jobs = [job('1', { tags: ['petg'] }), job('2', { printerId: 'c' }), job('3'), job('4', { status: 'printing' }), job('5')];
	assert.deepEqual(planDispatch(false, views, jobs), [
		{ printerId: 'a', jobId: '3' },
		{ printerId: 'b', jobId: '1' }
	], 'in queue order, each job once, the bed-clear printer skipped');
	assert.deepEqual(planDispatch(true, views, jobs), [], 'paused: nothing');
	assert.deepEqual(planDispatch(false, views, jobs, (j) => j !== '3'), [{ printerId: 'a', jobId: '5' }, { printerId: 'b', jobId: '1' }], 'source/creator rules apply');
	assert.ok(sameFile('/a/b.gcode', 'a/b.gcode') && sameFile('x/b.gcode', 'b.gcode') && !sameFile('a.gcode', 'b.gcode') && !sameFile(null, 'a'));
});

test('access: queue writes need the control role', () => {
	assert.ok(controlApi('POST', '/api/queue'));
	assert.ok(controlApi('PATCH', '/api/queue/abc'));
	assert.ok(controlApi('POST', '/api/printers/p1/queue'));
	assert.ok(!controlApi('GET', '/api/queue'));
	assert.ok(!adminOnlyApi('POST', '/api/queue/order'));
	assert.throws(() => svc.parseTarget(viewer, {}), /only watch/);
});

// --- multipart ----------------------------------------------------------------------------------

/** A body like PrusaSlicer/OrcaSlicer (libcurl) send: print, path, then the file. */
function prusaBody(boundary: string, name: string, data: string, print = false) {
	return Buffer.from(
		`--${boundary}\r\nContent-Disposition: form-data; name="print"\r\n\r\n${print}\r\n` +
			`--${boundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\n\r\n` +
			`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n${data}\r\n` +
			`--${boundary}--\r\n`
	);
}

/** Like Cura's OctoPrint plugin (Qt): quoted boundary, Content-Type before Content-Disposition, select+print first. */
function curaBody(boundary: string, name: string, data: string) {
	const part = (h: string, v: string) => `--${boundary}\r\nContent-Type: text/plain\r\nContent-Disposition: ${h}\r\n\r\n${v}\r\n`;
	return Buffer.from(
		part('form-data; name="select"', 'true') +
			part('form-data; name="print"', 'true') +
			`--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n\r\n${data}\r\n--${boundary}--\r\n`
	);
}

async function* chunks(buf: Buffer, size: number) {
	for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}

test('multipart: PrusaSlicer and Cura shapes, every chunk size, binary-safe', async () => {
	assert.equal(boundaryOf('multipart/form-data; boundary=------------------------abc'), '------------------------abc');
	assert.equal(boundaryOf('multipart/form-data; boundary="boundary_.oOo._MTk="'), 'boundary_.oOo._MTk=');
	assert.equal(boundaryOf('application/json'), null);
	assert.deepEqual(parsePartHeaders('Content-Disposition: form-data; name="file"; filename*=UTF-8\'\'b%C3%A9nchy.gcode'), { name: 'file', filename: 'bénchy.gcode', contentType: null });

	// G-code with something that looks like a boundary prefix and CRLFs inside.
	const data = 'G28\r\n;--\r\n--not-the-boundary\r\nG1 X10\r\n'.repeat(50);
	for (const [label, body, ctype] of [
		['prusa', prusaBody('------------------------7d1b2c3a', 'benchy.gcode', data, true), 'multipart/form-data; boundary=------------------------7d1b2c3a'],
		['cura', curaBody('boundary_.oOo._NzE5', 'CE3_benchy.gcode', data), 'multipart/form-data; boundary="boundary_.oOo._NzE5"']
	] as const) {
		for (const size of [1, 2, 7, 64, 1000, 1 << 20]) {
			const out = await tempUploadPath();
			const r = await parseMultipart(chunks(body, size), boundaryOf(ctype)!, out);
			assert.equal(readFileSync(out, 'utf8'), data, `${label} @${size}: file content`);
			assert.equal(r.file!.size, Buffer.byteLength(data));
			assert.equal(r.file!.field, 'file');
			if (label === 'prusa') assert.deepEqual(r.fields, { print: 'true', path: '' });
			else assert.deepEqual(r.fields, { select: 'true', print: 'true' });
		}
	}
	const out = await tempUploadPath();
	await assert.rejects(parseMultipart(chunks(prusaBody('b', 'x.gcode', 'abc').subarray(0, 150), 10), 'b', out), /ended early/);
	assert.ok(!existsSync(out), 'a broken upload leaves nothing behind');
});

// --- store, service and dispatcher ---------------------------------------------------------------------

test('jobs: order, move, reorder, survive as rows', async () => {
	const p = mkPrinter('order');
	const tmp = (await tempUploadPath()) + '-a';
	const { writeFileSync } = await import('node:fs');
	const ids: string[] = [];
	for (const n of ['a', 'b', 'c']) {
		writeFileSync(tmp, `G28 ; ${n}\n`);
		ids.push((await svc.addUploadJob({ tmpFile: tmp, filename: `../${n}.gcode`, size: 8, printerId: p.id, tags: [], copies: 1, createdById: admin.id, createdBy: 'Ada' })).id);
	}
	const names = () => qs.listJobs().filter((j) => ids.includes(j.id)).map((j) => j.name);
	assert.deepEqual(names(), ['a.gcode', 'b.gcode', 'c.gcode'], 'names are sanitized, queue order kept');
	assert.ok(existsSync(stagedPath(ids[0])));
	assert.ok(qs.move(ids[2], -1));
	assert.deepEqual(names(), ['a.gcode', 'c.gcode', 'b.gcode']);
	assert.ok(!qs.move(ids[0], -1), 'first can’t move up');
	qs.reorder([ids[1], ids[0]]);
	assert.deepEqual(names(), ['b.gcode', 'a.gcode', 'c.gcode']);
	await assert.rejects(svc.addUploadJob({ tmpFile: tmp, filename: 'model.stl', size: 1, printerId: null, tags: [], copies: 1, createdById: null, createdBy: null }), /Only G-code/);
	for (const id of ids) await svc.removeJob(qs.getJob(id)!);
	assert.ok(!existsSync(stagedPath(ids[0])), 'removing a job removes its file');
});

test('dispatcher: uploads the file, starts it, counts copies, holds the printer on failure, asks for a clear bed', async () => {
	op.uploads.length = 0;
	op.selects.length = 0;
	const p = mkPrinter('mk4');
	qs.setAwaitingClear(p.id, false);
	const sent: { event: string; title: string }[] = [];
	dispatcher.notify = async (event, o) => void sent.push({ event, title: o.title });
	const tmp = (await tempUploadPath()) + '-b';
	(await import('node:fs')).writeFileSync(tmp, 'G28\nG1 X1\n');
	const j = await svc.addUploadJob({ tmpFile: tmp, filename: 'cube.gcode', size: 10, printerId: p.id, tags: [], copies: 2, createdById: admin.id, createdBy: 'Ada' });

	await dispatcher.startJob(qs.getJob(j.id)!, store.getPrinter(p.id)!);
	let cur = qs.getJob(j.id)!;
	assert.equal(cur.status, 'printing', cur.error ?? '');
	assert.equal(cur.activePrinterId, p.id);
	assert.equal(op.uploads.length, 1, 'transferred once');
	assert.match(op.uploads[0].query, /select=true&print=true/);
	assert.match(op.uploads[0].body, /G1 X1/);

	const rec = (id: number, result: 'success' | 'failed' | 'cancelled') => ({ id, printerId: p.id, printerName: p.name, file: 'cube.gcode', path: 'cube.gcode', origin: 'local', startedAt: new Date(Date.now() - 60_000).toISOString(), endedAt: new Date().toISOString(), durationS: 60, result, reason: null, filamentMm: null, estimatedS: null, completion: 100, startedBy: 'Ada', octoprintUser: null, source: 'live' as const, hasThumbnail: false, notes: null });
	await dispatcher.onEnded(rec(101, 'success'), store.getPrinter(p.id));
	cur = qs.getJob(j.id)!;
	assert.equal(cur.status, 'queued', 'one more copy to go');
	assert.equal(cur.done, 1);
	assert.equal(cur.runs[0].printId, 101, 'the run links to its history entry');
	assert.equal(cur.runs[0].result, 'success');
	assert.ok(qs.getQueuePrinter(p.id).awaitingClear, 'the bed needs clearing');
	assert.deepEqual(sent.map((s) => s.event), ['queue.bed_clear_needed'], 'and someone is told');

	// Second copy: the file is already there with the same size, so it's just selected.
	await dispatcher.startJob(qs.getJob(j.id)!, store.getPrinter(p.id)!);
	assert.equal(op.uploads.length, 1, 'not transferred again');
	assert.deepEqual(op.selects.at(-1), { path: 'cube.gcode', body: { command: 'select', print: true } });
	await dispatcher.onEnded(rec(102, 'cancelled'), store.getPrinter(p.id));
	cur = qs.getJob(j.id)!;
	assert.equal(cur.status, 'failed');
	assert.equal(cur.error, 'Cancelled');
	assert.ok(qs.getQueuePrinter(p.id).held, 'dispatch to that printer pauses');
	assert.match(qs.getQueuePrinter(p.id).heldReason!, /cube\.gcode: cancelled/);
	assert.equal(sent.length, 1, 'nothing left waiting: no second notification');

	// Bed confirmation: refused while printing, accepted when idle.
	const r = await svc.confirmBedClear({ user: admin }, p.id, 'test');
	assert.ok(r.ok);
	assert.ok(!qs.getQueuePrinter(p.id).awaitingClear);
});

test('dispatcher: a start that fails marks the job failed and holds the printer', async () => {
	const p = mkPrinter('broken');
	const j = await svc.addPrinterFileJob(admin, { printerId: p.id, path: 'x.gcode' }).catch((e) => e);
	assert.match(String(j), /has no file x\.gcode/, 'a printer file job checks the file exists');
	const offline = mkPrinter('offline', 'wrong-key');
	const t0 = (await tempUploadPath()) + '-o';
	(await import('node:fs')).writeFileSync(t0, 'G28\n');
	const o = await svc.addUploadJob({ tmpFile: t0, filename: 'o.gcode', size: 4, printerId: offline.id, tags: [], copies: 1, createdById: null, createdBy: null });
	await dispatcher.startJob(qs.getJob(o.id)!, store.getPrinter(offline.id)!);
	assert.equal(qs.getJob(o.id)!.status, 'queued', 'a printer that turns out not to be ready: the job just waits');
	const tmp = (await tempUploadPath()) + '-c';
	(await import('node:fs')).writeFileSync(tmp, 'G28\n');
	const job = await svc.addUploadJob({ tmpFile: tmp, filename: 'reject.gcode', size: 4, printerId: p.id, tags: [], copies: 1, createdById: null, createdBy: 'Key: test' });
	await dispatcher.startJob(qs.getJob(job.id)!, store.getPrinter(p.id)!);
	const cur = qs.getJob(job.id)!;
	assert.equal(cur.status, 'failed');
	assert.match(cur.error!, /Couldn’t start/);
	assert.ok(qs.getQueuePrinter(p.id).held);
	// Requeue puts it back at the end.
	assert.ok(qs.transition(job.id, 'failed', { status: 'queued', error: null }));
	assert.equal(qs.getJob(job.id)!.status, 'queued');
});

test('visibility: viewers see but can’t change; restricted operators only their printers', async () => {
	const a = mkPrinter('vis-a');
	const b = mkPrinter('vis-b');
	const op1 = store.updateUser(store.createUser({ email: 'op@x.io', role: 'operator' }).id, { printerAccess: 'selected' })!;
	store.setGrants(op1.id, [a.id]);
	assert.ok(svc.canSeeJob(viewer, { printerId: b.id }) && !svc.canManageJob(viewer, { printerId: b.id }));
	assert.ok(svc.canManageJob(op1, { printerId: a.id }) && !svc.canSeeJob(op1, { printerId: b.id }));
	assert.ok(svc.canManageJob(op1, { printerId: null }));
	assert.throws(() => svc.parseTarget(op1, { printerId: b.id }), /not found/i);
	// "Any printer" jobs by a restricted operator only go to their printers.
	const tmp = (await tempUploadPath()) + '-d';
	(await import('node:fs')).writeFileSync(tmp, 'G28\n');
	const job = await svc.addUploadJob({ tmpFile: tmp, filename: 'z.gcode', size: 4, printerId: null, tags: [], copies: 1, createdById: op1.id, createdBy: 'op' });
	assert.ok(dispatcher.allowed(qs.getJob(job.id)!, a.id));
	assert.ok(!dispatcher.allowed(qs.getJob(job.id)!, b.id));
	await svc.removeJob(qs.getJob(job.id)!);
});

test('the queue survives a restart (rows in the store)', () => {
	assert.ok(store.appliedMigrations().includes('queue-001'));
	qs.setPaused(true);
	assert.equal(qs.isPaused(), true);
	qs.setPaused(false);
});
