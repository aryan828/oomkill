# oomkill.dev

Personal engineering blog at **[oomkill.dev](https://oomkill.dev)** — notes on systems, networking, Linux, and small experiments.

Built with [Astro](https://astro.build) (static output), [Tailwind CSS v4](https://tailwindcss.com), and TypeScript. Deployed to GitHub Pages.

## Commands

| Command             | Action                                          |
| :------------------ | :---------------------------------------------- |
| `npm install`       | Install dependencies                            |
| `npm run dev`       | Start the dev server at `localhost:4321`        |
| `npm run dev:clean` | Clear the Vite cache, then start the dev server |
| `npm run build`     | Build the production site to `./dist/`          |
| `npm run preview`   | Preview the production build locally            |
| `npm run check`     | Type-check the project with `astro check`       |
| `npm run format`    | Format the codebase with Prettier               |

## Project structure

```text
public/            # static assets (favicon, robots.txt, CNAME, theme script)
src/
├── components/    # Astro components (header, footer, cards, avatar, theme toggle)
├── content/blog/  # blog posts as Markdown, validated by the content collection
├── layouts/       # the single shared Layout
├── lib/           # vendored fonts used to generate OG images
├── pages/         # file-based routes (/, /blog, /blog/[slug], /about, /og, rss, 404)
├── scripts/       # GSAP view-transition + per-page motion
└── styles/        # global.css (Tailwind v4 + tokens) and blog-prose.css
```

### Writing a post

Add a Markdown file to `src/content/blog/`. Frontmatter is validated by
`src/content.config.ts`:

```yaml
---
title: My Post
description: One-line summary used in listings, meta tags, and the OG card.
pubDate: 2026-01-01
updated: 2026-01-15 # optional
draft: false # optional, defaults to false
tags: [systems, linux] # optional
---
```

Each post automatically gets a generated Open Graph image at `/og/<slug>.png`
(rendered at build time with [satori](https://github.com/vercel/satori) + sharp).

## Deployment

Every push to `main` triggers `.github/workflows/deploy.yml`, which type-checks,
builds, and deploys to GitHub Pages. The custom domain is pinned via
`public/CNAME`; DNS points `oomkill.dev` at GitHub Pages.
