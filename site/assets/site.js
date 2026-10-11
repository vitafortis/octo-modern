// octo·modern site: theme toggle, mobile menu, code copy + tiny highlighter, screenshot lightbox,
// docs table-of-contents highlighting. No dependencies; everything degrades to plain links.
(() => {
	const root = document.documentElement;
	const KEY = 'ocm-site-theme';

	// ---- theme ----
	const metaThemes = document.querySelectorAll('meta[name="theme-color"]');
	function applyTheme(theme) {
		root.dataset.theme = theme;
		// Keep the browser chrome in step with the chosen theme, not just the OS scheme.
		metaThemes.forEach((m) => m.setAttribute('content', theme === 'dark' ? '#0d0b12' : '#fcfbfe'));
		document.querySelectorAll('[data-theme-toggle]').forEach((b) => {
			b.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
		});
	}
	applyTheme(root.dataset.theme || 'dark');
	document.querySelectorAll('[data-theme-toggle]').forEach((btn) =>
		btn.addEventListener('click', () => {
			const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
			applyTheme(next);
			try {
				localStorage.setItem(KEY, next);
			} catch {}
		})
	);

	// ---- mobile menu ----
	const menuBtn = document.querySelector('.menu-btn');
	const mobileNav = document.getElementById('mobile-nav');
	if (menuBtn && mobileNav) {
		const set = (open) => {
			menuBtn.setAttribute('aria-expanded', String(open));
			menuBtn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
			mobileNav.hidden = !open;
		};
		menuBtn.addEventListener('click', () => set(mobileNav.hidden));
		mobileNav.addEventListener('click', (e) => {
			if (e.target.closest('a')) set(false);
		});
		document.addEventListener('keydown', (e) => {
			if (e.key === 'Escape' && !mobileNav.hidden) {
				set(false);
				menuBtn.focus();
			}
		});
	}

	// ---- code blocks ----
	const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	function highlightLine(line, lang) {
		// Comments first (a # that starts the line or follows whitespace).
		const m = line.match(/(^|\s)(#.*)$/);
		const body = m ? line.slice(0, m.index + m[1].length) : line;
		const comment = m ? `<span class="tk-c">${esc(m[2])}</span>` : '';
		// Quoted strings, then bare numbers in what's left.
		let out = body
			.split(/("[^"]*"|'[^']*')/)
			.map((part, i) =>
				i % 2
					? `<span class="tk-s">${esc(part)}</span>`
					: esc(part).replace(/(?<![\w./:-])(\d+(?:\.\d+)?)(?![\w.:/-])/g, '<span class="tk-n">$1</span>')
			)
			.join('');
		if (lang === 'yaml') out = out.replace(/^(\s*-?\s*)([\w.-]+)(:)(?=\s|$)/, '$1<span class="tk-k">$2</span>$3');
		if (lang === 'sh') out = out.replace(/^(\s*)(docker|curl|mkdir|cd|open)\b/, '$1<span class="tk-k">$2</span>');
		return out + comment;
	}
	document.querySelectorAll('pre > code[data-lang]').forEach((code) => {
		const lang = code.dataset.lang;
		const text = code.textContent.replace(/^\n/, '').replace(/\s+$/, '');
		code.dataset.raw = text;
		code.innerHTML = text
			.split('\n')
			.map((l) => highlightLine(l, lang))
			.join('\n');
	});
	const copyIcon =
		'<svg class="ico i-copy" viewBox="0 0 24 24" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>' +
		'<svg class="ico i-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
	document.querySelectorAll('.code').forEach((block) => {
		const head = block.querySelector('.code-head');
		const code = block.querySelector('pre code');
		if (!head || !code) return;
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'btn btn-ghost copy-btn';
		btn.innerHTML = copyIcon + '<span>Copy</span>';
		btn.setAttribute('aria-label', 'Copy ' + (head.textContent.trim() || 'code'));
		head.appendChild(btn);
		btn.addEventListener('click', async () => {
			const text = code.dataset.raw ?? code.textContent;
			try {
				await navigator.clipboard.writeText(text);
			} catch {
				const ta = document.createElement('textarea');
				ta.value = text;
				ta.style.position = 'fixed';
				ta.style.opacity = '0';
				document.body.appendChild(ta);
				ta.select();
				document.execCommand('copy');
				ta.remove();
			}
			btn.classList.add('copied');
			btn.lastChild.textContent = 'Copied';
			clearTimeout(btn._t);
			btn._t = setTimeout(() => {
				btn.classList.remove('copied');
				btn.lastChild.textContent = 'Copy';
			}, 1600);
		});
	});

	// ---- lightbox ----
	const dialog = document.getElementById('lightbox');
	const shots = [...document.querySelectorAll('a.shot')];
	if (dialog && shots.length && typeof dialog.showModal === 'function') {
		const img = dialog.querySelector('img');
		const cap = dialog.querySelector('.lb-caption');
		const count = dialog.querySelector('.lb-count');
		let index = 0;
		const show = (i) => {
			index = (i + shots.length) % shots.length;
			const a = shots[index];
			const thumb = a.querySelector('img');
			img.src = a.getAttribute('href');
			img.alt = thumb ? thumb.alt : '';
			cap.textContent = a.dataset.caption || (thumb ? thumb.alt : '');
			count.textContent = `${index + 1} / ${shots.length}`;
			// Warm the neighbours so next/prev feel instant.
			[index + 1, index - 1].forEach((j) => {
				const n = shots[(j + shots.length) % shots.length];
				new Image().src = n.getAttribute('href');
			});
		};
		shots.forEach((a, i) =>
			a.addEventListener('click', (e) => {
				if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
				e.preventDefault();
				show(i);
				dialog.showModal();
				root.style.overflow = 'hidden';
			})
		);
		dialog.addEventListener('close', () => {
			root.style.overflow = '';
			shots[index]?.focus();
		});
		dialog.querySelector('[data-lb="close"]').addEventListener('click', () => dialog.close());
		dialog.querySelector('[data-lb="prev"]').addEventListener('click', () => show(index - 1));
		dialog.querySelector('[data-lb="next"]').addEventListener('click', () => show(index + 1));
		dialog.addEventListener('keydown', (e) => {
			if (e.key === 'ArrowLeft') show(index - 1);
			else if (e.key === 'ArrowRight') show(index + 1);
		});
		// Click on the backdrop (outside the image and controls) closes.
		dialog.querySelector('.lb-stage').addEventListener('click', (e) => {
			if (e.target === e.currentTarget) dialog.close();
		});
		// Swipe left/right on touch screens.
		let x0 = null,
			y0 = null;
		dialog.addEventListener(
			'touchstart',
			(e) => {
				if (e.touches.length !== 1) return (x0 = null);
				x0 = e.touches[0].clientX;
				y0 = e.touches[0].clientY;
			},
			{ passive: true }
		);
		dialog.addEventListener(
			'touchend',
			(e) => {
				if (x0 === null) return;
				const dx = e.changedTouches[0].clientX - x0;
				const dy = e.changedTouches[0].clientY - y0;
				if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) show(index + (dx < 0 ? 1 : -1));
				x0 = null;
			},
			{ passive: true }
		);
	}

	// ---- docs: highlight the section in view ----
	const tocLinks = [...document.querySelectorAll('.toc a[href^="#"]')];
	if (tocLinks.length && 'IntersectionObserver' in window) {
		const byId = new Map(tocLinks.map((a) => [a.getAttribute('href').slice(1), a]));
		const io = new IntersectionObserver(
			(entries) => {
				entries.forEach((en) => {
					if (!en.isIntersecting) return;
					tocLinks.forEach((a) => a.classList.remove('active'));
					byId.get(en.target.id)?.classList.add('active');
				});
			},
			{ rootMargin: '-80px 0px -70% 0px' }
		);
		byId.forEach((_, id) => {
			const el = document.getElementById(id);
			if (el) io.observe(el);
		});
		// On small screens the TOC is a disclosure; close it after a pick.
		const tocDetails = document.querySelector('.toc details');
		tocLinks.forEach((a) =>
			a.addEventListener('click', () => {
				if (tocDetails && matchMedia('(max-width: 999px)').matches) tocDetails.open = false;
			})
		);
		const wide = matchMedia('(min-width: 1000px)');
		const syncToc = () => tocDetails && (tocDetails.open = wide.matches || tocDetails.open);
		wide.addEventListener?.('change', syncToc);
		syncToc();
	}
})();
