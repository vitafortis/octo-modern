import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorCode, httpError, OctoPrintError, toOctoPrintError } from '../src/lib/server/octoprint/errors.ts';

test('network failures get a friendly message and hint, from fetch’s nested cause', () => {
	const fetchFailed = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:80'), { code: 'ECONNREFUSED' }) });
	assert.equal(errorCode(fetchFailed), 'ECONNREFUSED');
	const e = toOctoPrintError(fetchFailed, '10.0.0.5');
	assert.equal(e.code, 'ECONNREFUSED');
	assert.match(e.message, /Connection refused \(10\.0\.0\.5\)/);
	assert.match(e.hint!, /localhost/);
	assert.match(toOctoPrintError(Object.assign(new Error('x'), { code: 'ENOTFOUND' })).hint!, /mDNS|IP/);
	assert.match(toOctoPrintError(Object.assign(new Error('x'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })).hint!, /Verify TLS/);
	const timeout = toOctoPrintError(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
	assert.equal(timeout.code, 'TIMEOUT');
	assert.equal(toOctoPrintError(new Error('fetch failed'), 'h').message, 'Could not reach h');
	const own = new OctoPrintError('x', { code: 'Y' });
	assert.equal(toOctoPrintError(own), own, 'already friendly');
});

test('HTTP statuses: OctoPrint’s own error text when useful, hints always', () => {
	const conflict = httpError(409, '/api/job', JSON.stringify({ error: 'Printer is not operational' }));
	assert.equal(conflict.message, 'Printer not ready: Printer is not operational');
	assert.equal(conflict.status, 409);
	assert.match(conflict.hint!, /not connected/);
	const forbidden = httpError(403, '/api/job', JSON.stringify({ error: "You don't have the permission to access the requested resource. It is either read-protected or not readable by the server." }));
	assert.equal(forbidden.message, 'API key rejected', 'the generic 403 text is dropped');
	assert.match(forbidden.hint!, /Application Key/);
	const proxy = httpError(502, '/api/version', '<html><body><h1>502 Bad Gateway</h1></body></html>');
	assert.equal(proxy.message, 'OctoPrint answered HTTP 502: 502 Bad Gateway');
	assert.match(httpError(404, '/api/version', '').hint!, /reverse proxy/);
	assert.deepEqual(Object.keys(conflict.toJSON()).sort(), ['code', 'hint', 'message', 'status']);
});
