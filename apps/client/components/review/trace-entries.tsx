'use client'

import { useEffect, useState } from 'react'
import type { ComponentPropsWithoutRef } from 'react'
import {
    CheckCircle2,
    ChevronDown,
    ChevronRight,
    Loader2,
    MessageSquareText,
    Zap,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TraceEntry } from '@/lib/use-review-stream'

import ReactMarkdown from 'react-markdown'

// ── Shared markdown renderer config ───────────────────────────────────────────
// Defined at module level so the object reference is stable across renders,
// preventing ReactMarkdown from re-reconciling its entire subtree on each update.

const MARKDOWN_COMPONENTS = {
    p:      ({ children }: ComponentPropsWithoutRef<'p'>)      => <p className="mb-2 last:mb-0">{children}</p>,
    ul:     ({ children }: ComponentPropsWithoutRef<'ul'>)     => <ul className="list-disc pl-4 mb-2 space-y-1">{children}</ul>,
    ol:     ({ children }: ComponentPropsWithoutRef<'ol'>)     => <ol className="list-decimal pl-4 mb-2 space-y-1">{children}</ol>,
    li:     ({ children }: ComponentPropsWithoutRef<'li'>)     => <li>{children}</li>,
    strong: ({ children }: ComponentPropsWithoutRef<'strong'>) => <strong className="font-semibold text-gray-200">{children}</strong>,
    code:   ({ children }: ComponentPropsWithoutRef<'code'>)   => <code className="bg-gray-800/80 px-1 py-0.5 rounded text-xs text-blue-300 font-mono">{children}</code>,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`
    return `${(ms / 1000).toFixed(1)}s`
}

export function toolBadge(tool: string): { label: string; color: string } {
    switch (tool) {
        case 'listPRFiles':
        case 'fetchGithubPR':
            return { label: 'GITHUB', color: 'text-purple-400 bg-purple-400/10 border-purple-400/20' }
        case 'fetchFileContent':
            return { label: 'READ', color: 'text-cyan-400   bg-cyan-400/10   border-cyan-400/20' }
        default:
            return { label: 'TOOL', color: 'text-gray-500   bg-gray-500/10   border-gray-500/20' }
    }
}

// ── ThinkingGroup ─────────────────────────────────────────────────────────────

export type ThinkingEntry = Extract<TraceEntry, { kind: 'thinking' }>

export function ThinkingGroup({ entries }: { entries: ThinkingEntry[] }) {
    const [expanded, setExpanded] = useState(false)

    const fullText = entries.map(e => e.text).join('')
    // Show "Read more" if the combined text is long OR there are multiple entries.
    const hasMore = fullText.length > 300 || entries.length > 1

    return (
        <div className="py-2 animate-fade-in">
            <div className="flex items-start gap-2.5">
                <MessageSquareText className="h-3.5 w-3.5 text-blue-500/60 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0 pr-4">
                    <div className={cn(
                        "text-sm text-gray-300 leading-relaxed font-sans",
                        !expanded && "line-clamp-4"
                    )}>
                        <ReactMarkdown components={MARKDOWN_COMPONENTS}>
                            {fullText}
                        </ReactMarkdown>
                    </div>

                    {hasMore && (
                        <button
                            onClick={() => setExpanded(p => !p)}
                            className="mt-1.5 text-xs font-medium text-blue-500/70 hover:text-blue-400 transition-colors flex items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500/50"
                        >
                            {expanded ? (
                                <>Show less <ChevronDown className="h-3 w-3 rotate-180" /></>
                            ) : (
                                <>Read more <ChevronDown className="h-3 w-3" /></>
                            )}
                        </button>
                    )}
                </div>
            </div>
        </div>
    )
}

// ── ToolStep ──────────────────────────────────────────────────────────────────

const DETAIL_PREVIEW_LENGTH = 140

export function ToolStep({ entry }: { entry: Extract<TraceEntry, { kind: 'tool' }> }) {
    const isRunning = entry.status === 'running'
    const badge = toolBadge(entry.tool)

    // Auto-expand while running so the user sees live detail (file path, diff stats).
    // Collapse automatically when the tool call finishes; user can re-expand at any time.
    const [expanded, setExpanded] = useState(isRunning)
    const [detailExpanded, setDetailExpanded] = useState(false)

    useEffect(() => {
        if (entry.status === 'done') setExpanded(false)
    }, [entry.status])

    const isLongDetail = (entry.detail?.length ?? 0) > DETAIL_PREVIEW_LENGTH
    const previewDetail = isLongDetail && !detailExpanded
        ? entry.detail!.slice(0, DETAIL_PREVIEW_LENGTH).trimEnd() + '…'
        : entry.detail

    return (
        <div className="py-0.5 animate-fade-in">
            <div className="flex items-center gap-2.5">
                {/* Three-state icon: spinner (running) → chevron (done+detail) → checkmark (done) */}
                {isRunning
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400 shrink-0" />
                    : entry.detail
                        ? <button
                              onClick={() => setExpanded(p => !p)}
                              className="shrink-0 text-gray-700 hover:text-gray-400 transition-colors rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500/50"
                          >
                              {expanded
                                  ? <ChevronDown className="h-3 w-3" />
                                  : <ChevronRight className="h-3 w-3" />
                              }
                          </button>
                        : <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
                }
                <span className={cn(
                    'text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded border',
                    badge.color,
                )}>
                    {badge.label}
                </span>
                <span className={cn(
                    'text-sm flex-1 min-w-0 truncate',
                    isRunning ? 'text-gray-200' : 'text-gray-400',
                )}>
                    {entry.label}
                </span>
                {entry.durationMs != null && (
                    <span className="text-xs text-gray-600 tabular-nums shrink-0">
                        {formatDuration(entry.durationMs)}
                    </span>
                )}
            </div>
            {entry.detail && expanded && (
                <div className="mt-1 ml-[52px]">
                    <p className="text-xs font-mono text-gray-600 break-all leading-relaxed whitespace-pre-wrap">
                        {previewDetail}
                    </p>
                    {isLongDetail && (
                        <button
                            onClick={() => setDetailExpanded(p => !p)}
                            className="mt-0.5 text-xs text-gray-600 hover:text-gray-400 transition-colors rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500/50"
                        >
                            {detailExpanded ? 'Show less ↑' : 'Show more ↓'}
                        </button>
                    )}
                </div>
            )}
        </div>
    )
}

// ── LinterGroup ───────────────────────────────────────────────────────────────
// Groups all runLinter trace entries under a single ESLINT header with
// individual file rows below (checkmark before the file, not before the badge).

type ToolEntry = Extract<TraceEntry, { kind: 'tool' }>

export function LinterGroup({ entries }: { entries: ToolEntry[] }) {
    const allDone = entries.every(e => e.status === 'done')
    const running = entries.filter(e => e.status === 'running').length
    const count = entries.length

    return (
        <div className="py-0.5 animate-fade-in">
            {/* ── Header row: ESLINT badge + file count ──────────────────── */}
            <div className="flex items-center gap-2.5">
                {allDone
                    ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
                    : <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400 shrink-0" />
                }
                <span className="text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded border text-yellow-400 bg-yellow-400/10 border-yellow-400/20 flex items-center gap-1">
                    <Zap className="h-2.5 w-2.5" />
                    ESLINT
                </span>
                <span className="text-sm text-gray-400">
                    {count} file{count !== 1 ? 's' : ''}
                    {!allDone && running > 0 && (
                        <span className="text-blue-400/70 ml-1.5">· {running} running</span>
                    )}
                </span>
            </div>

            {/* ── Per-file sub-rows ─────────────────────────────────────── */}
            <div className="mt-1 ml-6 space-y-0.5">
                {entries.map(entry => (
                    <div key={entry.id} className="flex items-center gap-2">
                        {entry.status === 'done'
                            ? <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />
                            : <Loader2 className="h-3 w-3 animate-spin text-blue-400 shrink-0" />
                        }
                        <span className={cn(
                            'text-xs font-mono flex-1 min-w-0 truncate',
                            entry.status === 'done' ? 'text-gray-500' : 'text-gray-300',
                        )}>
                            {entry.label}
                        </span>
                        {entry.durationMs != null && (
                            <span className="text-xs text-gray-600 tabular-nums shrink-0">
                                {formatDuration(entry.durationMs)}
                            </span>
                        )}
                    </div>
                ))}
            </div>
        </div>
    )
}
