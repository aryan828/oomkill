import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const blog = defineCollection({
	loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/blog' }),
	schema: z.object({
		title: z.string(),
		description: z.string(),
		pubDate: z.coerce.date(),
		updated: z.coerce.date().optional(),
		draft: z.boolean().optional().default(false),
		tags: z.array(z.string()).optional(),
	}),
});

export const collections = {
	blog,
};
