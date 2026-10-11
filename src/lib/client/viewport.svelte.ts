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
	let frame = 0;
	const update = () => {
		cancelAnimationFrame(frame);
		frame = requestAnimationFrame(() => {
			// Only the keyboard shrinks the visual viewport by this much; pinch-zoom changes scale.
			const keyboard = vv.scale <= 1.01 && window.innerHeight - vv.height > 120;
			if (keyboard) {
				root.style.setProperty('--app-h', `${Math.round(vv.height)}px`);
				root.dataset.keyboard = '';
				// iOS scrolls the (fixed) page up to reveal the field; undo it, the app is already resized.
				if (window.scrollY) window.scrollTo(0, 0);
			} else {
				root.style.removeProperty('--app-h');
				delete root.dataset.keyboard;
			}
		});
	};
	vv.addEventListener('resize', update);
	vv.addEventListener('scroll', update);
	update();
	return () => {
		vv.removeEventListener('resize', update);
		vv.removeEventListener('scroll', update);
		cancelAnimationFrame(frame);
	};
}

/**
 * Below `md`: lists instead of tables. Chosen in script rather than with CSS so each row
 * exists once in the page (tests and screen readers see one "Delete" button, not two).
 */
export const listLayout = new MediaQuery('(max-width: 767.98px)', false);
