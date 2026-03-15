import Link from 'next/link'
import { Code2, BookOpen, History } from 'lucide-react'

const NAV = [
    { href: '/review',    label: 'Review',    icon: Code2    },
    { href: '/standards', label: 'Standards', icon: BookOpen },
    { href: '/history',   label: 'History',   icon: History  },
] as const

/** Shared top navigation header — identical across every page. */
export function AppHeader() {
    return (
        <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
                <Code2 className="w-5 h-5 text-blue-400" />
                <span className="font-semibold text-white">Code Review Agent</span>
            </div>
            <div className="flex items-center gap-4">
                {NAV.map(({ href, label, icon: Icon }) => (
                    <Link
                        key={href}
                        href={href}
                        className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors"
                    >
                        <Icon className="w-3.5 h-3.5" />
                        {label}
                    </Link>
                ))}
                <span className="text-xs text-gray-500">Week 5 — Memory</span>
            </div>
        </header>
    )
}
