'use client'

import Link from 'next/link'
import Image from 'next/image'
import { usePathname } from 'next/navigation'
import { Code2, BookOpen, History } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSession, signOut } from 'next-auth/react'
import { useState, useRef, useEffect } from 'react'
import { ServerWakeupBanner } from '@/components/ui/server-wakeup-banner'

const NAV = [
    { href: '/review',    label: 'Review',    icon: Code2    },
    { href: '/standards', label: 'Standards', icon: BookOpen },
    { href: '/history',   label: 'History',   icon: History  },
] as const

/** Shared top navigation header — identical across every page. */
export function AppHeader() {
    const pathname = usePathname()
    const { data: session } = useSession()
    const [menuOpen, setMenuOpen] = useState(false)
    const menuRef = useRef<HTMLDivElement>(null)

    // Close menu on click outside
    useEffect(() => {
        if (!menuOpen) return
        const handler = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setMenuOpen(false)
            }
        }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [menuOpen])

    return (
        <header className="sticky top-0 z-50 border-b border-gray-800 bg-app-bg/95 backdrop-blur-md">
            <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
            {/* Brand */}
            <div className="flex items-center gap-2">
                <Code2 className="w-5 h-5 text-blue-400" />
                <span className="font-semibold text-white">Code Review <span className="text-blue-400">Agent</span></span>
            </div>

            {/* Right side: nav + profile */}
            <div className="flex items-center gap-3">
                <nav className="flex items-center gap-1">
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
                </nav>

                {/* Profile menu — matches lingo-agent pattern */}
                {session?.user && (
                    <div className="relative" ref={menuRef}>
                        <button
                            id="user-menu-btn"
                            onClick={() => setMenuOpen(o => !o)}
                            className="flex items-center gap-2 group cursor-pointer"
                            aria-label="Account menu"
                        >
                            {session.user.image ? (
                                <Image
                                    src={session.user.image}
                                    alt={session.user.name ?? 'User'}
                                    width={28}
                                    height={28}
                                    className="rounded-full ring-2 ring-blue-400/50"
                                />
                            ) : (
                                <div className="w-7 h-7 rounded-full bg-blue-500/20 flex items-center justify-center text-xs text-blue-300 font-semibold ring-2 ring-blue-400/50">
                                    {session.user.name?.[0] ?? '?'}
                                </div>
                            )}
                            {/* 3-dot vertical dots icon */}
                            <svg
                                className="w-5 h-5 text-slate-500 group-hover:text-slate-300 transition-colors"
                                fill="currentColor"
                                viewBox="0 0 24 24"
                                aria-hidden
                            >
                                <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" />
                            </svg>
                        </button>

                        {menuOpen && (
                            <div className="absolute right-0 mt-2 w-56 z-20 bg-[#0f1117] border border-white/10 rounded-2xl shadow-2xl overflow-hidden shadow-black/80">
                                {session.user && (
                                    <div className="px-5 py-4 border-b border-white/5">
                                        <p className="text-sm font-semibold text-white truncate">{session.user.name}</p>
                                        <p className="text-xs text-slate-400 truncate mt-0.5">{session.user.email}</p>
                                    </div>
                                )}
                                <div className="p-1.5">
                                    <button
                                        id="signout-btn"
                                        onClick={() => signOut({ callbackUrl: '/login' })}
                                        className="w-full flex items-center gap-3 px-3.5 py-2.5 text-sm font-medium text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-xl transition-colors cursor-pointer"
                                    >
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden>
                                            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                                            <polyline points="16 17 21 12 16 7" />
                                            <line x1="21" y1="12" x2="9" y2="12" />
                                        </svg>
                                        Sign out
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>
            </div>
            <ServerWakeupBanner />
        </header>
    )
}
