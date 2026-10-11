// Renders the home-screen icons in static/ from the logo (the same drawing as Logo.svelte),
// with Playwright's Chromium. Run after changing the logo:
//
//   node scripts/pwa-icons.mjs
//
//   static/icon-192.png, icon-512.png      the rounded tile on transparent ("any")
//   static/icon-maskable-512.png           full-bleed, the mark inside the safe zone (Android)
//   static/apple-touch-icon.png (180)      full-bleed square; iOS rounds the corners itself
//   static/badge-96.png                    the white mark alone on transparent: Android's status-bar
//                                          badge for push notifications (only the alpha is used)
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const STATIC = resolve(import.meta.dirname, '../static');

const DEFS = `<defs>
	<linearGradient id="f" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#6d28d9"/></linearGradient>
	<linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient>
</defs>`;
// A hotend laying down the top layer of a print.
const MARK = `<rect x="14.3" y="2.8" width="3.4" height="3.4" rx=".8" fill="#fff" fill-opacity=".7"/>
<rect x="9.5" y="5.8" width="13" height="6.4" rx="1.6" fill="#fff"/>
<path d="M12.3 12.2h7.4l-2.5 3.6h-2.4Z" fill="#fff"/>
<g stroke="#fff" stroke-width="2.4" stroke-linecap="round" fill="none"><path d="M7.6 19.6h8.4"/><path d="M7.6 23.4h16.8" stroke-opacity=".72"/><path d="M7.6 27.2h16.8" stroke-opacity=".45"/></g>`;

/** The tile as in the app: rounded corners, mark at full size. */
const tile = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${DEFS}<rect width="32" height="32" rx="9" fill="url(#f)"/><rect width="32" height="32" rx="9" fill="url(#s)"/>${MARK}</svg>`;
/** Square background, the mark scaled about the centre (`scale` < 1 leaves a margin). */
const bleed = (scale) =>
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${DEFS}<rect width="32" height="32" fill="url(#f)"/><rect width="32" height="32" fill="url(#s)"/><g transform="translate(16 16) scale(${scale}) translate(-16 -15.2)">${MARK}</g></svg>`;

/** The mark alone, white on transparent, for the notification badge. */
const badge = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><g transform="translate(16 16) scale(1.08) translate(-16 -15.2)">${MARK}</g></svg>`;

const icons = [
	{ file: 'icon-192.png', size: 192, svg: tile() },
	{ file: 'icon-512.png', size: 512, svg: tile() },
	// Android crops maskable icons to as little as the inner 80% circle.
	{ file: 'icon-maskable-512.png', size: 512, svg: bleed(0.62) },
	{ file: 'apple-touch-icon.png', size: 180, svg: bleed(0.78) },
	{ file: 'badge-96.png', size: 96, svg: badge() }
];

const browser = await chromium.launch();
try {
	for (const { file, size, svg } of icons) {
		const page = await browser.newPage({ viewport: { width: size, height: size } });
		await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
		await page.screenshot({ path: join(STATIC, file), omitBackground: true });
		await page.close();
		console.log(`• static/${file} (${size}×${size})`);
	}
} finally {
	await browser.close();
}
