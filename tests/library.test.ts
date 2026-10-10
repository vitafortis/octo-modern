import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { crc32, deflateSync } from 'node:zlib';

// The store reads its data dir and key at import: point them at a scratch dir first.
const dataDir = mkdtempSync(join(tmpdir(), 'ocm-library-test-'));
process.env.OCM_DATA_DIR = dataDir;
process.env.OCM_SECRET_KEY = 'library-test-master-key';

const { readMetaFrom } = await import('../src/lib/server/library/service.ts');
const gm = await import('../src/lib/server/library/gcode-meta.ts');
const { folderDriver, parsePropfind, readAll, within } = await import('../src/lib/server/library/drivers.ts');
const sources = await import('../src/lib/server/library/sources.ts');
const { sqlite } = await import('../src/lib/server/store.ts');
const { decrypt } = await import('../src/lib/server/crypto.ts');
const lib = await import('../src/lib/library.ts');
const access = await import('../src/lib/server/access.ts');

const fixture = (name: string) => readFileSync(new URL(`./fixtures/library/${name}`, import.meta.url));

/** Range reads over a buffer, counting the bytes read. */
function reader(buf: Buffer) {
	const r = { bytes: 0, calls: 0, read: async (start: number, end: number) => (r.calls++, (r.bytes += end - start + 1), buf.subarray(start, end + 1)) };
	return r;
}

// --- G-code metadata ---------------------------------------------------------------------

test('PrusaSlicer: stats and config from the footer, PNG + QOI thumbnails from the header', async () => {
	const buf = fixture('prusaslicer.gcode');
	const { meta, thumbnail } = await readMetaFrom(reader(buf).read, buf.length);
	assert.equal(meta.slicer, 'PrusaSlicer');
	assert.equal(meta.slicerVersion, '2.7.1');
	assert.equal(meta.estimatedTime, 3600 + 25 * 60 + 3);
	assert.equal(meta.filamentMm, 1234.6);
	assert.equal(meta.filamentG, 3.68);
	assert.equal(meta.filamentType, 'PETG');
	assert.equal(meta.layerHeight, 0.15);
	assert.equal(meta.firstLayerHeight, 0.2);
	assert.equal(meta.nozzle, 0.4);
	assert.equal(meta.nozzleTemp, 240);
	assert.equal(meta.bedTemp, 85);
	assert.equal(meta.printerModel, 'MK4');
	assert.equal(meta.format, 'text');
	// The 32×32 QOI (converted to PNG) beats the 16×16 PNG.
	assert.deepEqual(meta.thumbnail, { width: 32, height: 32, format: 'png' });
	assert.equal(thumbnail!.data.subarray(1, 4).toString(), 'PNG');
});

test('QOI thumbnails decode to the right pixels and re-encode as a valid PNG', () => {
	const text = fixture('prusaslicer.gcode').toString();
	const thumbs = gm.extractThumbnails(text);
	assert.deepEqual(
		thumbs.map((t) => [t.width, t.height, t.format]),
		[
			[16, 16, 'png'],
			[32, 32, 'png']
		]
	);
	const b64 = /thumbnail_QOI begin 32x32 \d+\n([\s\S]*?); thumbnail_QOI end/.exec(text)![1].replace(/[;\s]/g, '');
	const img = gm.decodeQoi(Buffer.from(b64, 'base64'));
	assert.equal(img.width, 32);
	assert.deepEqual([...img.pixels.subarray(0, 4)], [250, 104, 0, 255], 'left half is orange');
	assert.deepEqual([...img.pixels.subarray(31 * 4, 32 * 4)], [255, 255, 255, 255], 'right half is white');
	const png = thumbs[1].data;
	assert.equal(png.readUInt32BE(16), 32, 'IHDR width');
	assert.equal(png.readUInt32BE(20), 32, 'IHDR height');
});

test('SuperSlicer: multi-extruder sums, JPG thumbnail, day-long durations', async () => {
	const buf = fixture('superslicer.gcode');
	const { meta, thumbnail } = await readMetaFrom(reader(buf).read, buf.length);
	assert.equal(meta.slicer, 'SuperSlicer');
	assert.equal(meta.slicerVersion, '2.5.59.8');
	assert.equal(meta.estimatedTime, 2 * 86400 + 3 * 3600 + 4 * 60 + 5);
	assert.equal(meta.filamentMm, 1250.5);
	assert.equal(meta.filamentG, 3.74, 'the total wins over the per-extruder list');
	assert.equal(meta.filamentType, 'PLA', 'first extruder');
	assert.equal(meta.nozzle, 0.6);
	assert.equal(meta.nozzleTemp, 215);
	assert.equal(meta.printerModel, null, 'empty values are null');
	assert.equal(thumbnail!.format, 'jpg');
});

