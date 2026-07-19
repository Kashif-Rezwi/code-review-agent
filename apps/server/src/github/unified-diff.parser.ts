import parseDiff from 'parse-diff'
import type { NormalizedPRFile } from './github.types'

const BINARY_MARKERS = ['GIT binary patch', 'Binary files ']

export interface ParsedUnifiedDiff {
    files: NormalizedPRFile[]
    warnings: string[]
}

/**
 * Convert a GitHub/Git unified diff into the same per-file shape returned by
 * GitHub's pull-files endpoint. The adapter deliberately owns status/path
 * normalization so the rest of the review pipeline is acquisition-agnostic.
 */
export function parseUnifiedDiff(input: string): ParsedUnifiedDiff {
    const parsed = parseDiff(input)
    const sections = indexFileSections(input)
    const warnings: string[] = []

    if (sections.size < parsed.length) {
        warnings.push(
            `Unified diff contained ${sections.size} uniquely indexed file sections but ${parsed.length} could be parsed.`,
        )
    }

    const files = parsed
        .map((file, index): NormalizedPRFile | null => {
            const from = normalizePath(file.from)
            const to = normalizePath(file.to)
            const filename = to ?? from
            if (!filename) {
                warnings.push(`Skipped unified-diff entry ${index + 1} because it had no usable path.`)
                return null
            }

            const section = sections.get(filename) ?? (from ? sections.get(from) : undefined) ?? ''
            const binary = BINARY_MARKERS.some((marker) => section.includes(marker))
            const renamed = !!from && !!to && from !== to
            const patch = binary ? undefined : buildPatch(file.chunks)

            return {
                filename,
                previous_filename: renamed ? from : undefined,
                previousFilename: renamed ? from : undefined,
                status: file.new ? 'added' : file.deleted ? 'removed' : renamed ? 'renamed' : 'modified',
                additions: file.additions,
                deletions: file.deletions,
                patch: patch || undefined,
                patchState: binary ? 'binary' : patch ? 'full' : 'metadata_only',
            }
        })
        .filter((file): file is NormalizedPRFile => file !== null)

    return { files, warnings }
}

function normalizePath(path?: string): string | undefined {
    if (!path || path === '/dev/null') return undefined
    return path.replace(/^(?:a|b)\//, '')
}

function buildPatch(chunks: parseDiff.Chunk[]): string {
    return chunks
        .map((chunk) => [chunk.content, ...chunk.changes.map((change) => change.content)].join('\n'))
        .join('\n')
        .trimEnd()
}

function indexFileSections(input: string): Map<string, string> {
    const starts: number[] = []
    const pattern = /^diff --git /gm
    let match: RegExpExecArray | null
    while ((match = pattern.exec(input)) !== null) starts.push(match.index)

    const sections = new Map<string, string>()
    for (const [index, start] of starts.entries()) {
        const section = input.slice(start, starts[index + 1] ?? input.length)
        const parsed = parseDiff(section)[0]
        if (!parsed) continue
        const from = normalizePath(parsed.from)
        const to = normalizePath(parsed.to)
        if (from) sections.set(from, section)
        if (to) sections.set(to, section)
    }
    return sections
}
