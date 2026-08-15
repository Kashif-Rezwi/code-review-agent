'use client'

import Link from 'next/link'
import { Code2, GitPullRequest, Wallet } from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'

type Mode = 'code' | 'pr'

interface ReviewHeaderProps {
    mode: Mode
    isLocked: boolean
    balance?: number
    onModeSwitch: (m: Mode) => void
}

export function ReviewHeader({ mode, isLocked, balance, onModeSwitch }: ReviewHeaderProps) {
    return (
        <header className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <PageHeader
                    title="Review your code"
                    description="Paste code directly or provide a GitHub PR URL."
                />

                {balance !== undefined && (
                    <Link
                        href="/account"
                        className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/20 hover:bg-blue-500/20 transition-all duration-200 w-fit self-start sm:self-auto"
                        title="Click to recharge credits"
                    >
                        <Wallet className="w-3.5 h-3.5" />
                        <span>Wallet: {balance} credits</span>
                    </Link>
                )}
            </div>

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
                                <Code2 className="w-4 h-4" />
                                <span>Paste Code</span>
                                <span className="text-xs opacity-70 bg-white/5 px-1.5 py-0.5 rounded">5 cr</span>
                            </>
                        ) : (
                            <>
                                <GitPullRequest className="w-4 h-4" />
                                <span>GitHub PR</span>
                                <span className="text-xs opacity-70 bg-white/5 px-1.5 py-0.5 rounded">10 cr</span>
                            </>
                        )}
                    </button>
                ))}
            </div>
        </header>
    )
}

