import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';

process.env.OCM_DATA_DIR = mkdtempSync(join(tmpdir(), 'ocm-compat-test-'));
process.env.OCM_SECRET_KEY = 'test-key-for-compat';
const store = await import('../src/lib/server/store.ts');
const t = await import('../src/lib/server/api-tokens.ts');
const compat = await import('../src/lib/server/octoprint-compat.ts');
const { createSource, parseSourceInput } = await import('../src/lib/server/library/sources.ts');
const qs = await import('../src/lib/server/queue/store.ts');
const { stagedPath } = await import('../src/lib/server/queue/files.ts');
const { printers } = await import('../src/lib/server/octoprint/manager.ts');

const MOCK_PORT = 3214;
const received: { url: string; body: string }[] = [];
const mock: Server = createServer((req, res) => {
	const chunks: Buffer[] = [];
	req.on('data', (c) => chunks.push(c));
	req.on('end', () => {
		received.push({ url: req.url!, body: Buffer.concat(chunks).toString('utf8') });
		const name = /filename="([^"]+)"/.exec(Buffer.concat(chunks).toString('latin1'))?.[1] ?? 'x';
		const path = new URL(req.url!, 'http://x').searchParams.get('path');
		res.writeHead(201, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ done: true, files: { local: { path: path ? `${path}/${name}` : name } }, effectivePrint: req.url!.includes('print=true'), effectiveSelect: req.url!.includes('select=true') }));
	});
});
await new Promise<void>((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
const printer = store.createPrinter({ name: 'Voron', baseUrl: `http://127.0.0.1:${MOCK_PORT}`, apiKey: 'k', verifyTls: true, webcamUrl: null, color: 'violet' });
after(() => {
	mock.close();
	printers.forget(printer.id);
});

const libDir = mkdtempSync(join(tmpdir(), 'ocm-compat-lib-'));
mkdirSync(join(libDir, 'slicer'));
const lib = createSource(parseSourceInput({ kind: 'folder', name: 'NAS', config: { path: libDir }, writable: true }));
const ro = createSource(parseSourceInput({ kind: 'folder', name: 'RO', config: { path: libDir }, writable: false }));

const key = (upload: unknown) => {
	const input = t.parseTokenInput({ name: 'Orca', scope: 'upload', upload });
	return t.createToken(input, null);
};

const req = (headers: Record<string, string>, query = '') => ({ headers: new Headers(headers), url: new URL(`http://ocm.local/octoprint/api/version${query}`), ip: '10.0.0.9' });

test('upload keys: letters and digits only, accepted with or without ocm_, only under /octoprint/api', () => {
	const { token, record } = key({ kind: 'queue' });
	assert.match(token, /^ocm_[A-Za-z0-9]{43}$/, 'no - or _ in the random part');
	assert.equal(record.scope, 'upload');
	assert.deepEqual(record.options, { upload: { kind: 'queue', printerId: null, tags: [] } });
	const ok = t.authorizeUploadRequest(req({ 'x-api-key': token }));
	assert.ok(ok.ok && ok.principal.options.upload?.kind === 'queue');
	assert.ok(t.authorizeUploadRequest(req({ 'x-api-key': token.slice(4) })).ok, 'without the prefix');
	assert.ok(t.authorizeUploadRequest(req({ authorization: `Bearer ${token}` })).ok);
	assert.ok(t.authorizeUploadRequest(req({}, `?apikey=${token}`)).ok);
	const missing = t.authorizeUploadRequest(req({}));
	assert.ok(!missing.ok && missing.status === 401);
	const wrong = t.authorizeUploadRequest(req({ 'x-api-key': 'ABCDEF0123456789ABCDEF0123456789' }, '&x=1'));
	assert.ok(!wrong.ok && wrong.status === 403, 'OctoPrint answers a bad key with 403');
	// A status token is no upload key, and an upload key opens no status route.
	const status = t.createToken(t.parseTokenInput({ name: 'dash' }), null);
	assert.ok(!t.authorizeUploadRequest(req({ 'x-api-key': status.token })).ok);
	assert.equal(t.verifyToken(token, 'status'), null);
	assert.ok(!t.tokenAllowed('POST', '/octoprint/api/files/local'));
});

test('upload key input: destinations are validated', () => {
	assert.throws(() => t.parseTokenInput({ name: 'x', scope: 'upload' }), /Choose where/);
	assert.throws(() => t.parseTokenInput({ name: 'x', scope: 'upload', upload: { kind: 'printer' } }), /Choose a printer/);
	assert.throws(() => t.parseTokenInput({ name: 'x', scope: 'upload', upload: { kind: 'library', sourceId: 's', folder: '../up' } }), /Folder/);
	const q = t.parseTokenInput({ name: 'x', scope: 'upload', upload: { kind: 'queue', tags: 'PETG, 0.6mm' } });
	assert.deepEqual(q.options, { upload: { kind: 'queue', printerId: null, tags: ['petg', '0.6mm'] } });
	assert.equal(q.includeAddresses, false);
	assert.equal(compat.uploadTargetProblem({ kind: 'library', sourceId: ro.id, folder: '' }), 'RO is read-only; allow writing in its settings');
	assert.equal(compat.uploadTargetProblem({ kind: 'library', sourceId: lib.id, folder: '' }), null);
	assert.equal(compat.uploadTargetProblem({ kind: 'printer', printerId: 'nope', allowPrint: false }), 'The printer no longer exists');
	const bed = t.parseTokenInput({ name: 'button', bedClear: true });
	assert.deepEqual(bed.options, { bedClear: true });
});

test('read-only answers: what PrusaSlicer, OrcaSlicer and Cura check', () => {
	const p = { id: 'x', name: 'Orca', scope: 'upload' as const, includeAddresses: false, options: {} };
	const v = compat.readOnly('version', p) as { api: string; text: string };
	assert.ok(v.api, 'PrusaSlicer requires "api"');
	assert.ok(v.text.startsWith('OctoPrint'), 'PrusaSlicer/OrcaSlicer require text to start with OctoPrint');
	assert.ok((compat.readOnly('server', p) as { version: string }).version);
	assert.ok((compat.readOnly('printer', p) as { state: { flags: { operational: boolean } } }).state.flags.operational, 'Cura sees a ready printer');
	assert.ok(compat.readOnly('printerprofiles', p));
	assert.ok(compat.readOnly('settings', p));
	assert.deepEqual((compat.readOnly('files/local', p) as { files: unknown[] }).files, []);
	assert.equal(compat.readOnly('files/local/x.gcode', p), null);
	assert.equal(compat.readOnly('system/commands', p), null);
});

/** A multipart body exactly like libcurl builds for PrusaSlicer / OrcaSlicer. */
function prusa(name: string, data: string, { print = false, path = '' } = {}) {
	const b = '------------------------c0ffee1234abcd';
	const body =
		`--${b}\r\nContent-Disposition: form-data; name="print"\r\n\r\n${print}\r\n` +
		`--${b}\r\nContent-Disposition: form-data; name="path"\r\n\r\n${path}\r\n` +
		`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n${data}\r\n--${b}--\r\n`;
	return new Request('http://ocm.local/octoprint/api/files/local', { method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${b}` }, body });
}

async function upload(target: unknown, r: Request) {
	const { token } = key(target);
	const a = t.authorizeUploadRequest(req({ 'x-api-key': token }));
	assert.ok(a.ok);
	const res = await compat.handleUpload(r, new URL(r.url), a.principal, { ip: '10.0.0.9', base: 'http://ocm.local/octoprint' });
	return { status: res.status, body: (await res.json()) as Record<string, any>, location: res.headers.get('location') };
}

test('uploads to the library: into the key’s folder plus the slicer’s path', async () => {
	const r = await upload({ kind: 'library', sourceId: lib.id, folder: 'slicer' }, prusa('benchy.gcode', 'G28\nG1 X5\n', { path: 'parts' }));
	assert.equal(r.status, 201, JSON.stringify(r.body));
	assert.equal(r.body.done, true);
	assert.equal(r.body.files.local.path, 'slicer/parts/benchy.gcode');
	assert.equal(r.body.effectivePrint, false);
	assert.ok(r.location?.endsWith('/octoprint/api/files/local/slicer/parts/benchy.gcode'));
	assert.equal(readFileSync(join(libDir, 'slicer/parts/benchy.gcode'), 'utf8'), 'G28\nG1 X5\n');
	const bad = await upload({ kind: 'library', sourceId: lib.id, folder: '' }, prusa('model.3mf', 'zip'));
	assert.equal(bad.status, 415, 'only G-code');
	const roRes = await upload({ kind: 'queue' }, prusa('x.gcode', 'G28'));
	assert.equal(roRes.status, 201);
});

test('uploads to the queue: a job for any printer with the key’s tags, kept by octo·modern', async () => {
	const r = await upload({ kind: 'queue', tags: ['petg'] }, prusa('bracket.gcode', 'G28\n', { print: true }));
	assert.equal(r.status, 201);
	const job = qs.listJobs().find((j) => j.name === 'bracket.gcode')!;
	assert.ok(job);
	assert.equal(job.source, 'upload');
	assert.equal(job.printerId, null);
	assert.deepEqual(job.tags, ['petg']);
	assert.equal(job.createdBy, 'Key: Orca');
	assert.equal(readFileSync(stagedPath(job.id), 'utf8'), 'G28\n');
});

test('uploads straight to a printer: print only when the key allows it', async () => {
	received.length = 0;
	let r = await upload({ kind: 'printer', printerId: printer.id, allowPrint: false }, prusa('a.gcode', 'G28 A\n', { print: true }));
	assert.equal(r.status, 201);
	assert.equal(r.body.effectivePrint, false);
	assert.ok(!received[0].url.includes('print=true'), 'print not forwarded');
	assert.match(received[0].body, /G28 A/);
	r = await upload({ kind: 'printer', printerId: printer.id, allowPrint: true }, prusa('b.gcode', 'G28 B\n', { print: true, path: 'orca' }));
	assert.equal(r.body.effectivePrint, true);
	assert.match(received[1].url, /path=orca&select=true&print=true/);
	assert.equal(r.body.files.local.path, 'orca/b.gcode');
});