test('OrcaSlicer: a thumbnail that runs past the first 64 KB is read without reading the whole file', async () => {
	const buf = fixture('orcaslicer.gcode');
	const r = reader(buf);
	const { meta, thumbnail } = await readMetaFrom(r.read, buf.length);
	assert.equal(meta.slicer, 'OrcaSlicer');
	assert.equal(meta.slicerVersion, '2.1.1');
	assert.equal(meta.estimatedTime, 37 * 60 + 21);
	assert.equal(meta.layers, 50);
	assert.equal(meta.filamentG, 3.89);
	assert.equal(meta.filamentMm, 1302.9);
	assert.equal(meta.layerHeight, 0.2);
	assert.equal(meta.firstLayerHeight, 0.2);
	assert.equal(meta.nozzleTemp, 220);
	assert.equal(meta.bedTemp, 60);
	assert.equal(meta.printerModel, 'Voron 2.4 350');
	assert.deepEqual(meta.thumbnail, { width: 300, height: 300, format: 'png' }, 'the big thumbnail is complete');
	assert.ok(thumbnail!.data.length > 60_000);
	assert.ok(r.bytes < buf.length, `read ${r.bytes} of ${buf.length} bytes`);
	assert.ok(gm.headBytesNeeded(buf.subarray(0, gm.HEAD_BYTES)) > gm.HEAD_BYTES);
});

test('Cura: ;TIME, metres of filament, layer height, machine name and the post-processing thumbnail', async () => {
	const buf = fixture('cura.gcode');
	const { meta, thumbnail } = await readMetaFrom(reader(buf).read, buf.length);
	assert.equal(meta.slicer, 'Cura');
	assert.equal(meta.slicerVersion, '5.6.0');
	assert.equal(meta.estimatedTime, 5025);
	assert.equal(meta.filamentMm, 1812.6);
	assert.equal(meta.filamentG, null);
	assert.equal(meta.layerHeight, 0.2);
	assert.equal(meta.layers, 61);
	assert.equal(meta.printerModel, 'Creality Ender-3 Pro');
	assert.deepEqual([thumbnail!.width, thumbnail!.height], [24, 24]);
});

