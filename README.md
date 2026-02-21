# Astro Starter Kit: Minimal

```sh
npm create astro@latest -- --template minimal
```

> 🧑‍🚀 **Seasoned astronaut?** Delete this file. Have fun!

## 🚀 Project Structure

Inside of your Astro project, you'll see the following folders and files:

```text
/
├── public/
├── src/
│   └── pages/
│       └── index.astro
└── package.json
```

Astro looks for `.astro` or `.md` files in the `src/pages/` directory. Each page is exposed as a route based on its file name.

There's nothing special about `src/components/`, but that's where we like to put any Astro/React/Vue/Svelte/Preact components.

Any static assets, like images, can be placed in the `public/` directory.

## 🧞 Commands

All commands are run from the root of the project, from a terminal:

| Command                   | Action                                           |
| :------------------------ | :----------------------------------------------- |
| `npm install`             | Installs dependencies                            |
| `npm run dev`             | Starts local dev server at `localhost:4321`      |
| `npm run build`           | Build your production site to `./dist/`          |
| `npm run preview`         | Preview your build locally, before deploying     |
| `npm run astro ...`       | Run CLI commands like `astro add`, `astro check` |
| `npm run astro -- --help` | Get help using the Astro CLI                     |

## Deploy to GitHub Pages

1. **Push this repo to GitHub** (e.g. `github.com/yourusername/oomkill`).

2. **Enable Pages**: In the repo go to **Settings → Pages**. Under "Build and deployment", set **Source** to **GitHub Actions**.

3. **Deploy**: Every push to `main` will run the workflow in [.github/workflows/deploy.yml](.github/workflows/deploy.yml): it builds the site and deploys to GitHub Pages.

4. **Custom domain (oomkill.dev)**:
   - In **Settings → Pages**, set **Custom domain** to `oomkill.dev` and save.
   - In your DNS provider, add either:
     - A **CNAME** record: `oomkill.dev` → `yourusername.github.io`, or
     - **A** records for GitHub’s IPs (see [GitHub’s docs](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site)).
   - Wait for DNS to propagate; GitHub will then serve the site at https://oomkill.dev.

If you are **not** using a custom domain and the site is at `username.github.io/oomkill`, set `base: '/oomkill/'` in `astro.config.mjs` so links and assets work.

## 👀 Want to learn more?

Feel free to check [our documentation](https://docs.astro.build) or jump into our [Discord server](https://astro.build/chat).
