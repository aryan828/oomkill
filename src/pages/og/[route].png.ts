import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import satori from 'satori';
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const fontDir = join(process.cwd(), 'src/lib');
const fontRegular = await readFile(join(fontDir, 'og-font.woff'));
const fontBold = await readFile(join(fontDir, 'og-font-bold.woff'));

interface Card {
	title: string;
	description: string;
}

const posts = await getCollection('blog');

const cards: Record<string, Card> = Object.fromEntries(
	posts
		.filter((p) => !p.data.draft)
		.map((post) => [post.id, { title: post.data.title, description: post.data.description }]),
);

// Site-wide default card for the home page, listing pages, etc.
cards['default'] = {
	title: 'oomkill.dev',
	description: 'Notes on systems, networking, Linux, and experiments I find interesting.',
};

export function getStaticPaths() {
	return Object.keys(cards).map((route) => ({ params: { route } }));
}

// Minimal helper so the satori tree reads a little more like markup.
function el(type: string, props: Record<string, unknown>) {
	return { type, props };
}

export const GET: APIRoute = async ({ params }) => {
	const card = cards[params.route ?? 'default'] ?? cards['default'];

	const svg = await satori(
		el('div', {
			style: {
				display: 'flex',
				flexDirection: 'column',
				width: '100%',
				height: '100%',
				padding: '70px',
				background: 'linear-gradient(135deg, #0a0a0a 0%, #11201d 100%)',
				borderLeft: '14px solid #2dd4bf',
				fontFamily: 'JetBrains Mono',
				color: '#ededed',
			},
			children: [
				el('div', {
					style: { display: 'flex', fontSize: 26, color: '#2dd4bf', letterSpacing: '0.05em' },
					children: 'oomkill.dev',
				}),
				el('div', {
					style: {
						display: 'flex',
						flexGrow: 1,
						flexDirection: 'column',
						justifyContent: 'center',
					},
					children: [
						el('div', {
							style: {
								display: 'flex',
								fontSize: 58,
								fontWeight: 700,
								lineHeight: 1.15,
								letterSpacing: '-0.02em',
							},
							children: card.title,
						}),
						el('div', {
							style: {
								display: 'flex',
								marginTop: 28,
								fontSize: 28,
								lineHeight: 1.4,
								color: '#a3a3a3',
							},
							children: card.description,
						}),
					],
				}),
				el('div', {
					style: { display: 'flex', fontSize: 22, color: '#737373' },
					children: 'systems · networking · linux',
				}),
			],
		}),
		{
			width: 1200,
			height: 630,
			fonts: [
				{ name: 'JetBrains Mono', data: fontRegular, weight: 400, style: 'normal' },
				{ name: 'JetBrains Mono', data: fontBold, weight: 700, style: 'normal' },
			],
		},
	);

	const png = await sharp(Buffer.from(svg)).png().toBuffer();

	return new Response(new Uint8Array(png), {
		headers: {
			'Content-Type': 'image/png',
			'Cache-Control': 'public, max-age=31536000, immutable',
		},
	});
};
