'use client'

import { Code2, GitPullRequest } from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'

type Mode = 'code' | 'pr'

interface ReviewHeaderProps {
    mode: Mode
    isLocked: boolean
    onModeSwitch: (m: Mode) => void
}

export function ReviewHeader({ mode, isLocked, onModeSwitch }: ReviewHeaderProps) {
    return (
        <header className="space-y-6">
            <PageHeader
                title="Review your code"
                description="Paste code directly or provide a GitHub PR URL."
            />

            {/* Mode tabs */}
            <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-lg p-1 w-fit">
                {(['code', 'pr'] as Mode[]).map((m) => (
                    <button
                        key={m}
                        onClick={() => !isLocked && onModeSwitch(m)}
                        disabled={isLocked}
                        className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all duration-200 ${
                            mode === m
                                ? 'bg-blue-500/15 text-blue-100 border border-blue-500/25 shadow-[0_0_10px_rgba(59,130,246,0.12)]'
                                : 'text-gray-500 hover:text-gray-300 border border-transparent'
                        } ${isLocked ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
                    >
                        {m === 'code' ? (
                            <>
                                <Code2 className="w-4 h-4" /> Paste Code
                            </>
                        ) : (
                            <>
                                <GitPullRequest className="w-4 h-4" /> GitHub PR
                            </>
                        )}
                    </button>
                ))}
            </div>
        </header>
    )
}
