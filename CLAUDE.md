# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm run dev          # dev server at localhost:4321
npm run dev:clean    # clear Vite cache then start dev server
npm run build        # production build to ./dist/
npm run preview      # preview the production build locally
```

There are no tests or linters configured.

## Architecture

This is a personal engineering blog at **oomkill.dev**, built with **Astro 6** (static output), **Tailwind CSS v4** (PostCSS plugin), and **TypeScript**.

### Pages & routing

File-based Astro routing under `src/pages/`:
- `/` — home with post list
- `/blog/[slug]` — individual post pages driven by the content collection
- `/about` — about page with a CSS-animated SVG avatar
- `/rss.xml` — RSS feed

### Content layer

Blog posts live in `src/content/blog/` as Markdown files. The collection schema (`src/content.config.ts`) requires `title`, `description`, `pubDate`, and optionally `updated`, `draft`, and `tags`. Draft posts are not filtered at the build level — that logic lives in the page components.

### Layout & theming

`src/layouts/Layout.astro` is the single shared layout. It injects a blocking inline script to apply the stored `localStorage` theme class (`dark`) before paint, avoiding flash. Theme toggling is handled by `public/scripts/theme.js` (served as a static file so it survives Astro's `<ClientRouter>` view transitions).

Styling is entirely in `src/styles/global.css` using Tailwind v4's `@import 'tailwindcss'` approach plus a `@custom-variant dark` for class-based dark mode. Design tokens are CSS custom properties on `:root` and `.dark`.

### View transitions & animations

`src/scripts/site-motion.ts` hooks into Astro's `astro:before-swap` and `astro:page-load` events to run GSAP enter/exit animations on `[data-page-enter]`. It also initialises per-route modules (currently only `initAboutPage`). The pattern for adding per-page JS is: export an `init*(el)` function that returns a cleanup `() => void`, then call it from `initRouteModules()`.

### SVG Avatar (`src/components/AboutAvatar.astro`)

The about page renders a Sims-style flat SVG character with two CSS animations: a floating plumbob diamond above the head and a waving right arm. No JavaScript — the whole thing is inline SVG + `@keyframes`. Skin, shirt, and clothing colours use CSS custom properties (`--skin`, `--accent`, `--pants-fill`, `--shoes-fill`) that respond to `.dark` automatically. `prefers-reduced-motion` freezes both animations.

### Deployment

GitHub Actions workflow (`.github/workflows/`) builds and deploys to GitHub Pages on every push to `main`. The site is served at `https://oomkill.dev` with `base: '/'` in `astro.config.mjs`.
