import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';

export async function GET(context: { site: string | URL | undefined }) {
	const posts = (await getCollection('blog'))
		.filter((p) => !p.data.draft)
		.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());

	return rss({
		title: 'oomkill.dev',
		description: 'Tech notes and things I learn.',
		site: context.site ?? 'https://oomkill.dev',
		items: posts.map((post) => ({
			title: post.data.title,
			description: post.data.description,
			pubDate: post.data.pubDate,
			link: `/blog/${post.slug}`,
			categories: post.data.tags,
		})),
		trailingSlash: false,
	});
}
