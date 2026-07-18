import { generateObject, type LanguageModel } from 'ai'
import { z } from 'zod'
import type { PRFile } from './tools/github.tool'

export interface ClusterPlan {
    id: string
    label: string
    focus: string
    files: PRFile[]
}

export interface ProposedCluster {
    id: string
    label: string
    focus: string
    fileNames: string[]
}

const ClusterPlanSchema = z.object({
    clusters: z.array(z.object({
        id: z.string(),
        label: z.string(),
        focus: z.string(),
        fileNames: z.array(z.string()),
    })).min(1).max(4),
})

// AI SDK 6's generateObject overloads combined with Zod 3 can exceed
// TypeScript's generic-instantiation depth in workspace type-checks. Keep the
// runtime schema validation while presenting the small result shape we consume.
const runPlanner = generateObject as unknown as (options: {
    model: LanguageModel
    schema: typeof ClusterPlanSchema
    temperature: number
    prompt: string
}) => Promise<{ object: { clusters: ProposedCluster[] } }>

export async function planClusters(files: PRFile[], model: LanguageModel): Promise<ClusterPlan[]> {
    if (files.length === 0) return []
    if (files.length <= 3) return [generalCluster(files)]

    const fileList = files
        .map((file) => `${file.filename} (+${file.additions} -${file.deletions}, status: ${file.status})`)
        .join('\n')

    try {
        const { object } = await runPlanner({
            model,
            schema: ClusterPlanSchema,
            temperature: 0,
            prompt: `You are a senior engineer planning a code review.
Group the following changed files into 2-4 review clusters by domain.
Each cluster should have a clear review focus.

Rules:
- Group related files together and keep source files with their tests/specs
- Use 2-4 non-empty clusters
- Every file must appear in exactly one cluster
- Use filenames exactly as provided
- id must be lowercase alphanumeric with hyphens only
- focus must be 1-2 sentences of specific review instructions

Changed files:
${fileList}`,
        })

        return reconcileClusterPlan(files, object.clusters)
    } catch {
        return buildDeterministicClusters(files)
    }
}

/** Enforce the exact-once coverage invariant on untrusted planner output. */
export function reconcileClusterPlan(files: PRFile[], proposed: ProposedCluster[]): ClusterPlan[] {
    if (files.length <= 3) return [generalCluster(files)]
    if (proposed.length < 2) return buildDeterministicClusters(files)

    const fileMap = new Map(files.map((file) => [file.filename, file]))
    const assigned = new Set<string>()
    const usedIds = new Set<string>()

    const clusters = proposed
        .slice(0, 4)
        .map((cluster, index): ClusterPlan => {
            const clusterFiles: PRFile[] = []
            for (const name of cluster.fileNames) {
                const file = fileMap.get(name)
                if (!file || assigned.has(name)) continue
                assigned.add(name)
                clusterFiles.push(file)
            }

            return {
                id: uniqueClusterId(cluster.id, index, usedIds),
                label: cluster.label.trim() || `Review Group ${index + 1}`,
                focus: cluster.focus.trim() || genericFocus,
                files: clusterFiles,
            }
        })
        .filter((cluster) => cluster.files.length > 0)

    if (clusters.length < 2) return buildDeterministicClusters(files)

    for (const file of files) {
        if (assigned.has(file.filename)) continue
        const destination = bestClusterFor(file, clusters)
        destination.files.push(file)
        assigned.add(file.filename)
    }

    assertExactCoverage(files, clusters)
    return clusters
}

export function buildDeterministicClusters(files: PRFile[]): ClusterPlan[] {
    if (files.length <= 3) return [generalCluster(files)]

    const targetCount = Math.min(4, Math.max(2, Math.ceil(files.length / 6)))
    const buckets: ClusterPlan[] = Array.from({ length: targetCount }, (_, index) => ({
        id: `review-group-${index + 1}`,
        label: `Review Group ${index + 1}`,
        focus: genericFocus,
        files: [],
    }))

    const sorted = [...files].sort((a, b) => fileWeight(b) - fileWeight(a) || a.filename.localeCompare(b.filename))
    const pairedBucket = new Map<string, ClusterPlan>()

    for (const file of sorted) {
        const pairKey = sourcePairKey(file.filename)
        const existingPair = pairedBucket.get(pairKey)
        // Seed every requested bucket before applying path affinity. Without
        // this guard, the first non-empty bucket wins a shared top-level path
        // score and can absorb the entire PR.
        const emptyBucket = buckets.find((bucket) => bucket.files.length === 0)
        const destination = existingPair ?? emptyBucket ?? bestClusterFor(file, buckets)
        destination.files.push(file)
        pairedBucket.set(pairKey, destination)
    }

    const nonEmpty = buckets.filter((bucket) => bucket.files.length > 0)
    assertExactCoverage(files, nonEmpty)
    return nonEmpty
}

export function assertExactCoverage(files: PRFile[], clusters: ClusterPlan[]): void {
    const expected = new Set(files.map((file) => file.filename))
    const seen = new Set<string>()

    for (const cluster of clusters) {
        if (cluster.files.length === 0) throw new Error(`Cluster ${cluster.id} is empty`)
        for (const file of cluster.files) {
            if (!expected.has(file.filename)) throw new Error(`Cluster contains unknown file: ${file.filename}`)
            if (seen.has(file.filename)) throw new Error(`File assigned more than once: ${file.filename}`)
            seen.add(file.filename)
        }
    }

    const missing = [...expected].filter((filename) => !seen.has(filename))
    if (missing.length > 0) throw new Error(`Files missing from cluster plan: ${missing.join(', ')}`)
}

const genericFocus = 'Review correctness, security, performance, maintainability, and test coverage for this group.'

function generalCluster(files: PRFile[]): ClusterPlan {
    return { id: 'general', label: 'Code Review', focus: genericFocus, files }
}

function uniqueClusterId(raw: string, index: number, used: Set<string>): string {
    const base = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `review-group-${index + 1}`
    let candidate = base
    let suffix = 2
    while (used.has(candidate)) candidate = `${base}-${suffix++}`
    used.add(candidate)
    return candidate
}

function bestClusterFor(file: PRFile, clusters: ClusterPlan[]): ClusterPlan {
    return [...clusters].sort((left, right) => {
        const prefixDifference = sharedDirectoryScore(file.filename, right.files) - sharedDirectoryScore(file.filename, left.files)
        if (prefixDifference !== 0) return prefixDifference
        return clusterWeight(left) - clusterWeight(right)
    })[0]
}

function sharedDirectoryScore(filename: string, files: PRFile[]): number {
    const directory = filename.split('/').slice(0, -1)
    return files.reduce((best, candidate) => {
        const other = candidate.filename.split('/').slice(0, -1)
        let score = 0
        while (score < directory.length && score < other.length && directory[score] === other[score]) score++
        return Math.max(best, score)
    }, 0)
}

function clusterWeight(cluster: ClusterPlan): number {
    return cluster.files.reduce((total, file) => total + fileWeight(file), 0)
}

function fileWeight(file: PRFile): number {
    return Math.max(1, file.additions + file.deletions) + Math.ceil((file.patch?.length ?? 0) / 1_000)
}

function sourcePairKey(filename: string): string {
    return filename
        .replace(/\/__(?:tests|test)__\//, '/')
        .replace(/\.(?:test|spec)(?=\.[^.]+$)/, '')
        .replace(/\.(?:tsx?|jsx?)$/, '')
}
