'use client'

import { useState } from 'react'
import { CheckCircle2, ChevronDown, ChevronRight, GitPullRequest, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TaskItem } from '@/lib/use-review-stream'

// ── DiffStats ─────────────────────────────────────────────────────────────────
// Parses "+3 -1 · 9 diff lines" and renders compact colored additions/deletions.

function DiffStats({ detail }: { detail: string }) {
    const m = detail.match(/^\+(\d+)\s+-(\d+)/)
    if (!m) return <span className="text-xs text-gray-600 tabular-nums shrink-0">{detail}</span>
    const add = parseInt(m[1])
    const del = parseInt(m[2])
    const contextState = detail.match(/\b(full|truncated|metadata_only|binary)\b/)?.[1]
    return (
        <div className="flex items-center gap-1 shrink-0">
            {add > 0 && <span className="text-xs tabular-nums font-mono text-green-600">+{add}</span>}
            {del > 0 && <span className="text-xs tabular-nums font-mono text-red-500/70">-{del}</span>}
            {add === 0 && del === 0 && <span className="text-xs text-gray-700 font-mono">±0</span>}
            {contextState && contextState !== 'full' && (
                <span className="ml-1 rounded border border-amber-500/20 bg-amber-950/20 px-1.5 py-0.5 text-[10px] text-amber-300/70">
                    {contextState === 'metadata_only' ? 'metadata only' : contextState}
                </span>
            )}
        </div>
    )
}

// ── GithubFilesStep ───────────────────────────────────────────────────────────
// Shows the PR file-fetch step as a compact card.
// Expanded view shows files as tags instead of a per-file checkbox list.

export function GithubFilesStep({ items }: { items: TaskItem[] }) {
    const [expanded, setExpanded] = useState(false)

    const done = items.filter(i => i.status === 'done').length
    const total = items.length
    const allDone = done === total

    return (
        <div className={cn(
            'rounded-lg border transition-colors',
            allDone ? 'border-gray-800/70 bg-gray-900/20' : 'border-gray-700/50 bg-gray-900/40',
        )}>
            {/* ── Header row ────────────────────────────────────────────── */}
            <button
                onClick={() => setExpanded(p => !p)}
                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/[0.02] transition-colors rounded-lg"
            >
                {allDone
                    ? <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                    : <Loader2 className="h-4 w-4 animate-spin text-blue-400 shrink-0" />
                }
                <GitPullRequest className="h-3.5 w-3.5 text-purple-400 shrink-0" />
                <span className="text-sm font-medium text-gray-200 flex-1 truncate">
                    {allDone ? `Read ${total} changed files` : `Reading ${done}/${total} files…`}
                </span>

                {/* Progress bar while loading */}
                {!allDone && (
                    <div className="w-16 h-1 rounded-full bg-gray-800 overflow-hidden shrink-0">
                        <div
                            className="h-full bg-blue-500 rounded-full transition-all duration-200"
                            style={{ width: `${(done / total) * 100}%` }}
                        />
                    </div>
                )}

                {/* Compact file preview when collapsed and done */}
                {allDone && !expanded && (
                    <span className="text-xs text-gray-600 truncate max-w-[200px] shrink-0">
                        {items.slice(0, 3).map(i => i.label).join(', ')}
                        {total > 3 && ` +${total - 3}`}
                    </span>
                )}

                {expanded
                    ? <ChevronDown className="h-3.5 w-3.5 text-gray-600 shrink-0" />
                    : <ChevronRight className="h-3.5 w-3.5 text-gray-600 shrink-0" />
                }
            </button>

            {/* ── Expanded file list ─────────────────────────────────────── */}
            {expanded && (
                <div className="border-t border-gray-800/60">
                    {items.map(item => (
                        <div
                            key={item.id}
                            className="flex items-center gap-2.5 px-4 py-1.5 border-b border-gray-800/40 last:border-0"
                        >
                            {item.status === 'done'
                                ? <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />
                                : <span className="h-1.5 w-1.5 rounded-full border border-gray-600 shrink-0 ml-0.5" />
                            }
                            <span className={cn(
                                'text-xs font-mono flex-1 truncate',
                                item.status === 'done' ? 'text-gray-400' : 'text-gray-300 animate-pulse',
                            )}>
                                {item.label}
                            </span>
                            {item.detail && <DiffStats detail={item.detail} />}
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}