/** A Prusa binary G-code file: file/printer/print metadata, a thumbnail, then G-code. */
function bgcode(): Buffer {
	const parts: Buffer[] = [];
	const header = Buffer.alloc(10);
	header.write('GCDE', 0, 'latin1');
	header.writeUInt32LE(1, 4);
	header.writeUInt16LE(1, 8); // CRC32 checksums
	parts.push(header);
	const block = (type: number, params: Buffer, data: Buffer, compress = false) => {
		const stored = compress ? deflateSync(data) : data;
		const h = Buffer.alloc(compress ? 12 : 8);
		h.writeUInt16LE(type, 0);
		h.writeUInt16LE(compress ? 1 : 0, 2);
		h.writeUInt32LE(data.length, 4);
		if (compress) h.writeUInt32LE(stored.length, 8);
		const body = Buffer.concat([h, params, stored]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32LE(crc32(body) >>> 0);
		parts.push(body, crc);
	};
	const ini = (s: string) => Buffer.from(s);
	const enc = Buffer.from([0, 0]);
	block(0, enc, ini('Producer=PrusaSlicer 2.8.0+win64\n'));
	block(3, enc, ini('printer_model=MK4S\nfilament_type=PLA\nnozzle_diameter=0.4\nbed_temperature=60\ntemperature=215\nlayer_height=0.2\n'));
	const thumbPng = gm.encodePng(2, 2, Buffer.alloc(16, 200));
	const tp = Buffer.alloc(6);
	tp.writeUInt16LE(0, 0);
	tp.writeUInt16LE(2, 2);
	tp.writeUInt16LE(2, 4);
	block(5, tp, thumbPng);
	block(4, enc, ini('filament used [mm]=2345.6\nfilament used [g]=7.01\ntotal filament used [g]=7.01\nestimated printing time (normal mode)=2h 5m 0s\n'), true);
	block(1, enc, ini('G28\nG1 X10\n'));
	return Buffer.concat(parts);
}

test('binary G-code (.bgcode): metadata blocks (plain and deflated) and the thumbnail block', async () => {
	const buf = bgcode();
	assert.ok(gm.isBgcode(buf));
	const { meta, thumbnail } = await readMetaFrom(reader(buf).read, buf.length);
	assert.equal(meta.format, 'binary');
	assert.equal(meta.slicer, 'PrusaSlicer');
	assert.equal(meta.slicerVersion, '2.8.0');
	assert.equal(meta.printerModel, 'MK4S');
	assert.equal(meta.estimatedTime, 2 * 3600 + 5 * 60);
	assert.equal(meta.filamentG, 7.01);
	assert.equal(meta.filamentMm, 2345.6);
	assert.equal(meta.nozzleTemp, 215);
	assert.deepEqual(meta.thumbnail, { width: 2, height: 2, format: 'png' });
	assert.equal(thumbnail!.data.length, gm.encodePng(2, 2, Buffer.alloc(16, 200)).length);
});

test('durations and junk input', async () => {
	assert.equal(gm.parseDuration('1h 25m 3s'), 5103);
	assert.equal(gm.parseDuration('45s'), 45);
	assert.equal(gm.parseDuration('5025'), 5025);
	assert.equal(gm.parseDuration('soon'), null);
	const junk = Buffer.from('G28\nG1 X10\n; not = metadata = really\n');
	const { meta, thumbnail } = await readMetaFrom(reader(junk).read, junk.length);
	assert.equal(meta.slicer, null);
	assert.equal(meta.estimatedTime, null);
	assert.equal(thumbnail, null);
	// A truncated thumbnail block is ignored, not half-decoded.
	assert.deepEqual(gm.extractThumbnails('; thumbnail begin 16x16 400\n; iVBORw0KGgo\n'), []);
	const empty = await readMetaFrom(reader(Buffer.alloc(0)).read, 0);
	assert.equal(empty.meta.slicer, null);
});

// --- paths ---------------------------------------------------------------------------------

test('relative paths: traversal, absolute paths, backslashes and control characters are refused', () => {
	assert.equal(lib.cleanRelPath(''), '');
	assert.equal(lib.cleanRelPath('/a//b/'), 'a/b');
	assert.equal(lib.cleanRelPath('Ünïcode parts/benchy 2.gcode'), 'Ünïcode parts/benchy 2.gcode');
	for (const bad of ['..', '../etc/passwd', 'a/../../b', 'a/./b', 'a\\..\\b', 'a\u0000b', 'a\nb', 42]) {
		assert.throws(() => lib.cleanRelPath(bad), `${JSON.stringify(bad)} is refused`);
	}
	assert.ok(within('/lib', '/lib'));
	assert.ok(within('/lib', '/lib/a'));
	assert.ok(!within('/lib', '/library'), 'a sibling with the same prefix is outside');
	assert.ok(!within('/lib', '/'));
	assert.ok(lib.isPrintable('A.GCODE') && lib.isPrintable('x.bgcode') && !lib.isPrintable('model.stl') && !lib.isPrintable('gcode'));
	assert.ok(lib.isHiddenName('.DS_Store') && lib.isHiddenName('@eaDir') && lib.isHiddenName('#recycle') && !lib.isHiddenName('parts'));
});

test('folder sources: symlinks inside the root work, symlinks leading out are hidden and refused', async () => {
	const base = mkdtempSync(join(tmpdir(), 'ocm-lib-folder-'));
	const root = join(base, 'library');
	const outside = join(base, 'secret');
	mkdirSync(join(root, 'parts'), { recursive: true });
	mkdirSync(outside);
	writeFileSync(join(root, 'parts', 'clip.gcode'), '; generated by PrusaSlicer 2.7.1\nG28\n');
	writeFileSync(join(outside, 'passwords.gcode'), 'nope');
	symlinkSync(join(root, 'parts', 'clip.gcode'), join(root, 'clip-link.gcode'));
	symlinkSync(join(outside, 'passwords.gcode'), join(root, 'escape.gcode'));
	symlinkSync(outside, join(root, 'escape-dir'));
	symlinkSync(join(root, 'missing.gcode'), join(root, 'broken.gcode'));

	const d = folderDriver(root);
	const names = (await d.list('')).map((e) => e.name).sort();
	assert.deepEqual(names, ['clip-link.gcode', 'parts'], 'escaping and broken links are not listed');
	assert.equal((await readAll(await d.read('clip-link.gcode'), 1000)).toString().split('\n')[0], '; generated by PrusaSlicer 2.7.1');
	assert.equal((await readAll(await d.read('parts/clip.gcode', { start: 2, end: 10 }), 100)).toString(), 'generated');
	await assert.rejects(d.read('escape.gcode'), { code: 'OUTSIDE_ROOT' });
	await assert.rejects(d.list('escape-dir'), { code: 'OUTSIDE_ROOT' });
	await assert.rejects(d.read('escape-dir/passwords.gcode'), { code: 'OUTSIDE_ROOT' });
	await assert.rejects(d.read('../secret/passwords.gcode'), /\.\. segments/);
	await assert.rejects(d.read('nope.gcode'), { code: 'NOT_FOUND' });

	// Writes go through a temporary name, create folders, and never follow symlinks out.
	await d.write('saved/new.gcode', Readable.from([Buffer.from('G28\n')]), 4);
	assert.equal(readFileSync(join(root, 'saved', 'new.gcode'), 'utf8'), 'G28\n');
	assert.deepEqual(readdirSync(join(root, 'saved')), ['new.gcode'], 'no partial file left behind');
	await assert.rejects(d.write('escape.gcode', Readable.from([Buffer.from('x')]), 1), { code: 'SYMLINK' });
	await assert.rejects(d.write('escape-dir/x.gcode', Readable.from([Buffer.from('x')]), 1), { code: 'OUTSIDE_ROOT' });
	assert.equal(readFileSync(join(outside, 'passwords.gcode'), 'utf8'), 'nope');

	await assert.rejects(folderDriver(join(base, 'nowhere')).list(''), { code: 'NOT_FOUND' });
});

// --- WebDAV --------------------------------------------------------------------------------

test('WebDAV PROPFIND answers (Nextcloud-style prefixes, encoded names, 404 propstats)', () => {
	const xml = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
 <d:response><d:href>/remote.php/dav/files/me/Prints/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><d:getlastmodified>Sat, 10 Oct 2026 10:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><d:getcontentlength/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>
 <d:response><d:href>/remote.php/dav/files/me/Prints/Benchy%20%C3%BC.gcode</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>12345</d:getcontentlength><d:getlastmodified>Sat, 10 Oct 2026 11:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
 <D:response xmlns:D="DAV:"><D:href>https://dav.example/remote.php/dav/files/me/Prints/Parts/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
</d:multistatus>`;
	const entries = parsePropfind(xml);
	assert.deepEqual(
		entries.map((e) => [e.href, e.folder, e.size]),
		[
			['/remote.php/dav/files/me/Prints/', true, 0],
			['/remote.php/dav/files/me/Prints/Benchy ü.gcode', false, 12345],
			['/remote.php/dav/files/me/Prints/Parts/', true, 0]
		]
	);
	assert.equal(entries[1].mtime, Date.parse('Sat, 10 Oct 2026 11:00:00 GMT'));
});

// --- source configuration -------------------------------------------------------------------

test('source config validation', () => {
	const ok = (kind: string, config: object) => sources.parseSourceConfig(kind, config);
	assert.deepEqual(ok('folder', { path: '/library/' }), { kind: 'folder', config: { path: '/library' } });
	assert.throws(() => ok('folder', { path: 'library' }), /absolute/);
	assert.throws(() => ok('folder', { path: '/library/../etc' }), /\.\./);
	assert.throws(() => ok('ftp', {}), /kind/);
	const smb = ok('smb', { host: 'nas.lan', share: 'prints/3d/parts', user: 'me' });
	assert.deepEqual(smb, { kind: 'smb', config: { host: 'nas.lan', port: 445, share: 'prints', path: '3d/parts', domain: '', user: 'me' } });
	assert.throws(() => ok('smb', { host: 'nas.lan', share: '', user: 'me' }), /share/);
	assert.throws(() => ok('smb', { host: 'nas.lan', share: 'p' }), /user/);
	assert.throws(() => ok('smb', { host: 'nas lan; rm -rf', share: 'p', user: 'u' }), /host/);
	assert.throws(() => ok('sftp', { host: 'nas', user: 'u', port: 70000 }), /port/);
	assert.throws(() => ok('sftp', { host: 'nas', user: 'u', hostKey: 'ssh-rsa AAAA' }), /SHA256/);
	assert.throws(() => ok('sftp', { host: 'nas', user: 'u', path: '/srv/../etc' }), /\.\./);
	assert.equal((ok('sftp', { host: 'nas', user: 'u', path: '/srv/prints/' }) as { config: { path: string } }).config.path, '/srv/prints');
	assert.throws(() => ok('webdav', { url: 'ftp://x' }), /http/);
	assert.throws(() => ok('webdav', { url: 'https://me:pw@cloud.example/dav' }), /credentials/);
	assert.equal((ok('webdav', { url: 'https://cloud.example/dav/files/me/Prints?x=1#y' }) as { config: { url: string } }).config.url, 'https://cloud.example/dav/files/me/Prints/');

	// Credentials are required where the protocol needs them, and kept on edit.
	assert.throws(() => sources.parseSourceInput({ kind: 'sftp', config: { host: 'nas', user: 'u' } }), /password or a private key/);
	assert.throws(() => sources.parseSourceInput({ kind: 'smb', config: { host: 'nas', share: 's', user: 'u' } }), /password/);
	assert.throws(
		() => sources.parseSourceInput({ kind: 'sftp', config: { host: 'nas', user: 'u' }, secrets: { privateKey: 'not a key' } }),
		/PEM/
	);
	const input = sources.parseSourceInput({ kind: 'folder', config: { path: '/library' }, printers: ['a', 'a', 7], writable: 'yes' });
	assert.deepEqual(input.printers, ['a']);
	assert.equal(input.writable, false, 'only true turns writing on');
	assert.equal(input.name, '/library');
	assert.throws(() => sources.parseSourceInput({ kind: 'folder', config: { path: '/x' }, printers: 'some' }), /printers/);
});

test('secrets are sealed, bound to the source, and never part of the source view', () => {
	const src = sources.createSource(
		sources.parseSourceInput({ name: 'NAS', kind: 'sftp', config: { host: 'nas.lan', user: 'printer' }, secrets: { password: 'hunter2-sftp-password' } })
	);
	assert.equal(src.hasPassword, true);
	assert.equal(src.hasPrivateKey, false);
	assert.ok(!JSON.stringify(src).includes('hunter2'), 'the view has no secret');
	const row = sqlite().prepare('SELECT * FROM library_sources WHERE id = ?').get(src.id) as Record<string, string>;
	assert.ok(!JSON.stringify(row).includes('hunter2'), 'not stored in the clear');
	assert.match(row.secret, /^v1:/);
	assert.equal(sources.getSourceSecrets(src.id).password, 'hunter2-sftp-password');
	assert.throws(() => decrypt(row.secret, 'library:another-id'), 'bound to its id');

	// Editing without secrets keeps them; empty fields keep them too; a new value replaces.
	sources.updateSource(src.id, sources.parseSourceInput({ name: 'NAS 2', kind: 'sftp', config: { host: 'nas.lan', user: 'printer' } }, { existing: src }));
	assert.equal(sources.getSourceSecrets(src.id).password, 'hunter2-sftp-password');
	sources.updateSource(src.id, sources.parseSourceInput({ name: 'NAS 2', kind: 'sftp', config: { host: 'nas.lan', user: 'printer' }, secrets: { password: '' } }, { existing: src }));
	assert.equal(sources.getSourceSecrets(src.id).password, 'hunter2-sftp-password');
	sources.updateSource(src.id, sources.parseSourceInput({ name: 'NAS 2', kind: 'sftp', config: { host: 'nas.lan', user: 'printer' }, secrets: { password: 'new-one' } }, { existing: src }));
	assert.equal(sources.getSourceSecrets(src.id).password, 'new-one');
	// Switching to a folder drops them.
	sources.updateSource(src.id, sources.parseSourceInput({ name: 'NAS 2', kind: 'folder', config: { path: '/library' } }, { existing: sources.getSource(src.id) }));
	assert.deepEqual(sources.getSourceSecrets(src.id), {});
	assert.equal(sources.getSource(src.id)!.hasPassword, false);

	// The metadata cache goes with the source.
	sources.putMeta(src.id, 'a.gcode', '1-1', { slicer: 'x' }, Buffer.from('png'), 'png');
	assert.ok(sources.getMeta(src.id, 'a.gcode', '1-1'));
	assert.equal(sources.getMeta(src.id, 'a.gcode', '2-1'), undefined, 'a changed file misses the cache');
	assert.ok(sources.deleteSource(src.id));
	assert.equal((sqlite().prepare('SELECT count(*) AS n FROM library_meta').get() as { n: number }).n, 0);
});

test('route rules: admins manage sources, operators send, viewers browse', () => {
	assert.equal(access.adminOnlyApi('GET', '/api/library/sources'), false);
	assert.equal(access.adminOnlyApi('POST', '/api/library/sources'), true);
	assert.equal(access.adminOnlyApi('PUT', '/api/library/sources/abc'), true);
	assert.equal(access.adminOnlyApi('POST', '/api/library/sources/test'), true);
	assert.equal(access.controlApi('POST', '/api/library/abc/send'), true);
	assert.equal(access.controlApi('DELETE', '/api/library/sends/abc'), true);
	assert.equal(access.controlApi('GET', '/api/library/abc/list'), false);
	assert.equal(access.controlApi('POST', '/api/printers/p1/files/library'), true);
	assert.ok(access.ADMIN_PAGES.includes('/library/sources'));
});
