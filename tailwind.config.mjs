/** @type {import('tailwindcss').Config} */
export default {
	content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
	theme: {
		extend: {
			colors: {
				accent: 'var(--color-accent)',
				surface: 'var(--color-surface)',
				muted: 'var(--color-muted)',
				background: 'var(--color-background)',
				foreground: 'var(--color-text)',
				border: 'var(--color-border)',
			},
			fontFamily: {
				display: ['var(--font-display)', 'system-ui', 'sans-serif'],
				body: ['var(--font-body)', 'system-ui', 'sans-serif'],
				mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
			},
		},
	},
	plugins: [],
};
