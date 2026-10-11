/**
 * Client for Obico's self-hosted ML API (the `ml_api` service of obico-server), as
 * read from its source (TheSpaghettiDetective/obico-server, release branch, commit
 * 6f93896: ml_api/server.py, ml_api/auth.py, ml_api/lib/onnx.py, backend/lib/utils.py):
 *
 * - `GET /p/?img=<url>`: the server downloads the image itself (`requests.get(url)`,
 *   0.1 s connect / 5 s read timeout, up to 3 tries on connection errors and 5xx),
 *   decodes it with OpenCV and answers `200 {"detections": [[label, confidence,
 *   [xc, yc, w, h]], …]}`, boxes as centre and size in pixels of that image, every
 *   box with confidence above 0.08. The model has one label, "failure".
 *   A missing `img` is `422`; an image it couldn't fetch or decode is
 *   `400 {"detections": [], "message": "Failed to get image …"}`.
 * - `GET /hc/`: `ok` once the model has loaded (no auth).
 * - Auth: when the container has `ML_API_TOKEN` set, `/p/` needs the header
 *   `Authorization: Bearer <token>` and answers a bare `401` otherwise; without it
 *   there is no auth at all.
 *
 * There is no endpoint that accepts image bytes (POST or otherwise): `/p/` with `img`
 * is the only way in, so the image must be at a URL the container can reach. See
 * frames.ts for how octo·modern serves it.
 */
import type { Detection } from './score.ts';

export interface MlApiConfig {
	url: string;
	token: string | null;
}

export class MlApiError extends Error {
	status: number | null;
	constructor(message: string, status: number | null = null) {
		super(message);
		this.name = 'MlApiError';
		this.status = status;
	}
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

export function predictUrl(base: string, imageUrl: string): string {
	return `${trimSlash(base)}/p/?img=${encodeURIComponent(imageUrl)}`;
}

/** backend/lib/utils.py `ml_api_auth_headers`. */
export function authHeaders(token: string | null): Record<string, string> {
	return token ? { authorization: `Bearer ${token}` } : {};
}

/** The `detections` of a `/p/` answer; malformed entries are dropped. */
export function parseDetections(body: unknown): Detection[] {
	const list = body && typeof body === 'object' && Array.isArray((body as { detections?: unknown }).detections) ? (body as { detections: unknown[] }).detections : null;
	if (!list) throw new MlApiError('The ML API answered without a "detections" list');
	const out: Detection[] = [];
	for (const d of list) {
		if (!Array.isArray(d) || d.length < 3) continue;
		const [label, conf, box] = d;
		if (typeof conf !== 'number' || !Number.isFinite(conf) || !Array.isArray(box) || box.length !== 4) continue;
		const b = box.map(Number);
		if (b.some((n) => !Number.isFinite(n))) continue;
		out.push({ label: typeof label === 'string' ? label : String(label), confidence: Math.max(0, Math.min(1, conf)), box: b as Detection['box'] });
	}
	return out;
}

function networkMessage(err: unknown): string {
	const cause = (err as { cause?: { code?: string; message?: string } }).cause;
	if ((err as Error).name === 'TimeoutError') return 'timed out';
	return cause?.code ?? cause?.message ?? (err as Error).message;
}

/** Asks the ML API about the image at `imageUrl`. */
export async function predict(cfg: MlApiConfig, imageUrl: string, timeoutMs = 30_000): Promise<Detection[]> {
	let res: Response;
	try {
		res = await fetch(predictUrl(cfg.url, imageUrl), { headers: authHeaders(cfg.token), signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
	} catch (err) {
		throw new MlApiError(`Can’t reach the ML API at ${cfg.url}: ${networkMessage(err)}`);
	}
	const text = await res.text().catch(() => '');
	if (res.status === 401) throw new MlApiError('The ML API refused the token (401): set the same ML_API_TOKEN here and on the ml_api container', 401);
	let data: unknown = null;
	try {
		data = JSON.parse(text);
	} catch {}
	if (!res.ok) {
		const msg = data && typeof data === 'object' && typeof (data as { message?: unknown }).message === 'string' ? (data as { message: string }).message : text.replace(/\s+/g, ' ').trim().slice(0, 200);
		const hint = res.status === 400 ? ' (the ML container couldn’t download the frame from octo·modern: check the address it uses to reach octo·modern)' : '';
		throw new MlApiError(`The ML API answered ${res.status}${msg ? `: ${msg.slice(0, 300)}` : ''}${hint}`, res.status);
	}
	return parseDetections(data);
}

/** `GET /hc/`: true when the model is loaded. */
export async function health(url: string, timeoutMs = 5_000): Promise<{ ok: boolean; message: string }> {
	try {
		const res = await fetch(`${trimSlash(url)}/hc/`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
		const text = (await res.text()).trim();
		return res.ok && text === 'ok' ? { ok: true, message: 'Model loaded' } : { ok: false, message: `Health check answered ${res.status} ${text.slice(0, 80)}`.trim() };
	} catch (err) {
		return { ok: false, message: `Can’t reach ${url}: ${networkMessage(err)}` };
	}
}
