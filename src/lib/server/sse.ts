/**
 * Server-Sent Events: a ReadableStream response that sends named JSON events,
 * keeps proxies from timing out with comment pings, and runs `cleanup` exactly once
 * when the browser goes away or the server ends the stream.
 */
export interface SseChannel {
	send(event: string, data: unknown): void;
	close(): void;
	readonly closed: boolean;
}

export function sseResponse(
	signal: AbortSignal,
	setup: (channel: SseChannel) => (() => void) | void,
	opts: { pingMs?: number; onPing?: (channel: SseChannel) => void } = {}
): Response {
	const encoder = new TextEncoder();
	let cleanup: (() => void) | void;
	let ping: ReturnType<typeof setInterval> | undefined;
	let closed = false;
	let ctrl: ReadableStreamDefaultController<Uint8Array>;

	const finish = () => {
		if (closed) return;
		closed = true;
		if (ping) clearInterval(ping);
		signal.removeEventListener('abort', finish);
		try {
			cleanup?.();
		} catch (err) {
			console.error('[octo-modern] SSE cleanup failed', err);
		}
		try {
			ctrl.close();
		} catch {}
	};

	const channel: SseChannel = {
		send(event, data) {
			if (closed) return;
			try {
				ctrl.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
			} catch {
				finish();
			}
		},
		close: finish,
		get closed() {
			return closed;
		}
	};

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			ctrl = controller;
			// Tell EventSource to retry after 3 s if the connection drops.
			controller.enqueue(encoder.encode('retry: 3000\n\n'));
			cleanup = setup(channel);
			ping = setInterval(() => {
				if (closed) return;
				try {
					ctrl.enqueue(encoder.encode(': ping\n\n'));
				} catch {
					finish();
					return;
				}
				opts.onPing?.(channel);
			}, opts.pingMs ?? 20_000);
			ping.unref?.();
			if (signal.aborted) finish();
			else signal.addEventListener('abort', finish);
		},
		cancel: finish
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-cache, no-transform',
			// nginx and friends: don't buffer the stream.
			'x-accel-buffering': 'no'
		}
	});
}
