import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	contentDisposition,
	contentTypeFor,
	forwardHeaders,
	parseTimelapseListing,
	PASS_STATUSES,
	responseHeaders,
	timelapseConfigBody,
	validTimelapseName
} from '../src/lib/server/octoprint/timelapse.ts';

test('the listing OctoPrint 1.11 sends', () => {
	const l = parseTimelapseListing({
		config: { fps: 10, interval: 1, postRoll: 0, renderAfterPrint: 'always', type: 'timed' },
		enabled: true,
		files: [
			{ bytes: 22762, date: '2026-10-10 23:19', name: 'tl_20261010231902.mp4', size: '22.2KB', thumbnail: '/downloads/timelapse/tl_20261010231902.mp4.thumb.jpg', timestamp: 1791674352.847668, url: '/downloads/timelapse/tl_20261010231902.mp4' },
			{ bytes: 1000, date: '2026-10-11 08:00', name: 'old.mpg', size: '1KB', url: '/downloads/timelapse/old.mpg' },
			{ bytes: 1, name: '../etc/passwd' }
		],
		unrendered: [{ bytes: 5000, count: 12, date: '2026-10-11 09:00', name: 'tl_x', recording: true, rendering: false, processing: false }]
	});
	assert.equal(l.enabled, true);
	assert.deepEqual(l.config, { type: 'timed', fps: 10, interval: 1, postRoll: 0, retractionZHop: null, minDelay: null });
	assert.deepEqual(
		l.files.map((f) => [f.name, f.playable, f.thumbnail]),
		[
			['old.mpg', false, null],
			['tl_20261010231902.mp4', true, 'tl_20261010231902.mp4.thumb.jpg']
		],
		'newest first; unsafe names dropped'
	);
	assert.equal(l.files[1].date, 1791674352848);
	assert.deepEqual(l.unrendered[0], { name: 'tl_x', bytes: 5000, date: Date.parse('2026-10-11T09:00'), count: 12, recording: true, rendering: false, processing: false });
	assert.deepEqual(parseTimelapseListing(null), { enabled: true, config: { type: 'off', fps: null, interval: null, postRoll: null, retractionZHop: null, minDelay: null }, files: [], unrendered: [] });
});

test('file names: only plain names in the timelapse folder', () => {
	for (const ok of ['a.mp4', 'tl_2026.mp4.thumb.jpg', 'Benchy (1)-fail.mp4']) assert.ok(validTimelapseName(ok), ok);
	for (const bad of ['', '..', '.hidden', 'a/b.mp4', 'a\\b.mp4', '../x', 'x\ny', 'a'.repeat(256), null, 3]) assert.ok(!validTimelapseName(bad), String(bad));
});

test('config changes are validated', () => {
	assert.deepEqual(timelapseConfigBody({ type: 'off' }), { type: 'off', save: true });
	assert.deepEqual(timelapseConfigBody({ type: 'timed', fps: '25', interval: 10, postRoll: 0, retractionZHop: 1 }), { type: 'timed', save: true, fps: 25, interval: 10, postRoll: 0 });
	assert.deepEqual(timelapseConfigBody({ type: 'zchange', fps: 30, retractionZHop: 0.4, minDelay: 5, interval: 10 }), { type: 'zchange', save: true, fps: 30, retractionZHop: 0.4, minDelay: 5 });
	assert.throws(() => timelapseConfigBody({ type: 'sometimes' }), /type/);
	assert.throws(() => timelapseConfigBody({ type: 'timed', fps: 0 }), /fps/);
	assert.throws(() => timelapseConfigBody({ type: 'timed', fps: 2.5 }), /whole number/);
	assert.throws(() => timelapseConfigBody({ type: 'timed', interval: 99999 }), /interval/);
});

test('Range requests: a single byte range and its validators are forwarded', () => {
	const h = (o: Record<string, string>) => new Headers(o);
	assert.deepEqual(forwardHeaders(h({ range: 'bytes=0-' })), { range: 'bytes=0-' });
	assert.deepEqual(forwardHeaders(h({ range: 'bytes=100-199', 'if-range': '"123"', cookie: 'secret', authorization: 'x' })), { range: 'bytes=100-199', 'if-range': '"123"' });
	assert.deepEqual(forwardHeaders(h({ range: 'bytes=-500' })), { range: 'bytes=-500' }, 'suffix range');
	assert.deepEqual(forwardHeaders(h({ range: 'bytes=0-1,5-9' })), {}, 'multi-range: send the whole file instead');
	assert.deepEqual(forwardHeaders(h({ range: 'items=0-5' })), {});
	assert.deepEqual(forwardHeaders(h({ 'if-range': '"x"' })), {}, 'if-range only with a range');
	assert.deepEqual(forwardHeaders(h({ 'if-none-match': '"abc"', 'if-modified-since': 'Sat, 10 Oct 2026 23:19:12 GMT' })), {
		'if-none-match': '"abc"',
		'if-modified-since': 'Sat, 10 Oct 2026 23:19:12 GMT'
	});
});

test('Range responses: status and range headers pass through, disposition is ours', () => {
	const upstream = new Headers({
		'content-type': 'video/mp4',
		'accept-ranges': 'bytes',
		etag: '"1791674352"',
		'last-modified': 'Sat, 10 Oct 2026 23:19:12 GMT',
		'content-disposition': 'attachment; filename="tl.mp4"',
		'content-range': 'bytes 100-199/22762',
		'content-length': '100',
		'set-cookie': 'session=octoprint',
		'x-frame-options': 'sameorigin'
	});
	const out = responseHeaders(upstream, 'tl.mp4', false);
	assert.deepEqual(out, {
		'content-type': 'video/mp4',
		'content-disposition': `inline; filename="tl.mp4"; filename*=UTF-8''tl.mp4`,
		'cache-control': 'private, max-age=0, must-revalidate',
		'x-content-type-options': 'nosniff',
		'content-length': '100',
		'content-range': 'bytes 100-199/22762',
		etag: '"1791674352"',
		'last-modified': 'Sat, 10 Oct 2026 23:19:12 GMT',
		'accept-ranges': 'bytes'
	});
	assert.match(responseHeaders(upstream, 'tl.mp4', true)['content-disposition'], /^attachment;/);
	assert.ok(!('accept-ranges' in responseHeaders(new Headers({ 'content-length': '5' }), 'a.mp4', false)), 'no ranges announced unless OctoPrint supports them');
	for (const s of [200, 206, 304, 416]) assert.ok(PASS_STATUSES.has(s));
	assert.ok(!PASS_STATUSES.has(401) && !PASS_STATUSES.has(500));
});

test('content types and dispositions', () => {
	assert.equal(contentTypeFor('a.mp4', 'application/octet-stream'), 'video/mp4');
	assert.equal(contentTypeFor('a.mp4', null), 'video/mp4');
	assert.equal(contentTypeFor('a.mpg', 'video/mpeg'), 'video/mpeg');
	assert.equal(contentTypeFor('a.mp4.thumb.jpg', null), 'image/jpeg');
	assert.equal(contentTypeFor('a.bin', null), 'application/octet-stream');
	assert.equal(contentDisposition('Bénchy "v2".mp4', true), `attachment; filename="B_nchy _v2_.mp4"; filename*=UTF-8''B%C3%A9nchy%20%22v2%22.mp4`);
});
