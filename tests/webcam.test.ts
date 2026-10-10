import { test } from 'node:test';
import assert from 'node:assert/strict';
import { camerasFromOverride, camerasFromSettings, siblingUrl, streamKind, toInfo } from '../src/lib/server/octoprint/webcam.ts';

const BASE = 'http://octopi.lan/octoprint';

test('classic webcam (OctoPrint ≥1.9 webcams list), relative URLs resolved against the base', () => {
	const cams = camerasFromSettings(
		{ webcam: { webcamEnabled: true, webcams: [{ name: 'classic', displayName: 'Classic Webcam', canSnapshot: true, flipH: true, rotate90: true, compat: { stream: '/webcam/?action=stream', snapshot: 'http://cam.lan:8080/?action=snapshot' } }] } },
		BASE
	);
	assert.equal(cams.length, 1);
	assert.equal(cams[0].streamUrl, 'http://octopi.lan/webcam/?action=stream');
	assert.equal(cams[0].snapshotUrl, 'http://cam.lan:8080/?action=snapshot');
	assert.equal(cams[0].kind, 'mjpeg');
	assert.ok(cams[0].flipH && cams[0].rotate90 && !cams[0].flipV);
	const info = toInfo(cams[0]);
	assert.equal(info.proxied, true);
	assert.equal(info.externalUrl, null, 'proxied cameras never send their URL to the browser');
	assert.ok(!JSON.stringify(info).includes('cam.lan'));
});

test('several cameras get a switcher; HLS and WebRTC are linked, not proxied', () => {
	const cams = camerasFromSettings(
		{
			webcam: {
				webcams: [
					{ name: 'bed', displayName: 'Bed cam', compat: { stream: 'webcam/?action=stream', snapshot: '' } },
					{ name: 'hls', displayName: 'Nozzle', extras: { stream: 'http://cam2.lan/stream.m3u8' } },
					{ name: 'rtc', displayName: 'Room', extras: { stream: 'http://cam3.lan/webrtc' } },
					{ name: 'empty', compat: { stream: '', snapshot: '' } }
				]
			}
		},
		BASE
	);
	assert.deepEqual(cams.map((c) => [c.id, c.label, c.kind]), [['bed', 'Bed cam', 'mjpeg'], ['hls', 'Nozzle', 'hls'], ['rtc', 'Room', 'webrtc']]);
	assert.equal(cams[0].snapshotUrl, 'http://octopi.lan/octoprint/webcam/?action=snapshot', 'snapshot derived from the MJPEG stream');
	assert.equal(toInfo(cams[1]).externalUrl, 'http://cam2.lan/stream.m3u8');
	assert.equal(toInfo(cams[1]).proxied, false);
	assert.equal(cams[1].snapshotUrl, null);
});

test('legacy settings, disabled webcams, and nothing configured', () => {
	assert.equal(camerasFromSettings({ webcam: { streamUrl: '/webcam/?action=stream', snapshotUrl: '' } }, 'http://p')[0].snapshotUrl, 'http://p/webcam/?action=snapshot');
	assert.deepEqual(camerasFromSettings({ webcam: { webcamEnabled: false, streamUrl: '/x' } }, 'http://p'), []);
	assert.deepEqual(camerasFromSettings({ webcam: { streamUrl: '', snapshotUrl: '', webcams: [{ compat: { stream: '', snapshot: '' } }] } }, 'http://p'), []);
	assert.deepEqual(camerasFromSettings({}, 'http://p'), []);
	assert.deepEqual(camerasFromSettings({ webcam: { streamUrl: 'javascript:alert(1)' } }, 'http://p'), [], 'only http(s)');
});

test('the override wins and can be a stream or a snapshot URL', () => {
	const s = camerasFromOverride('http://cam.lan:8080/?action=stream', BASE)[0];
	assert.equal(s.snapshotUrl, 'http://cam.lan:8080/?action=snapshot');
	const snap = camerasFromOverride('/webcam/snapshot', BASE)[0];
	assert.equal(snap.snapshotUrl, 'http://octopi.lan/webcam/snapshot');
	assert.equal(snap.streamUrl, 'http://octopi.lan/webcam/stream');
	assert.equal(camerasFromOverride('http://cam.lan/still.jpg', BASE)[0].streamUrl, null);
	assert.equal(siblingUrl('http://x/foo', 'snapshot'), null);
	assert.equal(streamKind('http://x/index.m3u8?a=1'), 'hls');
	assert.equal(streamKind(null), null);
});
