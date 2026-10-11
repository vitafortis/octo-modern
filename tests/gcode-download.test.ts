import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

const dataDir = mkdtempSync(join(tmpdir(), 'ocm-gcode-dl-test-'));
process.env.OCM_DATA_DIR = dataDir;
process.env.OCM_SECRET_KEY = 'gcode-download-test-key';

const { parseRange, rangeHeaders, libraryDownload, octoprintDownload } = await import('../src/lib/server/gcode-download.ts');
const sources = await import('../src/lib/server/library/sources.ts');
const { closeAll } = await import('../src/lib/server/library/service.ts');
const { OctoPrintClient } = await import('../src/lib/server/octoprint/client.ts');
const access = await import('../src/lib/server/access.ts');

after(() => closeAll());

test('Range header parsing', () => {
	assert.equal(parseRange(null, 100), null);
	assert.equal(parseRange('items=0-5', 100), null);
	assert.equal(parseRange('bytes=0-5,10-20', 100), null, 'multi-range: whole file');
	assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
	assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
	assert.deepEqual(parseRange('bytes=90-500', 100), { start: 90, end: 99 }, 'clamped to the end');
	assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 }, 'suffix');
	assert.deepEqual(parseRange('bytes=-1000', 100), { start: 0, end: 99 });
	assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable');
	assert.equal(parseRange('bytes=5-2', 100), 'unsatisfiable');
	const h = rangeHeaders(100, { start: 10, end: 19 }, 'a b.gcode');
	assert.equal(h['content-range'], 'bytes 10-19/100');
	assert.equal(h['content-length'], '10');
	assert.match(h['content-disposition'], /a%20b\.gcode/);
	assert.equal(h['x-content-type-options'], 'nosniff');
});

test('library files: whole, ranged and out-of-range reads from a folder source', async () => {
	const root = join(dataDir, 'lib');
	mkdirSync(join(root, 'sub'), { recursive: true });
	const body = Array.from({ length: 2000 }, (_, i) => `G1 X${i} Y${i} E0.1`).join('\n');
	writeFileSync(join(root, 'sub/part.gcode'), body);
	const src = sources.createSource(sources.parseSourceInput({ name: 'Local', kind: 'folder', config: { path: root } }));

	const whole = await libraryDownload(src, 'sub/part.gcode', null, 'part.gcode');
	assert.equal(whole.status, 200);
	assert.equal(whole.headers.get('content-length'), String(body.length));
	assert.equal(await whole.text(), body);

	const part = await libraryDownload(src, 'sub/part.gcode', 'bytes=100-199', 'part.gcode');
	assert.equal(part.status, 206);
	assert.equal(part.headers.get('content-range'), `bytes 100-199/${body.length}`);
	assert.equal(await part.text(), body.slice(100, 200));

	const past = await libraryDownload(src, 'sub/part.gcode', `bytes=${body.length}-`, 'part.gcode');
	assert.equal(past.status, 416);
	await assert.rejects(() => libraryDownload(src, 'sub', null, 'sub'), /Not a file/);
});

test('OctoPrint files: Range passes through, the API key stays on the server', async () => {
	const seen: { url?: string; key?: string; range?: string }[] = [];
	const file = Buffer.from('G28\nG1 X10 Y10 E1\n'.repeat(100));
	const server = createServer((req, res) => {
		seen.push({ url: req.url, key: req.headers['x-api-key'] as string, range: req.headers.range });
		if (!req.url?.startsWith('/downloads/files/local/')) {
			res.writeHead(404).end();
			return;
		}
		const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '');
		if (m) {
			const [s, e] = [Number(m[1]), Number(m[2])];
			res.writeHead(206, { 'content-range': `bytes ${s}-${e}/${file.length}`, 'content-length': String(e - s + 1), 'accept-ranges': 'bytes', 'set-cookie': 'session=octoprint' });
			res.end(file.subarray(s, e + 1));
		} else {
			res.writeHead(200, { 'content-length': String(file.length), 'accept-ranges': 'bytes' });
			res.end(file);
		}
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	try {
		const port = (server.address() as AddressInfo).port;
		const client = new OctoPrintClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'secret-key-123456', verifyTls: true });
		const res = await octoprintDownload(client, 'parts/my part.gcode', 'bytes=0-9', new AbortController().signal);
		assert.equal(res.status, 206);
		assert.equal(res.headers.get('content-range'), `bytes 0-9/${file.length}`);
		assert.equal(res.headers.get('set-cookie'), null, 'only whitelisted headers are relayed');
		assert.equal(await res.text(), file.subarray(0, 10).toString());
		assert.equal(seen[0].url, '/downloads/files/local/parts/my%20part.gcode');
		assert.equal(seen[0].key, 'secret-key-123456');
		assert.equal(seen[0].range, 'bytes=0-9');
		const all = await octoprintDownload(client, 'a.gcode', null, new AbortController().signal);
		assert.equal(all.status, 200);
		assert.equal((await all.arrayBuffer()).byteLength, file.length);
		assert.ok(!JSON.stringify([...all.headers]).includes('secret-key'));
	} finally {
		server.close();
	}
});

test('route rules: previews are reads, open to viewers', () => {
	assert.equal(access.controlApi('GET', '/api/printers/p1/files/download'), false);
	assert.equal(access.adminOnlyApi('GET', '/api/printers/p1/files/download'), false);
	assert.equal(access.controlApi('GET', '/api/library/s1/download'), false);
	assert.equal(access.adminOnlyApi('GET', '/api/library/s1/download'), false);
	assert.equal(access.roleAllows('viewer', 'view'), true);
});
