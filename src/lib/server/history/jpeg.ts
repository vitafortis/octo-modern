/**
 * Shrinks JPEGs in pure JS (jpeg-js): decode, box-filter downscale, re-encode. Pure.
 */
import jpeg from 'jpeg-js';

export const MAX_BYTES = 100 * 1024;

/** Box-filter downscale of RGBA pixels to `width` (keeps the aspect ratio). */
export function downscale(img: { width: number; height: number; data: Uint8Array }, width: number): { width: number; height: number; data: Uint8Array } {
	if (img.width <= width) return img;
	const scale = img.width / width;
	const height = Math.max(1, Math.round(img.height / scale));
	const out = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		const y0 = Math.floor(y * scale);
		const y1 = Math.min(img.height, Math.max(y0 + 1, Math.floor((y + 1) * scale)));
		for (let x = 0; x < width; x++) {
			const x0 = Math.floor(x * scale);
			const x1 = Math.min(img.width, Math.max(x0 + 1, Math.floor((x + 1) * scale)));
			let r = 0;
			let g = 0;
			let b = 0;
			let n = 0;
			for (let sy = y0; sy < y1; sy++) {
				let i = (sy * img.width + x0) * 4;
				for (let sx = x0; sx < x1; sx++, i += 4) {
					r += img.data[i];
					g += img.data[i + 1];
					b += img.data[i + 2];
					n++;
				}
			}
			const o = (y * width + x) * 4;
			out[o] = r / n;
			out[o + 1] = g / n;
			out[o + 2] = b / n;
			out[o + 3] = 255;
		}
	}
	return { width, height, data: out };
}

const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/**
 * A JPEG of at most `max` bytes: the input when it's small enough, else scaled to
 * 640/480/320 px wide at decreasing quality until it fits. Null if it can't be decoded.
 */
export function shrinkJpeg(input: Uint8Array, max = MAX_BYTES): Uint8Array | null {
	if (!isJpeg(input)) return null;
	if (input.length <= max) return input;
	let img: { width: number; height: number; data: Uint8Array };
	try {
		img = jpeg.decode(input, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 40, maxMemoryUsageInMB: 256 });
	} catch {
		return null;
	}
	for (const width of [640, 480, 320, 200]) {
		const small = downscale(img, width);
		for (const quality of [75, 60, 45]) {
			const out = jpeg.encode(small, quality).data;
			if (out.length <= max) return new Uint8Array(out);
		}
	}
	return null;
}
