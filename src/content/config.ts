import { defineCollection, z } from 'astro:content';

const blog = defineCollection({
	type: 'content',
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
