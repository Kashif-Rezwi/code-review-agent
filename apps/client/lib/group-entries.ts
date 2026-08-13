/**
 * Group a flat list of TraceEntry items into logical RenderGroups: consecutive `thinking`
 * entries merge into one collapsible ThinkingGroup, consecutive `runLinter` calls merge into
 * one atomic LinterGroup, and every other tool call gets its own `tool` group entry.
 */

import type { TraceEntry } from '@/lib/use-review-stream'
import type { ThinkingEntry } from '@/components/review/trace-entries'

type ToolEntry = Extract<TraceEntry, { kind: 'tool' }>

export type RenderGroup =
    | { kind: 'thinking-group'; id: string; entries: ThinkingEntry[] }
    | { kind: 'tool'; entry: ToolEntry }
    | { kind: 'linter-group'; id: string; entries: ToolEntry[] }

export function groupEntries(entries: TraceEntry[]): RenderGroup[] {
    const groups: RenderGroup[] = []
    for (const entry of entries) {
        if (entry.kind === 'thinking') {
            const last = groups.at(-1)
            if (last?.kind === 'thinking-group') {
                last.entries.push(entry as ThinkingEntry)
            } else {
                groups.push({ kind: 'thinking-group', id: `tg-${entry.id}`, entries: [entry as ThinkingEntry] })
            }
        } else if (entry.kind === 'tool') {
            const toolEntry = entry as ToolEntry
            if (toolEntry.tool === 'runLinter') {
                const last = groups.at(-1)
                if (last?.kind === 'linter-group') {
                    last.entries.push(toolEntry)
                } else {
                    groups.push({ kind: 'linter-group', id: `lg-${entry.id}`, entries: [toolEntry] })
                }
            } else {
                groups.push({ kind: 'tool', entry: toolEntry })
            }
        }
    }
    return groups
}
