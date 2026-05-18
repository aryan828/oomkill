import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';

const md = new MarkdownIt({ html: true, linkify: true, typographer: true });

function siteUrl(context: { site: string | URL | undefined }): string {
	return String(context.site ?? 'https://oomkill.dev').replace(/\/$/, '');
}

function toAbsoluteUrls(html: string, site: string): string {
	return html
		.replace(/href="\/([^"]+)"/g, `href="${site}/$1"`)
		.replace(/src="\/([^"]+)"/g, `src="${site}/$1"`);
}

function renderPostHtml(body: string, site: string): string {
	const raw = md.render(body);
	const clean = sanitizeHtml(raw, {
		allowedTags: sanitizeHtml.defaults.allowedTags.concat([
			'img',
			'h2',
			'h3',
			'h4',
			'figure',
			'figcaption',
			'table',
			'thead',
			'tbody',
			'tr',
			'th',
			'td',
		]),
		allowedAttributes: {
			...sanitizeHtml.defaults.allowedAttributes,
			a: ['href', 'name', 'target', 'rel'],
			img: ['src', 'alt', 'title', 'width', 'height'],
			td: ['colspan', 'rowspan'],
			th: ['colspan', 'rowspan'],
		},
	});
	return toAbsoluteUrls(clean, site);
}

export async function GET(context: { site: string | URL | undefined }) {
	const site = siteUrl(context);
	const posts = (await getCollection('blog'))
		.filter((p) => !p.data.draft)
		.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());

	const items = await Promise.all(
		posts.map(async (post) => {
			const link = `/blog/${post.id}`;
			const body = 'body' in post && typeof post.body === 'string' ? post.body : '';
			const content = body ? renderPostHtml(body, site) : undefined;

			return {
				title: post.data.title,
				description: post.data.description,
				pubDate: post.data.pubDate,
				link,
				categories: post.data.tags,
				author: 'Aryan Narayan',
				...(content ? { content } : {}),
			};
		}),
	);

	return rss({
		title: 'oomkill.dev',
		description:
			'Personal notes by Aryan Narayan on systems, networking, and experiments. Not affiliated with any employer.',
		site: context.site ?? site,
		items,
		trailingSlash: false,
		xmlns: {
			atom: 'http://www.w3.org/2005/Atom',
		},
		customData: `<language>en-us</language><copyright>Copyright ${new Date().getFullYear()} Aryan Narayan</copyright><atom:link href="${site}/rss.xml" rel="self" type="application/rss+xml"/>`,
	});
}
