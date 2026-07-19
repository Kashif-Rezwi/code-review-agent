import { z } from 'zod'

/** Neutral, runtime-validated representation of one file returned by GitHub. */
export const PRFileSchema = z.object({
    filename: z.string(),
    status: z.string(),
    additions: z.number(),
    deletions: z.number(),
    patch: z.string().optional(),
    previous_filename: z.string().optional(),
})

export type PRFile = z.infer<typeof PRFileSchema>
