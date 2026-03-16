'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Code2, BookOpen, History } from 'lucide-react'
import { cn } from '@/lib/utils'

const NAV = [
    { href: '/review',    label: 'Review',    icon: Code2    },
    { href: '/standards', label: 'Standards', icon: BookOpen },
    { href: '/history',   label: 'History',   icon: History  },
] as const

/** Shared top navigation header — identical across every page. */
export function AppHeader() {
    const pathname = usePathname()

    return (
        <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
                <Code2 className="w-5 h-5 text-blue-400" />
                <span className="font-semibold text-white">Code Review Agent</span>
            </div>
            <div className="flex items-center gap-1">
                {NAV.map(({ href, label, icon: Icon }) => {
                    const active = pathname.startsWith(href)
                    return (
                        <Link
                            key={href}
                            href={href}
                            className={cn(
                                'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-200',
                                active
                                    ? 'bg-blue-500/10 text-blue-300 border border-blue-500/20 shadow-[0_0_10px_rgba(59,130,246,0.1)]'
                                    : 'text-gray-500 hover:text-blue-300/80 hover:bg-blue-500/5 border border-transparent',
                            )}
                        >
                            <Icon className="w-3.5 h-3.5" />
                            {label}
                        </Link>
                    )
                })}
                <span className="text-xs text-gray-700 ml-3 pl-3 border-l border-gray-800">
                    Week 6 — Clustered PR Review
                </span>
            </div>
        </header>
    )
}
