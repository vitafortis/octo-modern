// End-to-end test of the Library (print from your NAS) against real servers in Docker:
// two OctoPrint virtual printers, an SFTP server (atmoz/sftp), a Samba server
// (crazymax/samba) and a WebDAV server (rclone), plus a local folder source.
//
//   pnpm e2e:library                  # build, run, test, screenshot, clean up
//   E2E_KEEP=1 pnpm e2e:library       # leave everything running afterwards
//   E2E_SKIP_BUILD=1 pnpm e2e:library # reuse ./build
//
// Needs Docker and a Playwright Chromium. Screenshots land in docs/screenshots/.
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '../..');
const SHOTS = join(ROOT, 'docs/screenshots');
const FIXTURES = join(ROOT, 'tests/fixtures/library');
const APP_PORT = Number(process.env.E2E_APP_PORT ?? 3141);
const APP = `http://127.0.0.1:${APP_PORT}`;
const OP_BASE = Number(process.env.E2E_OP_PORT_BASE ?? 5121);
const OP_PREFIX = 'octo-modern-nas-e2e-op';
const HELPER_BASE = Number(process.env.E2E_HELPER_PORT_BASE ?? 5221);
const SFTP = { name: 'octo-modern-nas-e2e-sftp', port: HELPER_BASE, user: 'nas', password: 'sftp-pass-e2e' };
const SMB = { name: 'octo-modern-nas-e2e-smb', port: HELPER_BASE + 1, user: 'nas', password: 'smb-pass-e2e' };
const DAV = { name: 'octo-modern-nas-e2e-dav', port: HELPER_BASE + 2, user: 'nas', password: 'dav-pass-e2e' };
const OP = [1, 2].map((i) => ({ url: `http://127.0.0.1:${OP_BASE + i - 1}`, key: `ocm-dev-key-${i}` }));
const ADMIN = { email: 'admin@example.com', name: 'Ada Admin', password: 'e2e-admin-password' };
const OPERATOR = { email: 'operator@example.com', name: 'Otto Operator', password: 'e2e-operator-password' };
const VIEWER = { email: 'viewer@example.com', name: 'Vera Viewer', password: 'e2e-viewer-password' };
const BIG_MB = Number(process.env.E2E_BIG_MB ?? 150);
/** The slicer fixtures, under the names they get in the demo library. */
const DEMO = {
	'prusaslicer.gcode': 'bracket_PETG_0.15mm_MK4.gcode',
	'orcaslicer.gcode': 'cable-clip-ring_PLA_0.2mm.gcode',
	'cura.gcode': 'spool-hub_PLA_Ender3.gcode',
	'superslicer.gcode': 'control-knob_PLA_0.6n.gcode'
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);
const docker = (...args) => execFileSync('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const devOctoprint = (...args) =>
	execFileSync(join(ROOT, 'scripts/dev-octoprint.sh'), args, { env: { ...process.env, OCM_OP_PORT_BASE: String(OP_BASE), OCM_OP_PREFIX: OP_PREFIX }, stdio: 'inherit' });

let app;
let browser;
const work = mkdtempSync(join(tmpdir(), 'ocm-e2e-library-'));
const dataDir = join(work, 'data');
const libDir = join(work, 'library');

async function waitFor(fn, label, { tries = 60, every = 500 } = {}) {
	let last;
	for (let i = 0; i < tries; i++) {
		try {
			const v = await fn();
			if (v) return v;
		} catch (err) {
			last = err;
		}
		await sleep(every);
	}
	throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

function client() {
	let cookie = '';
	const call = async (method, path, body, { raw = false } = {}) => {
		const res = await fetch(`${APP}${path}`, {
			method,
			redirect: 'manual',
			headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), origin: APP },
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		const set = res.headers.get('set-cookie');
		if (set) cookie = set.split(';')[0];
		if (raw) return res;
		const data = await res.json().catch(() => null);
		return { status: res.status, data };
	};
	return {
		get: (p, o) => call('GET', p, undefined, o),
		post: (p, b, o) => call('POST', p, b ?? {}, o),
		put: (p, b) => call('PUT', p, b),
		del: (p) => call('DELETE', p, {}),
		get cookie() {
			return cookie;
		}
	};
}

async function opState(op) {
	const r = await fetch(`${op.url}/api/job`, { headers: { 'X-Api-Key': op.key } });
	return (await r.json()).state;
}

async function opFile(op, path) {
	const r = await fetch(`${op.url}/api/files/local/${path.split('/').map(encodeURIComponent).join('/')}`, { headers: { 'X-Api-Key': op.key } });
	return r.status === 200 ? r.json() : null;
}

async function opDelete(op, path) {
	await fetch(`${op.url}/api/files/local/${path.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE', headers: { 'X-Api-Key': op.key } });
}

/** A big G-code file with a PrusaSlicer header (and thumbnail) and footer, written to disk without holding it in memory. */
async function writeBigGcode(file, megabytes) {
	const prusa = readFileSync(join(FIXTURES, 'prusaslicer.gcode'), 'utf8');
	const cut = prusa.indexOf('M73 P100');
	const head = Buffer.from(prusa.slice(0, prusa.indexOf('G28') + 4));
	const tail = Buffer.from(prusa.slice(cut));
	const line = Buffer.from('G1 X100.000 Y100.000 E0.01000 ; padding for a large-file test'.padEnd(1023, ' ') + '\n');
	const out = createWriteStream(file);
	out.write(head);
	for (let i = 0; i < megabytes * 1024; i++) if (!out.write(line)) await once(out, 'drain');
	out.end(tail);
	await once(out, 'finish');
	return statSync(file).size;
}

/** Fills a library folder: the slicer fixtures, a nested folder, a non-G-code file and a printable test job. */
function fillLibrary(dir) {
	mkdirSync(join(dir, 'Functional/Clips'), { recursive: true });
	for (const [fixture, name] of Object.entries(DEMO)) copyFileSync(join(FIXTURES, fixture), join(dir, name));
	copyFileSync(join(FIXTURES, 'orcaslicer.gcode'), join(dir, 'Functional/Clips/cable-clip_PLA_0.2mm.gcode'));
	copyFileSync(join(FIXTURES, 'superslicer.gcode'), join(dir, 'Functional/spool-holder.gcode'));
	writeFileSync(join(dir, 'Functional/notes.txt'), 'not G-code');
	writeFileSync(join(dir, 'README.md'), '# prints');
	mkdirSync(join(dir, '@eaDir'));
	writeFileSync(join(dir, '.DS_Store'), 'x');
}

async function startHelpers() {
	for (const c of [SFTP.name, SMB.name, DAV.name]) execFileSync('docker', ['rm', '-f', c], { stdio: 'ignore' });
	// SFTP: atmoz/sftp, user "nas" with a writable "prints" folder.
	docker('run', '-d', '--name', SFTP.name, '--label', 'octo-modern.e2e=1', '-p', `127.0.0.1:${SFTP.port}:22`, 'atmoz/sftp', `${SFTP.user}:${SFTP.password}:1001::prints`);
	// Samba: crazymax/samba with one share; files live inside the container (bind mounts from macOS break its xattr VFS).
	const smbConf = join(work, 'samba');
	mkdirSync(smbConf, { recursive: true });
	writeFileSync(
		join(smbConf, 'config.yml'),
		`auth:\n  - user: ${SMB.user}\n    group: ${SMB.user}\n    uid: 1000\n    gid: 1000\n    password: ${SMB.password}\nglobal:\n  - "force user = ${SMB.user}"\n  - "force group = ${SMB.user}"\nshare:\n  - name: prints\n    path: /samba/prints\n    browsable: yes\n    readonly: no\n    guestok: no\n    validusers: ${SMB.user}\n    writelist: ${SMB.user}\n`
	);
	docker('run', '-d', '--name', SMB.name, '--label', 'octo-modern.e2e=1', '-p', `127.0.0.1:${SMB.port}:445`, '-v', `${smbConf}:/data`, 'crazymax/samba');
	// WebDAV: rclone serving a folder inside the container.
	docker('run', '-d', '--name', DAV.name, '--label', 'octo-modern.e2e=1', '-p', `127.0.0.1:${DAV.port}:80`, 'rclone/rclone', 'serve', 'webdav', '/data', '--addr', ':80', '--user', DAV.user, '--pass', DAV.password);
}

async function fillHelpers(bigFile) {
	const staged = join(work, 'staged');
	mkdirSync(staged, { recursive: true });
	fillLibrary(staged);
	await waitFor(() => docker('exec', SFTP.name, 'sh', '-c', 'test -d /home/nas/prints && echo ok').includes('ok'), 'the SFTP server');
	docker('cp', `${staged}/.`, `${SFTP.name}:/home/nas/prints/`);
	docker('cp', bigFile, `${SFTP.name}:/home/nas/prints/big-sftp.gcode`);
	docker('exec', SFTP.name, 'chown', '-R', '1001', '/home/nas/prints');
	await waitFor(() => docker('exec', SMB.name, 'sh', '-c', 'pgrep smbd >/dev/null && echo ok').includes('ok'), 'the Samba server');
	docker('exec', SMB.name, 'mkdir', '-p', '/samba/prints');
	docker('cp', `${staged}/.`, `${SMB.name}:/samba/prints/`);
	docker('cp', bigFile, `${SMB.name}:/samba/prints/big-smb.gcode`);
	docker('exec', SMB.name, 'chown', '-R', '1000:1000', '/samba/prints');
	docker('exec', DAV.name, 'mkdir', '-p', '/data');
	docker('cp', `${staged}/.`, `${DAV.name}:/data/`);
}

async function main() {
	mkdirSync(SHOTS, { recursive: true });
	mkdirSync(dataDir, { recursive: true });
	mkdirSync(libDir, { recursive: true });

	log('starting SFTP, Samba and WebDAV servers');
	await startHelpers();
	log('starting two OctoPrint servers with virtual printers');
	devOctoprint('up', '2');

	log(`writing a ${BIG_MB} MB G-code file`);
	fillLibrary(libDir);
	const bigFile = join(libDir, 'big-folder.gcode');
	const bigSize = await writeBigGcode(bigFile, BIG_MB);
	// A symlink that leads out of the library must stay invisible.
	mkdirSync(join(work, 'outside'));
	writeFileSync(join(work, 'outside', 'secret.gcode'), 'G28 ; outside the library\n');
	symlinkSync(join(work, 'outside', 'secret.gcode'), join(libDir, 'escape.gcode'));
	symlinkSync(join(work, 'outside'), join(libDir, 'escape-dir'));
	await fillHelpers(bigFile);

	if (!process.env.E2E_SKIP_BUILD) {
		log('building');
		execFileSync('pnpm', ['build'], { cwd: ROOT, stdio: 'ignore' });
	}
	log(`starting octo·modern on ${APP}`);
	app = spawn('node', ['build'], {
		cwd: ROOT,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, PORT: String(APP_PORT), HOST: '127.0.0.1', OCM_DATA_DIR: dataDir, OCM_POLL_INTERVAL_MS: '3000', BODY_SIZE_LIMIT: '4G', NODE_OPTIONS: '--disable-warning=ExperimentalWarning' }
	});
	let appLog = '';
	app.stdout.on('data', (d) => (appLog += d));
	app.stderr.on('data', (d) => (appLog += d));
	await waitFor(async () => (await fetch(`${APP}/api/health`)).ok, 'the app');

	// --- setup -----------------------------------------------------------------------------
	const admin = client();
	assert.equal((await admin.post('/api/auth/setup', ADMIN)).status, 200);
	const p1 = (await admin.post('/api/printers', { name: 'Prusa MK4', baseUrl: OP[0].url, apiKey: OP[0].key, color: 'violet' })).data;
	const p2 = (await admin.post('/api/printers', { name: 'Voron 2.4', baseUrl: OP[1].url, apiKey: OP[1].key, color: 'cyan' })).data;
	for (const [p, op] of [
		[p1, OP[0]],
		[p2, OP[1]]
	]) {
		assert.equal((await admin.post(`/api/printers/${p.id}/connection`, { command: 'connect', port: 'VIRTUAL', baudrate: 115200 })).status, 200);
		await waitFor(async () => (await opState(op)) === 'Operational', `${p.name} operational`);
	}
	for (const u of [
		{ ...OPERATOR, role: 'operator' },
		{ ...VIEWER, role: 'viewer' }
	]) assert.equal((await admin.post('/api/users', u)).status, 201);
	const operator = client();
	const viewer = client();
	assert.equal((await operator.post('/api/auth/login', OPERATOR)).status, 200);
	assert.equal((await viewer.post('/api/auth/login', VIEWER)).status, 200);

	// --- sources ---------------------------------------------------------------------------
	log('sources: test, validation, credentials stay on the server');
	const folderCfg = { name: 'NAS prints', kind: 'folder', config: { path: libDir }, writable: true };
	const t1 = (await admin.post('/api/library/sources/test', folderCfg)).data;
	assert.equal(t1.ok, true, JSON.stringify(t1));
	assert.ok(t1.printable >= 4 && t1.folders === 1, `the escaping symlinked folder is not counted: ${JSON.stringify(t1)}`);
	const sftpCfg = { name: 'Synology (SFTP)', kind: 'sftp', config: { host: '127.0.0.1', port: SFTP.port, user: SFTP.user, path: 'prints' }, secrets: { password: SFTP.password } };
	const t2 = (await admin.post('/api/library/sources/test', sftpCfg)).data;
	assert.equal(t2.ok, true, JSON.stringify(t2));
	assert.match(t2.hostKey, /^SHA256:/, 'the test reports the host key for pinning');
	const smbCfg = { name: 'TrueNAS (SMB)', kind: 'smb', config: { host: '127.0.0.1', port: SMB.port, share: 'prints', user: SMB.user }, secrets: { password: SMB.password } };
	const t3 = await waitFor(async () => {
		const r = (await admin.post('/api/library/sources/test', smbCfg)).data;
		return r.ok ? r : null;
	}, 'the SMB share', { tries: 20, every: 1000 });
	assert.ok(t3.printable >= 4);
	const badSmb = (await admin.post('/api/library/sources/test', { ...smbCfg, secrets: { password: 'wrong-password' } })).data;
	assert.equal(badSmb.ok, false);
	assert.equal(badSmb.error.code, 'AUTH', JSON.stringify(badSmb));
	const davCfg = { name: 'Nextcloud (WebDAV)', kind: 'webdav', config: { url: `http://127.0.0.1:${DAV.port}/`, user: DAV.user }, secrets: { password: DAV.password } };
	assert.equal((await admin.post('/api/library/sources/test', davCfg)).data.ok, true);
	const refused = (await admin.post('/api/library/sources/test', { ...sftpCfg, config: { ...sftpCfg.config, port: 5299 } })).data;
	assert.equal(refused.error.code, 'ECONNREFUSED');
	assert.equal((await admin.post('/api/library/sources', { kind: 'folder', config: { path: 'relative' } })).status, 400);
	assert.equal((await admin.post('/api/library/sources', { ...sftpCfg, secrets: undefined })).status, 400, 'SFTP needs a password or key');

	const folder = (await admin.post('/api/library/sources', folderCfg)).data;
	const sftp = (await admin.post('/api/library/sources', { ...sftpCfg, config: { ...sftpCfg.config, hostKey: t2.hostKey } })).data;
	const smb = (await admin.post('/api/library/sources', smbCfg)).data;
	const dav = (await admin.post('/api/library/sources', { ...davCfg, printers: [p2.id] })).data;
	for (const s of [folder, sftp, smb, dav]) assert.ok(s.id, JSON.stringify(s));
	assert.equal(sftp.hasPassword, true);
	const managed = JSON.stringify((await admin.get('/api/library/sources?manage=1')).data);
	for (const secret of [SFTP.password, SMB.password, DAV.password]) assert.ok(!managed.includes(secret), 'passwords never reach the browser');
	const seen = (await viewer.get('/api/library/sources')).data;
	assert.equal(seen.length, 4, 'everyone can browse');
	assert.ok(seen.every((s) => !s.location && !('config' in s)), 'non-admins get no addresses');
	assert.deepEqual(seen.find((s) => s.id === dav.id).printers, [p2.id]);
	assert.equal((await viewer.get('/api/library/sources?manage=1')).status, 403);
	assert.equal((await operator.post('/api/library/sources', folderCfg)).status, 403, 'operators can’t add sources');
	assert.equal((await operator.post('/api/library/sources/test', folderCfg)).status, 403);

	// --- browsing ---------------------------------------------------------------------------
	log('browsing every source: folders, hidden clutter, metadata, thumbnails, search');
	for (const s of [folder, sftp, smb, dav]) {
		const root = (await viewer.get(`/api/library/${s.id}/list`)).data;
		const names = root.entries.map((e) => e.name);
		for (const n of ['bracket_PETG_0.15mm_MK4.gcode', 'spool-hub_PLA_Ender3.gcode', 'Functional', 'README.md']) assert.ok(names.includes(n), `${s.name}: ${n} in ${names}`);
		for (const n of ['.DS_Store', '@eaDir']) assert.ok(!names.includes(n), `${s.name}: ${n} hidden`);
		assert.equal(root.entries.find((e) => e.name === 'Functional').type, 'folder');
		const meta = (await viewer.get(`/api/library/${s.id}/meta?path=bracket_PETG_0.15mm_MK4.gcode`)).data;
		assert.equal(meta.meta.slicer, 'PrusaSlicer', `${s.name}: ${JSON.stringify(meta)}`);
		assert.equal(meta.meta.estimatedTime, 5103);
		assert.deepEqual(meta.meta.thumbnail, { width: 313, height: 173, format: 'png' });
		const orca = (await viewer.get(`/api/library/${s.id}/meta?path=cable-clip-ring_PLA_0.2mm.gcode`)).data.meta;
		assert.deepEqual(orca.thumbnail, { width: 300, height: 300, format: 'png' }, `${s.name}: large thumbnails past the first 64 KB`);
		const thumb = await viewer.get(`/api/library/${s.id}/thumbnail?path=bracket_PETG_0.15mm_MK4.gcode&v=${meta.version}`, { raw: true });
		assert.equal(thumb.status, 200);
		assert.equal(thumb.headers.get('content-type'), 'image/png');
		assert.match(thumb.headers.get('cache-control'), /immutable/);
		const cached = (await viewer.get(`/api/library/${s.id}/list`)).data.entries.find((e) => e.name === 'bracket_PETG_0.15mm_MK4.gcode');
		assert.equal(cached.meta.slicer, 'PrusaSlicer', 'the listing carries cached metadata');
		const nested = (await viewer.get(`/api/library/${s.id}/list?path=Functional`)).data.entries.map((e) => e.path).sort();
		assert.deepEqual(nested, ['Functional/Clips', 'Functional/notes.txt', 'Functional/spool-holder.gcode']);
		const found = (await viewer.get(`/api/library/${s.id}/search?q=clip`)).data;
		assert.deepEqual(
			found.results.map((r) => r.path).sort(),
			['Functional/Clips', 'Functional/Clips/cable-clip_PLA_0.2mm.gcode', 'cable-clip-ring_PLA_0.2mm.gcode'],
			`${s.name}: recursive search`
		);
		assert.equal((await viewer.get(`/api/library/${s.id}/search?q=notes`)).data.results.length, 0, 'search hides non-G-code by default');
		assert.equal((await viewer.get(`/api/library/${s.id}/search?q=notes&all=1`)).data.results.length, 1);
		assert.equal((await viewer.get(`/api/library/${s.id}/list?path=../`)).status, 400, 'no traversal');
		assert.equal((await viewer.get(`/api/library/${s.id}/meta?path=Functional/../../etc/passwd`)).status, 400);
		assert.equal((await viewer.get(`/api/library/${s.id}/meta?path=missing.gcode`)).status, 404);
	}
	const folderRoot = (await viewer.get(`/api/library/${folder.id}/list`)).data.entries.map((e) => e.name);
	assert.ok(!folderRoot.includes('escape.gcode') && !folderRoot.includes('escape-dir'), 'symlinks out of the folder are hidden');
	assert.equal((await viewer.get(`/api/library/${folder.id}/meta?path=escape.gcode`)).status, 403);
	assert.match((await viewer.get(`/api/library/${folder.id}/meta?path=escape-dir/secret.gcode`)).data.message, /escapes/);

	// --- sending ----------------------------------------------------------------------------
	log('sending: roles, printer restrictions, overwrite and busy-printer questions');
	assert.equal((await viewer.post(`/api/library/${folder.id}/send`, { path: 'spool-hub_PLA_Ender3.gcode', printerId: p1.id })).status, 403, 'viewers can’t send');
	assert.equal((await operator.post(`/api/library/${dav.id}/send`, { path: 'spool-hub_PLA_Ender3.gcode', printerId: p1.id })).status, 403, 'the WebDAV source is only for the Voron');
	assert.equal((await operator.post(`/api/library/${folder.id}/send`, { path: '../x.gcode', printerId: p1.id })).status, 400);

	const follow = async (c, id) =>
		waitFor(
			async () => {
				const s = (await c.get(`/api/library/sends/${id}`)).data;
				return s.state !== 'sending' && s.state !== 'processing' ? s : null;
			},
			'the transfer',
			{ tries: 600, every: 250 }
		);

	const first = await operator.post(`/api/library/${smb.id}/send`, { path: 'Functional/spool-holder.gcode', printerId: p1.id });
	assert.equal(first.status, 202, JSON.stringify(first.data));
	const done = await follow(operator, first.data.id);
	assert.equal(done.state, 'done', JSON.stringify(done));
	assert.equal(done.storedPath, 'spool-holder.gcode');
	assert.ok(await opFile(OP[0], 'spool-holder.gcode'), 'OctoPrint has it');
	const again = await operator.post(`/api/library/${smb.id}/send`, { path: 'Functional/spool-holder.gcode', printerId: p1.id });
	assert.equal(again.status, 409);
	assert.equal(again.data.exists, true, 'asks before replacing');
	assert.equal((await operator.post(`/api/library/${smb.id}/send`, { path: 'Functional/spool-holder.gcode', printerId: p1.id, overwrite: true })).status, 202);

	// Into a folder on OctoPrint, from WebDAV, to the Voron.
	await admin.post(`/api/printers/${p2.id}/files/folder`, { name: 'Library', parent: '' });
	const toFolder = await operator.post(`/api/library/${dav.id}/send`, { path: 'spool-hub_PLA_Ender3.gcode', printerId: p2.id, folder: 'Library' });
	assert.equal(toFolder.status, 202, JSON.stringify(toFolder.data));
	assert.equal((await follow(operator, toFolder.data.id)).storedPath, 'Library/spool-hub_PLA_Ender3.gcode');

	log('send & print, then the busy-printer confirmation');
	const sp = await operator.post(`/api/library/${sftp.id}/send`, { path: 'bracket_PETG_0.15mm_MK4.gcode', printerId: p1.id, print: true });
	assert.equal(sp.status, 202, JSON.stringify(sp.data));
	const printed = await follow(operator, sp.data.id);
	assert.equal(printed.printing, true, JSON.stringify(printed));
	await waitFor(async () => (await opState(OP[0])).startsWith('Printing'), 'printing from the library');
	const busy = await operator.post(`/api/library/${folder.id}/send`, { path: 'spool-hub_PLA_Ender3.gcode', printerId: p1.id, print: true });
	assert.equal(busy.status, 409);
	assert.equal(busy.data.confirmRequired, true, 'asks before sending without printing');
	const busyOk = await operator.post(`/api/library/${folder.id}/send`, { path: 'spool-hub_PLA_Ender3.gcode', printerId: p1.id, print: true, confirm: true });
	assert.equal(busyOk.status, 202);
	const busyDone = await follow(operator, busyOk.data.id);
	assert.equal(busyDone.printing, false, 'uploaded without starting');
	assert.equal(busyDone.print, false);
	assert.equal((await operator.post(`/api/printers/${p1.id}/job`, { command: 'cancel', confirm: true })).status, 200);
	await waitFor(async () => (await opState(OP[0])) === 'Operational', 'cancelled');

	log(`streaming ${BIG_MB} MB files from the folder, SFTP and SMB sources without buffering`);
	const rss = () => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(app.pid)]).toString().trim()) * 1024;
	for (const [src, path] of [
		[folder, 'big-folder.gcode'],
		[sftp, 'big-sftp.gcode'],
		[smb, 'big-smb.gcode']
	]) {
		const before = rss();
		let peak = before;
		const sampler = setInterval(() => (peak = Math.max(peak, rss())), 150);
		const started = Date.now();
		const r = await operator.post(`/api/library/${src.id}/send`, { path, printerId: p2.id });
		assert.equal(r.status, 202, JSON.stringify(r.data));
		let sawProgress = false;
		const s = await waitFor(
			async () => {
				const x = (await operator.get(`/api/library/sends/${r.data.id}`)).data;
				if (x.state === 'sending' && x.sent > 0 && x.sent < x.size) sawProgress = true;
				return x.state !== 'sending' && x.state !== 'processing' ? x : null;
			},
			'the big transfer',
			{ tries: 2400, every: 100 }
		);
		clearInterval(sampler);
		assert.equal(s.state, 'done', JSON.stringify(s));
		const growth = peak - before;
		log(`  ${src.name}: ${(bigSize / 1048576).toFixed(0)} MB in ${((Date.now() - started) / 1000).toFixed(1)} s, app memory grew ${(growth / 1048576).toFixed(1)} MB`);
		assert.ok(sawProgress, 'progress is reported while sending');
		assert.ok(growth < 64 * 1048576, `${src.name}: memory grew ${growth} bytes`);
		assert.equal((await opFile(OP[1], path)).size, bigSize, 'OctoPrint got the whole file');
		await opDelete(OP[1], path);
		// Metadata of the big file is read from its ends only.
		const bm = (await operator.get(`/api/library/${src.id}/meta?path=${path}`)).data.meta;
		assert.equal(bm.slicer, 'PrusaSlicer');
		assert.equal(bm.estimatedTime, 5103);
	}

	log('cancelling a transfer');
	const toCancel = await operator.post(`/api/library/${sftp.id}/send`, { path: 'big-sftp.gcode', printerId: p2.id });
	await waitFor(async () => (await operator.get(`/api/library/sends/${toCancel.data.id}`)).data.sent > 0, 'the transfer to start', { tries: 100, every: 50 });
	assert.equal((await operator.del(`/api/library/sends/${toCancel.data.id}`)).status, 200);
	assert.equal((await follow(operator, toCancel.data.id)).state, 'aborted');
	assert.equal(await opFile(OP[1], 'big-sftp.gcode'), null, 'no partial file on OctoPrint');

	log('save to library: writable sources only');
	const saved = await operator.post(`/api/printers/${p1.id}/files/library`, { path: 'spool-hub_PLA_Ender3.gcode', sourceId: folder.id, folder: 'From printers' });
	assert.equal(saved.status, 201, JSON.stringify(saved.data));
	assert.ok(existsSync(join(libDir, 'From printers', 'spool-hub_PLA_Ender3.gcode')));
	assert.equal(readFileSync(join(libDir, 'From printers', 'spool-hub_PLA_Ender3.gcode'), 'utf8'), readFileSync(join(FIXTURES, 'cura.gcode'), 'utf8'));
	assert.equal((await operator.post(`/api/printers/${p1.id}/files/library`, { path: 'spool-hub_PLA_Ender3.gcode', sourceId: folder.id, folder: 'From printers' })).status, 409, 'asks before replacing');
	assert.equal((await operator.post(`/api/printers/${p1.id}/files/library`, { path: 'spool-hub_PLA_Ender3.gcode', sourceId: sftp.id })).status, 403, "read-only source");
	assert.equal((await viewer.post(`/api/printers/${p1.id}/files/library`, { path: 'spool-hub_PLA_Ender3.gcode', sourceId: folder.id })).status, 403);

	log('audit');
	const audit = (await admin.get('/api/audit?action=library.&limit=100')).data;
	const send = audit.find((e) => e.action === 'library.send' && e.detail.includes('spool-holder'));
	assert.equal(send.userEmail, OPERATOR.email);
	assert.equal(send.printerName, 'Prusa MK4');
	assert.match(send.detail, /TrueNAS \(SMB\): Functional\/spool-holder\.gcode → Prusa MK4/);
	assert.ok(audit.some((e) => e.action === 'library.save'));
	assert.ok(audit.some((e) => e.action === 'library.source.create'));

	// --- browser ------------------------------------------------------------------------------
	log('browser: library page, send dialog, files tab picker, screenshots');
	await opDelete(OP[0], 'bracket_PETG_0.15mm_MK4.gcode');
	await opDelete(OP[0], 'spool-hub_PLA_Ender3.gcode');
	browser = await chromium.launch();
	const shot = async (page, name) => {
		await page.screenshot({ path: join(SHOTS, `${name}.png`) });
		log(`  screenshot ${name}.png`);
	};
	const newPage = async (theme) => {
		const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: theme });
		await ctx.addInitScript((t) => localStorage.setItem('ocm-theme', t), theme);
		const page = await ctx.newPage();
		const errors = [];
		page.on('pageerror', (e) => errors.push(String(e)));
		page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
		page.errors = errors;
		return page;
	};
	const signIn = async (page, who) => {
		await page.goto(`${APP}/login`);
		await page.waitForLoadState('networkidle');
		await page.fill('#email', who.email);
		await page.fill('#pw', who.password);
		await page.click('button:has-text("Sign in")');
		await page.waitForURL((u) => !u.pathname.startsWith('/login'));
	};

	const pages = [];
	for (const theme of ['dark', 'light']) {
		const suffix = theme === 'light' ? '-light' : '';
		const page = await newPage(theme);
		pages.push(page);
		await signIn(page, ADMIN);
		await page.goto(`${APP}/library?source=${folder.id}`);
		await page.waitForSelector('tr[data-entry="bracket_PETG_0.15mm_MK4.gcode"]');
		await page.waitForSelector('tr[data-entry="cable-clip-ring_PLA_0.2mm.gcode"] img');
		await page.click('tr[data-entry="cable-clip-ring_PLA_0.2mm.gcode"]');
		await page.waitForSelector('[data-testid=library-details] img');
		await sleep(600);
		await shot(page, `library${suffix}`);
		await page.click('[data-testid=library-details] button:has-text("Send & print")');
		await page.waitForSelector('dialog[open] >> text=Send to printer');
		await page.click('dialog[open] [role=radio]:has-text("Voron 2.4")');
		await sleep(500);
		await shot(page, `library-send${suffix}`);
		if (theme === 'dark') {
			// Send it (without printing) through the dialog and watch it finish.
			await page.click('dialog[open] [role=switch][aria-label="Start printing"]');
			await page.click('dialog[open] button:has-text("Send")');
			await page.waitForSelector('dialog[open]', { state: 'detached', timeout: 30_000 }).catch(() => {});
			await waitFor(async () => !!(await opFile(OP[1], 'cable-clip-ring_PLA_0.2mm.gcode')), 'the UI send');
			// Search, the sources page.
			await page.fill('input[aria-label="Search the library"]', 'clip');
			await page.waitForSelector('tr[data-entry="Functional/Clips/cable-clip_PLA_0.2mm.gcode"]');
			await page.goto(`${APP}/library/sources`);
			await page.waitForSelector('[data-source="Synology (SFTP)"]');
			await shot(page, 'library-sources');
			await page.click('[data-source="Synology (SFTP)"] button:has-text("Edit")');
			await page.waitForSelector('dialog[open] >> text=Stored securely');
			await page.click('dialog[open] button:has-text("Test")');
			await page.waitForSelector('[data-testid=source-test] >> text=Connected');
			await page.waitForSelector('[data-testid=source-test] >> text=pinned');
			await sleep(800);
			await shot(page, 'library-source-edit');
			await page.keyboard.press('Escape');
		}
	}

	// The operator's Files tab: "From library", then pick and send into the current folder.
	const op = await newPage('dark');
	pages.push(op);
	await signIn(op, OPERATOR);
	await op.goto(`${APP}/p/${p1.id}?tab=files`);
	await op.click('button:has-text("From library")');
	await op.waitForSelector('dialog[open] >> text=Print from the library');
	await op.click(`dialog[open] [role=tab]:has-text("NAS prints")`);
	await op.click('dialog[open] tr[data-entry="control-knob_PLA_0.6n.gcode"]');
	await sleep(400);
	await shot(op, 'library-picker');
	await op.click('dialog[open] button:has-text("Send")');
	await op.waitForSelector('tr[data-file="control-knob_PLA_0.6n.gcode"]', { timeout: 30_000 });
	// Save it back to the library from the row.
	await op.click('button[aria-label="Save control-knob_PLA_0.6n.gcode to library"]');
	await op.waitForSelector('dialog[open] >> text=Save to library');
	await op.fill('#save-folder', 'saved-from-ui');
	await op.click('dialog[open] button:has-text("Save")');
	await waitFor(() => existsSync(join(libDir, 'saved-from-ui', 'control-knob_PLA_0.6n.gcode')), 'the UI save');

	// A viewer browses but gets no send buttons.
	const view = await newPage('dark');
	pages.push(view);
	await signIn(view, VIEWER);
	await view.goto(`${APP}/library?source=${folder.id}`);
	await view.click('tr[data-entry="bracket_PETG_0.15mm_MK4.gcode"]');
	await view.waitForSelector('[data-testid=library-details]');
	assert.equal(await view.locator('button:has-text("Send & print")').count(), 0, 'viewers get no send buttons');

	for (const p of pages) assert.deepEqual(p.errors, [], 'no browser errors');
	log('all library e2e checks passed');
	writeFileSync(join(work, 'app.log'), appLog);
}

async function cleanup() {
	await browser?.close().catch(() => {});
	if (process.env.E2E_KEEP) {
		log(`E2E_KEEP: app still running on ${APP} (pid ${app?.pid}), files in ${work}`);
		return;
	}
	app?.kill();
	for (const c of [SFTP.name, SMB.name, DAV.name]) execFileSync('docker', ['rm', '-f', c], { stdio: 'ignore' });
	try {
		devOctoprint('down');
	} catch {}
	rmSync(work, { recursive: true, force: true });
}

try {
	await main();
	await cleanup();
	process.exit(0);
} catch (err) {
	console.error('✗ library e2e failed:', err);
	await cleanup();
	process.exit(1);
}
