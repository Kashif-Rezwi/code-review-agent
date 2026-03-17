import { generateObject } from 'ai'
import { z } from 'zod'
import type { PRFile } from './tools/github.tool'

// ── Types ────────────────────────────────────────────────────────────────────

export interface ClusterPlan {
    id: string        // machine identifier, e.g. "security-auth"
    label: string     // human label, e.g. "Security & Auth"
    focus: string     // instruction to the worker agent
    files: PRFile[]   // actual PRFile objects (not just names)
}

// ── Schema for generateObject ─────────────────────────────────────────────

const ClusterPlanSchema = z.object({
    clusters: z.array(z.object({
        id:        z.string(),
        label:     z.string(),
        focus:     z.string(),
        fileNames: z.array(z.string()),
    })).min(1).max(4),
})

// ── Main function ─────────────────────────────────────────────────────────

/**
 * Uses a lightweight LLM call to group PR files into 2-4 domain clusters.
 * Falls back to a single "general" cluster if the LLM call fails or for
 * small PRs (≤3 files).
 *
 * @param files   The list of PRFile objects from fetchPRFiles()
 * @param openai  The createOpenAI instance from the calling service
 */
export async function planClusters(
    files: PRFile[],
    openai: ReturnType<typeof import('@ai-sdk/openai').createOpenAI>,
): Promise<ClusterPlan[]> {
    if (files.length === 0) return []

    // Skip the planning LLM call for small PRs — one cluster is sufficient
    if (files.length <= 3) {
        return [{
            id: 'general',
            label: 'Code Review',
            focus: 'Review all aspects: correctness, security, performance, and style.',
            files,
        }]
    }

    const fileList = files.map(f =>
        `${f.filename} (+${f.additions} -${f.deletions}, status: ${f.status})`
    ).join('\n')

    try {
        const { object } = await generateObject({
            model: openai('gpt-4o-mini'),
            schema: ClusterPlanSchema,
            temperature: 0,
            prompt: `You are a senior engineer planning a code review.
Group the following changed files into 2-4 review clusters by domain.
Each cluster should have a clear review focus.

Rules:
- Group related files together (auth files together, DB files together, etc.)
- Maximum 4 clusters — merge related domains if there are too many
- Minimum 1 file per cluster
- Every file must appear in exactly one cluster
- id must be lowercase alphanumeric with hyphens only (e.g. "security-auth")
- focus must be 1-2 sentences of specific review instructions for that domain

Changed files:
${fileList}`,
        })

        // Map filenames back to PRFile objects
        const fileMap = new Map(files.map(f => [f.filename, f]))

        return object.clusters.map(cluster => ({
            id: cluster.id,
            label: cluster.label,
            focus: cluster.focus,
            files: cluster.fileNames
                .map(name => fileMap.get(name))
                .filter((f): f is PRFile => f !== undefined),
        })).filter(c => c.files.length > 0)

    } catch {
        // Fallback: single cluster with all files
        return [{
            id: 'general',
            label: 'Code Review',
            focus: 'Review all aspects: correctness, security, performance, and style.',
            files,
        }]
    }
}
