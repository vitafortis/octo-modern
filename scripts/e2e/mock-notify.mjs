// Local stand-ins for every notification service, for tests and e2e: nothing real is
// ever contacted. One HTTP server answers like ntfy, Discord, Slack, Telegram,
// Pushover, Gotify, Matrix, Home Assistant and a generic webhook (by path prefix), and
// an SMTP server (smtp-server, with STARTTLS or implicit TLS on its built-in
// self-signed certificate) takes email.
//
//   const http = await startMockNotify(3204);  http.url, http.requests, http.find(prefix), http.close()
//   const smtp = await startMockSmtp(3205, { secure: false }); smtp.messages, smtp.close()
//
// Failure switches: a path containing /fail401 or /fail500 answers with that error
// (JSON body with a description), Telegram token 000:bad is "Unauthorized", Matrix
// token "bad" is M_UNKNOWN_TOKEN, SMTP user "octo" needs password "secret".
import { createServer } from 'node:http';
import { SMTPServer } from 'smtp-server';

const json = (res, status, body) => {
	res.writeHead(status, { 'content-type': 'application/json' });
	res.end(JSON.stringify(body));
};

async function parse(req, buf, url) {
	const type = req.headers['content-type'] ?? '';
	const out = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, raw: buf, json: null, form: null, files: {} };
	if (type.includes('application/json')) {
		try {
			out.json = JSON.parse(buf.toString('utf8'));
		} catch {}
	} else if (type.startsWith('multipart/form-data')) {
		const fd = await new Request('http://x/', { method: 'POST', headers: { 'content-type': type }, body: buf }).formData();
		out.form = {};
		for (const [k, v] of fd.entries()) {
			if (typeof v === 'string') out.form[k] = v;
			else out.files[k] = { name: v.name, type: v.type, size: v.size, data: Buffer.from(await v.arrayBuffer()) };
		}
	}
	return out;
}

export async function startMockNotify(port, host = '127.0.0.1') {
	const requests = [];
	let next = 0;
	const server = createServer((req, res) => {
		const chunks = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', async () => {
			const url = new URL(req.url, `http://${host}:${port}`);
			const r = await parse(req, Buffer.concat(chunks), url);
			requests.push(r);
			const p = url.pathname;
			if (p.includes('/fail401')) return json(res, 401, { error: 'unauthorized', description: 'Invalid token (mock)' });
			if (p.includes('/fail500')) return json(res, 500, { message: 'Internal error (mock)' });
			if (p.startsWith('/slow')) return setTimeout(() => json(res, 200, {}), 30_000);
			if (p.startsWith('/telegram/')) {
				if (p.includes('/bot000:bad/')) return json(res, 401, { ok: false, error_code: 401, description: 'Unauthorized' });
				if (r.form?.chat_id === '-404' || r.json?.chat_id === '-404') return json(res, 400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' });
				return json(res, 200, { ok: true, result: { message_id: ++next } });
			}
			if (p.startsWith('/pushover/')) {
				if (r.form?.user === 'u'.repeat(30)) return json(res, 400, { status: 0, errors: ['user identifier is not a valid user, group, or subscribed user key'] });
				return json(res, 200, { status: 1, request: `req-${++next}` });
			}
			if (p.startsWith('/matrix/')) {
				if (req.headers.authorization === 'Bearer bad') return json(res, 401, { errcode: 'M_UNKNOWN_TOKEN', error: 'Invalid access token passed.' });
				if (p.includes('/_matrix/media/v3/upload')) return json(res, 200, { content_uri: `mxc://mock/${++next}` });
				return json(res, 200, { event_id: `$e${++next}` });
			}
			if (p.startsWith('/slack/')) {
				res.writeHead(200, { 'content-type': 'text/plain' });
				return res.end('ok');
			}
			if (p.startsWith('/discord/')) return res.writeHead(204).end();
			if (p.startsWith('/gotify/')) return json(res, 200, { id: ++next });
			if (p.startsWith('/ha/')) return json(res, 200, []);
			return json(res, 200, { id: `${++next}` });
		});
	});
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, host, resolve);
	});
	return {
		url: `http://${host}:${port}`,
		requests,
		find: (prefix) => requests.filter((r) => r.path.startsWith(prefix)),
		clear: () => requests.splice(0),
		close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(() => r())))
	};
}

export async function startMockSmtp(port, { secure = false, host = '127.0.0.1' } = {}) {
	const messages = [];
	const server = new SMTPServer({
		secure,
		authOptional: true,
		// Allow AUTH on plain connections only for the "none" security test.
		allowInsecureAuth: true,
		disabledCommands: [],
		logger: false,
		onAuth(auth, _session, cb) {
			if (auth.username === 'octo' && auth.password === 'secret') return cb(null, { user: 'octo' });
			cb(Object.assign(new Error('Authentication credentials invalid (mock)'), { responseCode: 535 }));
		},
		onData(stream, session, cb) {
			const chunks = [];
			stream.on('data', (c) => chunks.push(c));
			stream.on('end', () => {
				const raw = Buffer.concat(chunks).toString('utf8');
				messages.push({ raw, from: session.envelope.mailFrom?.address, to: session.envelope.rcptTo.map((r) => r.address), secure: session.secure, user: session.user ?? null });
				cb();
			});
		}
	});
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, host, resolve);
	});
	return { port, messages, close: () => new Promise((r) => server.close(() => r())) };
}
