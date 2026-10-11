// Renders site/og.png (1200×630 social card) and site/apple-touch-icon.png with Playwright.
// Run from the repo root after `pnpm install` (Playwright is a dev dependency):
//   node site/tools/og.mjs
// Re-run when the logo or the dashboard screenshot changes, and commit the PNGs.
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.resolve(here, '..');
const browser = await chromium.launch();
try {
	const og = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
	await og.goto(pathToFileURL(path.join(here, 'og.html')).href);
	await og.evaluate(() => document.fonts.ready);
	await og.screenshot({ path: path.join(site, 'og.png') });

	const icon = await browser.newPage({ viewport: { width: 180, height: 180 }, deviceScaleFactor: 1 });
	const logo = pathToFileURL(path.resolve(site, '../docs/logo.svg')).href;
	// iOS rounds the corners itself, so fill the square with the tile's gradient behind the logo.
	await icon.setContent(
		`<body style="margin:0;background:linear-gradient(135deg,#a78bfa,#6d28d9)"><img src="${logo}" style="display:block;width:180px;height:180px"></body>`
	);
	await icon.waitForLoadState('load');
	await icon.screenshot({ path: path.join(site, 'apple-touch-icon.png') });
	console.log('wrote site/og.png and site/apple-touch-icon.png');
} finally {
	await browser.close();
}
