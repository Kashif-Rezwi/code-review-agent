'use client'

import Link from 'next/link'
import Image from 'next/image'
import { usePathname } from 'next/navigation'
import { Code2, BookOpen, History, Wallet, LogOut } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSession, signOut } from 'next-auth/react'
import { useState, useRef, useEffect } from 'react'
import { ServerWakeupBanner } from '@/components/ui/server-wakeup-banner'
import { useWallet } from '@/lib/use-wallet'
import { formatCredits } from '@/lib/format-credits'

const NAV = [
    { href: '/review', label: 'Review', icon: Code2 },
    { href: '/standards', label: 'Standards', icon: BookOpen },
    { href: '/history', label: 'History', icon: History },
] as const

/** Shared top navigation header — identical across every page. */
export function AppHeader() {
    const pathname = usePathname()
    const { data: session, status } = useSession()
    const token = session?.githubToken
    const { balance } = useWallet(token)
    const [menuOpen, setMenuOpen] = useState(false)
    const menuRef = useRef<HTMLDivElement>(null)
    const isSessionLoading = status === 'loading'

    // Close menu on click outside or Escape
    useEffect(() => {
        if (!menuOpen) return
        const onMouseDown = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setMenuOpen(false)
            }
        }
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setMenuOpen(false)
        }
        document.addEventListener('mousedown', onMouseDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
            document.removeEventListener('mousedown', onMouseDown)
            document.removeEventListener('keydown', onKeyDown)
        }
    }, [menuOpen])

    return (
        <>
            <header className="sticky top-0 z-50 border-b border-gray-800 bg-app-bg/95 backdrop-blur-md font-sans">
                <div className="max-w-4xl mx-auto px-6 h-16 flex items-center justify-between">
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
                                            'flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium transition-all duration-200',
                                            active
                                                ? 'bg-blue-500/10 text-blue-300 border border-blue-500/20 shadow-glow-blue-sm'
                                                : 'text-gray-500 hover:text-blue-300/80 hover:bg-blue-500/5 border border-transparent',
                                        )}
                                    >
                                        <Icon className="w-3.5 h-3.5" />
                                        {label}
                                    </Link>
                                )
                            })}
                        </nav>

                        {/* Account cluster — loading skeleton, authenticated controls, or nothing */}
                        {isSessionLoading ? (
                            <div className="flex items-center gap-3" aria-hidden>
                                {/* Credit balance skeleton — occupies the exact pill slot so nothing shifts */}
                                <div className="h-8 w-24 rounded-full bg-gray-800 animate-pulse shrink-0" />
                                {/* Profile avatar skeleton — occupies the avatar slot */}
                                <div className="h-8 w-8 rounded-full bg-gray-800 animate-pulse shrink-0" />
                            </div>
                        ) : (
                            session?.user && (
                                <div className="flex items-center gap-3 animate-in fade-in duration-200">
                                    {/* Credit Balance Pill */}
                                    <Link
                                        href="/account"
                                        className={cn(
                                            'flex items-center gap-1.5 h-8 px-3 rounded-full text-xs font-semibold border transition-all duration-200',
                                            pathname.startsWith('/account')
                                                ? 'bg-blue-500/10 text-blue-300 border-blue-500/20 shadow-glow-blue-sm'
                                                : 'bg-blue-500/10 text-blue-400 border-blue-500/20 hover:text-blue-300 hover:border-blue-400/40',
                                        )}
                                        title="Click to view wallet and recharge credits"
                                    >
                                        <Wallet className="w-3.5 h-3.5" />
                                        <span>{formatCredits(balance)} credits</span>
                                    </Link>

                                    {/* Profile menu */}
                                    <div className="relative" ref={menuRef}>
                                <button
                                    id="user-menu-btn"
                                    onClick={() => setMenuOpen(o => !o)}
                                    className="group flex items-center justify-center h-8 w-8 rounded-full cursor-pointer"
                                    aria-label="Account menu"
                                    aria-haspopup="menu"
                                    aria-expanded={menuOpen}
                                >
                                    {session.user.image ? (
                                        <Image
                                            src={session.user.image}
                                            alt={session.user.name ?? 'User'}
                                            width={28}
                                            height={28}
                                            className={cn(
                                                'rounded-full ring-2 transition-all duration-200',
                                                menuOpen
                                                    ? 'ring-blue-400 opacity-100 shadow-[0_0_12px_rgba(59,130,246,0.35)]'
                                                    : 'ring-slate-600/60 opacity-90 group-hover:ring-blue-400/70 group-hover:opacity-100',
                                            )}
                                        />
                                    ) : (
                                        <div
                                            className={cn(
                                                'w-7 h-7 rounded-full bg-blue-500/20 flex items-center justify-center text-xs text-blue-300 font-semibold ring-2 transition-all duration-200',
                                                menuOpen
                                                    ? 'ring-blue-400 opacity-100 shadow-[0_0_12px_rgba(59,130,246,0.35)]'
                                                    : 'ring-slate-600/60 opacity-90 group-hover:ring-blue-400/70 group-hover:opacity-100',
                                            )}
                                        >
                                            {session.user.name?.[0] ?? '?'}
                                        </div>
                                    )}
                                </button>

                                {menuOpen && (
                                    <div
                                        role="menu"
                                        aria-label="Account"
                                        className="absolute right-0 mt-2 w-64 z-20 bg-[#0f1117] border border-white/10 rounded-2xl shadow-2xl overflow-hidden shadow-black/80 animate-in fade-in zoom-in-95 slide-in-from-top-1 duration-150"
                                    >
                                        {session.user && (
                                            <div className="flex items-center gap-3 px-4 py-4 border-b border-white/5">
                                                {session.user.image ? (
                                                    <Image
                                                        src={session.user.image}
                                                        alt=""
                                                        width={36}
                                                        height={36}
                                                        className="rounded-full ring-2 ring-blue-400/50 shrink-0"
                                                    />
                                                ) : (
                                                    <div className="w-9 h-9 rounded-full bg-blue-500/20 flex items-center justify-center text-sm text-blue-300 font-semibold ring-2 ring-blue-400/50 shrink-0">
                                                        {session.user.name?.[0] ?? '?'}
                                                    </div>
                                                )}
                                                <div className="min-w-0">
                                                    <p className="text-sm font-semibold text-white truncate">{session.user.name}</p>
                                                    <p className="text-xs text-slate-400 truncate mt-0.5">{session.user.email}</p>
                                                </div>
                                            </div>
                                        )}
                                        <div className="p-1.5 space-y-1">
                                            <Link
                                                href="/account"
                                                onClick={() => setMenuOpen(false)}
                                                className="w-full flex items-center gap-3 px-3.5 py-2.5 text-sm font-medium text-slate-300 hover:text-white hover:bg-white/5 rounded-xl transition-colors cursor-pointer"
                                            >
                                                <Wallet className="w-4 h-4 text-blue-400" />
                                                Account & Credits
                                            </Link>
                                            <button
                                                id="signout-btn"
                                                onClick={() => signOut({ callbackUrl: '/login' })}
                                                className="w-full flex items-center gap-3 px-3.5 py-2.5 text-sm font-medium text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-xl transition-colors cursor-pointer"
                                            >
                                                <LogOut className="w-4 h-4" aria-hidden />
                                                Sign out
                                            </button>
                                        </div>
                                    </div>
                                )}
                                </div>
                                </div>
                            )
                        )}
                    </div>
                </div>
            </header>
            <ServerWakeupBanner />
        </>
    )
}

