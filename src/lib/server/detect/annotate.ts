/**
 * Draws the ML API's boxes onto the frame (pure JS, jpeg-js), like Obico's
 * backend/lib/image.py `overlay_detections`: a rectangle per detection with
 * confidence above VISUALIZATION_THRESH, boxes given as centre and size in pixels.
 * Amber below 50 % confidence, red from there.
 */
import jpeg from 'jpeg-js';
import { PARAMS, type Detection } from './score.ts';

type Rgba = { width: number; height: number; data: Uint8Array };

const AMBER = [245, 158, 11];
const RED = [239, 68, 68];

function fill(img: Rgba, x0: number, y0: number, x1: number, y1: number, c: number[]) {
	const xa = Math.max(0, Math.min(img.width, Math.round(x0)));
	const xb = Math.max(0, Math.min(img.width, Math.round(x1)));
	const ya = Math.max(0, Math.min(img.height, Math.round(y0)));
	const yb = Math.max(0, Math.min(img.height, Math.round(y1)));
	for (let y = ya; y < yb; y++) {
		for (let x = xa; x < xb; x++) {
			const i = (y * img.width + x) * 4;
			img.data[i] = c[0];
			img.data[i + 1] = c[1];
			img.data[i + 2] = c[2];
			img.data[i + 3] = 255;
		}
	}
}

/** Outlines one box in place. */
export function drawBox(img: Rgba, d: Detection, thickness: number) {
	const [xc, yc, w, h] = d.box;
	const x1 = xc - w / 2;
	const y1 = yc - h / 2;
	const x2 = xc + w / 2;
	const y2 = yc + h / 2;
	const c = d.confidence >= 0.5 ? RED : AMBER;
	const t = thickness;
	fill(img, x1, y1, x2, y1 + t, c);
	fill(img, x1, y2 - t, x2, y2, c);
	fill(img, x1, y1, x1 + t, y2, c);
	fill(img, x2 - t, y1, x2, y2, c);
	// A confidence bar along the top edge, inside the box: longer = more confident.
	fill(img, x1, y1 + t, x1 + Math.max(t, (x2 - x1) * d.confidence), y1 + t * 3, c);
}

/** The JPEG with boxes drawn, or the input unchanged if it isn't a decodable JPEG or nothing is worth drawing. */
export function annotateJpeg(input: Uint8Array, detections: Detection[], quality = 82): Uint8Array {
	const shown = detections.filter((d) => d.confidence > PARAMS.VISUALIZATION_THRESH);
	if (!shown.length) return input;
	let img: Rgba;
	try {
		img = jpeg.decode(input, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 40, maxMemoryUsageInMB: 256 });
	} catch {
		return input;
	}
	const thickness = Math.max(2, Math.round(Math.min(img.width, img.height) / 160));
	for (const d of shown) drawBox(img, d, thickness);
	return new Uint8Array(jpeg.encode(img, quality).data);
}

export const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/** Width and height from a JPEG's frame header, without decoding it. */
export function jpegSize(b: Uint8Array): { width: number; height: number } | null {
	if (!isJpeg(b)) return null;
	let i = 2;
	while (i + 9 < b.length) {
		if (b[i] !== 0xff) {
			i++;
			continue;
		}
		const marker = b[i + 1];
		if (marker === 0xff) {
			i++;
			continue;
		}
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			i += 2;
			continue;
		}
		const len = (b[i + 2] << 8) | b[i + 3];
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			const height = (b[i + 5] << 8) | b[i + 6];
			const width = (b[i + 7] << 8) | b[i + 8];
			return width && height ? { width, height } : null;
		}
		i += 2 + len;
	}
	return null;
}
