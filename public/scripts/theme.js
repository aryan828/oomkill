(function () {
	const STORAGE_KEY = 'theme';

	function resolveTheme() {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored === 'light' || stored === 'dark') return stored;
		return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
	}

	function getTheme() {
		return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
	}

	function applyTheme(theme) {
		const isDark = theme === 'dark';
		document.documentElement.classList.toggle('dark', isDark);
		localStorage.setItem(STORAGE_KEY, theme);
		const meta = document.querySelector('meta[name="theme-color"]');
		if (meta) meta.setAttribute('content', isDark ? '#0a0a0a' : '#fafafa');
		updateToggleButtons();
	}

	function syncTheme() {
		applyTheme(resolveTheme());
	}

	function updateToggleButtons() {
		const isDark = getTheme() === 'dark';
		document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
			btn.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
			btn.setAttribute('aria-pressed', String(isDark));
		});
	}

	document.addEventListener('click', (event) => {
		const target = event.target;
		if (!(target instanceof Element)) return;
		const button = target.closest('[data-theme-toggle]');
		if (!button) return;
		event.preventDefault();
		applyTheme(getTheme() === 'dark' ? 'light' : 'dark');
	});

	// Keep theme across Astro client navigations (ClientRouter / view transitions).
	document.addEventListener('astro:before-swap', (event) => {
		const theme = resolveTheme();
		event.newDocument.documentElement.classList.toggle('dark', theme === 'dark');
	});

	document.addEventListener('astro:page-load', () => {
		syncTheme();
	});

	updateToggleButtons();
})();
