// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SITE = 'https://oomkill.dev';

// Build a map of blog URL -> last-modified date by reading post frontmatter.
// Used to emit accurate <lastmod> entries in the sitemap.
function blogLastmod() {
	const dir = fileURLToPath(new URL('./src/content/blog', import.meta.url));
	/** @type {Record<string, string>} */
	const map = {};
	for (const file of readdirSync(dir)) {
		if (!/\.mdx?$/.test(file)) continue;
		const raw = readFileSync(`${dir}/${file}`, 'utf8');
		const fm = raw.split(/^---\s*$/m)[1] ?? '';
		if (/^\s*draft:\s*true/m.test(fm)) continue;
		const updated = fm.match(/^\s*updated:\s*(.+)$/m)?.[1]?.trim();
		const pub = fm.match(/^\s*pubDate:\s*(.+)$/m)?.[1]?.trim();
		const date = updated || pub;
		if (!date) continue;
		const slug = file.replace(/\.mdx?$/, '');
		map[`${SITE}/blog/${slug}/`] = new Date(date).toISOString();
	}
	return map;
}

const lastmodByUrl = blogLastmod();

// https://astro.build/config
export default defineConfig({
	site: SITE,
	base: '/',
	compressHTML: true,
	integrations: [
		sitemap({
			serialize(/** @type {any} */ item) {
				const { pathname } = new URL(item.url);
				if (pathname === '/') {
					item.changefreq = 'weekly';
					item.priority = 1.0;
				} else if (pathname === '/blog/') {
					item.changefreq = 'weekly';
					item.priority = 0.9;
				} else if (pathname.startsWith('/blog/')) {
					item.changefreq = 'monthly';
					item.priority = 0.8;
					if (lastmodByUrl[item.url]) item.lastmod = lastmodByUrl[item.url];
				} else {
					item.changefreq = 'monthly';
					item.priority = 0.5;
				}
				return item;
			},
		}),
	],
	vite: {
		plugins: [tailwindcss()],
	},
	markdown: {
		shikiConfig: {
			themes: {
				light: 'github-light',
				dark: 'github-dark',
			},
			defaultColor: false,
			wrap: true,
		},
	},
});
