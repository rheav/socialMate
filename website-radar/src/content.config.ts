import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

// Entries are "<lang>/<slug>" (e.g. "en/privacy"), lang in pt-br | en.
const legal = defineCollection({
  loader: glob({ pattern: "*/*.md", base: "./src/content/legal" }),
  schema: z.object({
    title: z.string(),
    description: z.string().max(160),
    updated: z.string(),
    updatedISO: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
});

export const collections = { legal };
