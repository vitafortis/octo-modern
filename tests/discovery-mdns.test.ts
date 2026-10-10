import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { browse, collectServices, decodeMessage, encodeMessage, encodeQuery, TYPE, type ResourceRecord } from '../src/lib/server/discovery/mdns.ts';

const SERVICE = '_octoprint._tcp.local';

function octopiAnswer(instance = 'OctoPrint instance on octopi', ip = '192.168.4.57'): { answers: ResourceRecord[]; additionals: ResourceRecord[] } {
	const fqdn = `${instance}.${SERVICE}`;
	return {
		answers: [{ name: SERVICE, type: TYPE.PTR, class: 1, ttl: 4500, data: fqdn }],
		additionals: [
			{ name: fqdn, type: TYPE.SRV, class: 1 | 0x8000, ttl: 120, data: { priority: 0, weight: 0, port: 80, target: 'octopi.local' } },
			{ name: fqdn, type: TYPE.TXT, class: 1 | 0x8000, ttl: 4500, data: { path: '/', version: '1.11.8', api: '0.1', model: 'Raspberry Pi 4 Model B' } },
			{ name: 'octopi.local', type: TYPE.A, class: 1 | 0x8000, ttl: 120, data: ip }
		]
	};
}

test('a PTR query encodes as a standard DNS question with the QU bit', () => {
	const q = encodeQuery([{ name: SERVICE, type: TYPE.PTR, unicast: true }]);
	// header: id 0, flags 0, 1 question, no records
	assert.deepEqual([...q.subarray(0, 12)], [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
	// labels: 10 "_octoprint" 4 "_tcp" 5 "local" 0
	assert.equal(q[12], 10);
	assert.equal(q.toString('utf8', 13, 23), '_octoprint');
	const tail = q.subarray(q.length - 4);
	assert.equal(tail.readUInt16BE(0), 12, 'QTYPE PTR');
	assert.equal(tail.readUInt16BE(2), 0x8001, 'QCLASS IN with the unicast-response bit');
	const back = decodeMessage(q);
	assert.deepEqual(back.questions, [{ name: SERVICE, type: TYPE.PTR, unicast: true }]);
});

test('responses round-trip: PTR, SRV, TXT and A records', () => {
	const packet = encodeMessage({ id: 0, flags: 0x8400, ...octopiAnswer() });
	const m = decodeMessage(packet);
	assert.equal(m.flags & 0x8000, 0x8000);
	assert.equal(m.answers.length, 4);
	const [ptr, srv, txt, a] = m.answers;
	assert.equal(ptr.data, `OctoPrint instance on octopi.${SERVICE}`);
	assert.deepEqual(srv.data, { priority: 0, weight: 0, port: 80, target: 'octopi.local' });
	assert.equal(srv.class, 1, 'the cache-flush bit is stripped');
	assert.deepEqual(txt.data, { path: '/', version: '1.11.8', api: '0.1', model: 'Raspberry Pi 4 Model B' });
	assert.equal(a.data, '192.168.4.57');
});

test('compressed names (pointers) decode, and pointer loops are rejected', () => {
	// Hand-built: question "_octoprint._tcp.local" at offset 12, answer name = pointer to it,
	// PTR data = "octopi" + pointer to the question name.
	const name = Buffer.from([10, ...Buffer.from('_octoprint'), 4, ...Buffer.from('_tcp'), 5, ...Buffer.from('local'), 0]);
	const header = Buffer.from([0, 0, 0x84, 0, 0, 1, 0, 1, 0, 0, 0, 0]);
	const question = Buffer.concat([name, Buffer.from([0, 12, 0, 1])]);
	const rdata = Buffer.from([6, ...Buffer.from('octopi'), 0xc0, 12]);
	const answer = Buffer.concat([Buffer.from([0xc0, 12, 0, 12, 0, 1, 0, 0, 0x11, 0x94, 0, rdata.length]), rdata]);
	const m = decodeMessage(Buffer.concat([header, question, answer]));
	assert.equal(m.answers[0].name, SERVICE);
	assert.equal(m.answers[0].data, `octopi.${SERVICE}`);

	const loop = Buffer.concat([Buffer.from([0, 0, 0x84, 0, 0, 1, 0, 0, 0, 0, 0, 0]), Buffer.from([0xc0, 12, 0, 12, 0, 1])]);
	assert.throws(() => decodeMessage(loop), /loop/);
	assert.throws(() => decodeMessage(Buffer.from([0, 1, 2])), /too short/);
	assert.throws(() => decodeMessage(Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0, 3, 97])), /past the packet/);
});

test('records fold into services; goodbye packets (TTL 0) are ignored', () => {
	const m = decodeMessage(encodeMessage({ flags: 0x8400, ...octopiAnswer() }));
	const goodbye = decodeMessage(
		encodeMessage({ flags: 0x8400, answers: [{ name: SERVICE, type: TYPE.PTR, class: 1, ttl: 0, data: `gone.${SERVICE}` }] })
	);
	const services = collectServices([...m.answers, ...goodbye.answers].map((record) => ({ record, from: '192.168.4.57' })), SERVICE);
	assert.equal(services.length, 1);
	assert.deepEqual(services[0], {
		instance: 'OctoPrint instance on octopi',
		host: 'octopi.local',
		port: 80,
		addresses: ['192.168.4.57'],
		txt: { path: '/', version: '1.11.8', api: '0.1', model: 'Raspberry Pi 4 Model B' },
		from: ['192.168.4.57']
	});
});

test('browse() queries a responder and collects its answer (unicast responder on loopback)', async () => {
	const responder = createSocket('udp4');
	const seen: string[] = [];
	responder.on('message', (msg, rinfo) => {
		const q = decodeMessage(msg);
		seen.push(...q.questions.map((x) => `${x.name}/${x.type}`));
		if (q.questions.some((x) => x.name === SERVICE && x.type === TYPE.PTR)) {
			// The first answer is PTR-only, so browse() has to ask for SRV/TXT/A itself.
			const fqdn = `Ender 3.${SERVICE}`;
			responder.send(encodeMessage({ flags: 0x8400, answers: [{ name: SERVICE, type: TYPE.PTR, class: 1, ttl: 4500, data: fqdn }] }), rinfo.port, rinfo.address);
		} else {
			const a = octopiAnswer('Ender 3', '127.0.0.1');
			responder.send(encodeMessage({ flags: 0x8400, answers: a.additionals.map((r) => (r.type === TYPE.SRV ? { ...r, data: { priority: 0, weight: 0, port: 5000, target: 'ender.local' } } : r.type === TYPE.A ? { ...r, name: 'ender.local' } : r)) }), rinfo.port, rinfo.address);
		}
	});
	await new Promise<void>((r) => responder.bind(0, '127.0.0.1', () => r()));
	try {
		const { services, responders } = await browse(SERVICE, { timeoutMs: 900, target: { host: '127.0.0.1', port: responder.address().port } });
		assert.equal(responders, 1);
		assert.equal(services.length, 1);
		assert.equal(services[0].instance, 'Ender 3');
		assert.equal(services[0].port, 5000);
		assert.deepEqual(services[0].addresses, ['127.0.0.1']);
		assert.equal(services[0].txt.version, '1.11.8');
		assert.ok(seen.includes(`Ender 3.${SERVICE}/${TYPE.SRV}`), 'asked for the missing SRV record');
	} finally {
		responder.close();
	}
});
