// @ts-check
import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

// https://astro.build/config
export default defineConfig({
	integrations: [tailwind()],
	site: 'https://oomkill.dev',
	// If using GitHub Pages without custom domain (site at username.github.io/oomkill), set base: '/oomkill/'
	base: '/',
});
