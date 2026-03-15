'use client'

import { useState } from 'react'
import { CheckCircle2, ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TaskItem } from '@/lib/use-review-stream'
import { toolBadge } from './trace-entries'

// ── GithubFilesStep ───────────────────────────────────────────────────────────
// Renders the pre-fetched file list as a single GITHUB-badged step,
// matching the visual style of the original "Found N changed files" tool row.

const FILE_PREVIEW_COUNT = 3
const FILE_EXPANDED_LIMIT = 30

export function GithubFilesStep({ items }: { items: TaskItem[] }) {
    const [expanded, setExpanded] = useState(false)
    const [showAllFiles, setShowAllFiles] = useState(false)

    const done = items.filter(i => i.status === 'done').length
    const total = items.length
    const allDone = done === total

    // Build preview string: "errors.json, constants.ts (+13 more)"
    const previewNames = items.slice(0, FILE_PREVIEW_COUNT).map(i => i.label).join(', ')
    const extraCount = total - FILE_PREVIEW_COUNT
    const previewStr = extraCount > 0 ? `${previewNames} (+${extraCount} more)` : previewNames

    const visibleItems = showAllFiles ? items : items.slice(0, FILE_EXPANDED_LIMIT)
    const hiddenCount = items.length - FILE_EXPANDED_LIMIT

    const badge = toolBadge('listPRFiles')

    return (
        <div className="py-0.5 animate-fade-in">
            {/* Row header — same layout as ToolStep */}
            <div className="flex items-center gap-2.5">
                <button
                    onClick={() => setExpanded(p => !p)}
                    className="shrink-0 text-gray-700 hover:text-gray-400 transition-colors"
                >
                    {expanded
                        ? <ChevronDown className="h-3 w-3" />
                        : <ChevronRight className="h-3 w-3" />
                    }
                </button>
                {allDone
                    ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
                    : <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400 shrink-0" />
                }
                {/* GITHUB badge — sourced from toolBadge() for consistency */}
                <span className={cn(
                    'text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded border',
                    badge.color,
                )}>
                    {badge.label}
                </span>
                <span className={cn(
                    'text-sm flex-1 min-w-0 truncate',
                    allDone ? 'text-gray-400' : 'text-gray-200',
                )}>
                    {allDone
                        ? `Found ${total} changed files`
                        : `Fetching ${total} files…`}
                </span>
                <span className="text-[11px] text-gray-600 tabular-nums shrink-0">
                    {done}/{total}
                </span>
            </div>

            {/* Preview subtitle — always visible (like tool detail line) */}
            {!expanded && (
                <p className="mt-0.5 ml-[52px] text-[11px] text-gray-600 font-mono truncate">
                    {previewStr}
                </p>
            )}

            {/* Expanded file list */}
            {expanded && (
                <div className="mt-1 ml-[52px] space-y-0">
                    {visibleItems.map(item => (
                        <div key={item.id} className="flex items-center gap-2 py-0.5 animate-fade-in">
                            {item.status === 'done'
                                ? <CheckCircle2 className="h-2.5 w-2.5 text-green-500 shrink-0" />
                                : <span className="h-2 w-2 rounded-full border border-gray-700 shrink-0" />
                            }
                            <span className={cn(
                                'text-[11px] font-mono flex-1 min-w-0 truncate',
                                item.status === 'done' ? 'text-gray-500' : 'text-gray-300',
                            )}>
                                {item.label}
                            </span>
                            {item.detail && (
                                <span className="text-[10px] text-gray-700 tabular-nums shrink-0">{item.detail}</span>
                            )}
                        </div>
                    ))}
                    {hiddenCount > 0 && (
                        <button
                            onClick={() => setShowAllFiles(p => !p)}
                            className="mt-1 text-[10px] text-gray-600 hover:text-gray-400 transition-colors"
                        >
                            {showAllFiles ? 'Show less ↑' : `Show ${hiddenCount} more ↓`}
                        </button>
                    )}
                </div>
            )}
        </div>
    )
}
