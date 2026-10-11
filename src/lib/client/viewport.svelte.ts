import { MediaQuery } from 'svelte/reactivity';

/** Below `lg`: the slim top bar and the off-canvas drawer replace the sidebar. */
export const compactShell = new MediaQuery('(max-width: 1023.98px)', false);
/** Phones (below `sm`): sheets instead of centred dialogs, cards instead of tables. */
export const phone = new MediaQuery('(max-width: 639.98px)', false);
/** A touch screen is the main pointer: no hover, no keyboard shortcuts to advertise. */
export const touch = new MediaQuery('(pointer: coarse)', false);

/**
 * Keeps `--app-h` at the height of the part of the page the user can actually see, so the
 * app (which scrolls inside itself) ends right above the on-screen keyboard on iOS, where
 * `dvh` ignores the keyboard. Also sets `data-keyboard` on <html> while a keyboard is up,
 * so bottom bars can step aside. Returns a cleanup function.
 */
export function trackVisualViewport(): () => void {
	const vv = window.visualViewport;
	if (!vv) return () => {};
	const root = document.documentElement;
	// The tallest the page has been, per orientation: Android (interactive-widget=resizes-content)
	// shrinks the whole window for the keyboard, iOS only the visual viewport.
	const tallest = { portrait: 0, landscape: 0 };
	let frame = 0;
	const update = () => {
		cancelAnimationFrame(frame);
		frame = requestAnimationFrame(() => {
			const o = window.innerWidth > window.innerHeight ? 'landscape' : 'portrait';
			tallest[o] = Math.max(tallest[o], window.innerHeight);
			const field = document.activeElement?.matches('input, textarea, select, [contenteditable]') ?? false;
			// Pinch-zoom changes the scale, the keyboard doesn't.
			const keyboard = field && vv.scale <= 1.01 && tallest[o] - vv.height > 120;
			if (keyboard) {
				root.style.setProperty('--app-h', `${Math.round(vv.height)}px`);
				root.dataset.keyboard = '';
				// iOS scrolls the page up to reveal the field; undo it, the app is already resized.
				if (window.scrollY) window.scrollTo(0, 0);
			} else {
				root.style.removeProperty('--app-h');
				delete root.dataset.keyboard;
			}
		});
	};
	window.addEventListener('focusin', update);
	window.addEventListener('focusout', update);
	vv.addEventListener('resize', update);
	vv.addEventListener('scroll', update);
	update();
	return () => {
		vv.removeEventListener('resize', update);
		vv.removeEventListener('scroll', update);
		window.removeEventListener('focusin', update);
		window.removeEventListener('focusout', update);
		cancelAnimationFrame(frame);
	};
}

/**
 * Below `md`: lists instead of tables. Chosen in script rather than with CSS so each row
 * exists once in the page (tests and screen readers see one "Delete" button, not two).
 */
export const listLayout = new MediaQuery('(max-width: 767.98px)', false);
