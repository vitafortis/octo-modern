// A fake MJPEG webcam for development and e2e tests (OctoPrint's virtual printer has no camera).
//
//   node scripts/mjpeg-source.mjs [port]        # default 5190
//
//   /?action=stream   multipart/x-mixed-replace MJPEG, ~8 fps (also /stream)
//   /?action=snapshot one JPEG (also /snapshot)
//   /stats            { active, streams, frames } — open stream connections, for leak checks
//
// Frames are rendered once at start with Playwright (an animated "print in progress"),
// then replayed, so no image library is needed. Point a printer's webcam override at
// http://<host>:<port>/?action=stream (from inside Docker: host.docker.internal).
import { createServer } from 'node:http';
import { chromium } from 'playwright';

async function renderFrames(count = 24) {
	const browser = await chromium.launch();
	const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
	await page.setContent(`<style>html,body{margin:0;background:#000}canvas{display:block}</style><canvas id="c" width="640" height="360"></canvas>`);
	const frames = [];
	for (let i = 0; i < count; i++) {
		await page.evaluate(
			([i, count]) => {
				const c = document.getElementById('c');
				const g = c.getContext('2d');
				const t = i / count;
				const grad = g.createLinearGradient(0, 0, 0, 360);
				grad.addColorStop(0, '#1d1a26');
				grad.addColorStop(1, '#0c0a12');
				g.fillStyle = grad;
				g.fillRect(0, 0, 640, 360);
				// bed
				g.fillStyle = '#2b2838';
				g.fillRect(120, 290, 400, 14);
				// printed layers
				const layers = 14;
				for (let l = 0; l < layers; l++) {
					g.fillStyle = `hsl(268, 70%, ${38 + l * 2}%)`;
					g.fillRect(250, 276 - l * 7, 140, 6);
				}
				// current layer, partly done, and the nozzle
				const x = 250 + 140 * (0.5 + 0.5 * Math.sin(t * Math.PI * 2));
				g.fillStyle = '#c4b5fd';
				g.fillRect(250, 276 - layers * 7, x - 250, 6);
				g.fillStyle = '#e5e7eb';
				g.fillRect(x - 22, 196 - layers * 7 + 40, 44, 24);
				g.beginPath();
				g.moveTo(x - 8, 220 - layers * 7 + 40);
				g.lineTo(x + 8, 220 - layers * 7 + 40);
				g.lineTo(x, 232 - layers * 7 + 40);
				g.fill();
				g.fillStyle = '#ffffff';
				g.font = '600 16px sans-serif';
				g.fillText('octo·modern test camera', 18, 30);
				g.font = '12px monospace';
				g.fillStyle = '#a1a1aa';
				g.fillText(`frame ${String(i + 1).padStart(2, '0')}/${count}`, 18, 50);
			},
			[i, count]
		);
		frames.push(await page.screenshot({ type: 'jpeg', quality: 70 }));
	}
	await browser.close();
	return frames;
}

export async function startMjpegSource({ port = 5190, host = '0.0.0.0', fps = 8 } = {}) {
	const frames = await renderFrames();
	const stats = { active: 0, streams: 0, frames: 0 };
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://x');
		const action = url.searchParams.get('action') ?? url.pathname.replace(/^\/+/, '');
		if (url.pathname === '/stats') {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify(stats));
			return;
		}
		if (action === 'snapshot') {
			const frame = frames[Math.floor(Date.now() / (1000 / fps)) % frames.length];
			res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': frame.length, 'cache-control': 'no-store' });
			res.end(frame);
			return;
		}
		if (action === 'stream') {
			const boundary = 'ocmframe';
			res.writeHead(200, { 'content-type': `multipart/x-mixed-replace;boundary=${boundary}`, 'cache-control': 'no-store', connection: 'close' });
			stats.active++;
			stats.streams++;
			let i = 0;
			let waiting = false;
			const send = () => {
				// Backpressure: skip frames while the client is behind, like a real camera.
				if (waiting) return;
				const frame = frames[i++ % frames.length];
				stats.frames++;
				const ok = res.write(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`) && res.write(frame) && res.write('\r\n');
				if (!ok) {
					waiting = true;
					res.once('drain', () => (waiting = false));
				}
			};
			send();
			const timer = setInterval(send, 1000 / fps);
			res.on('close', () => {
				clearInterval(timer);
				stats.active--;
			});
			return;
		}
		res.writeHead(404, { 'content-type': 'text/plain' });
		res.end('Try /?action=stream or /?action=snapshot');
	});
	await new Promise((resolve) => server.listen(port, host, resolve));
	return { server, stats, url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => (server.closeAllConnections(), server.close(r))) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const port = Number(process.argv[2] ?? 5190);
	const s = await startMjpegSource({ port });
	console.log(`MJPEG test camera on ${s.url}/?action=stream (snapshot: ${s.url}/?action=snapshot)`);
}
