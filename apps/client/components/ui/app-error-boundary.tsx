'use client'

import React from 'react'
import { AlertOctagon, RefreshCcw, LayoutDashboard, Terminal } from 'lucide-react'
import Link from 'next/link'

interface AppErrorBoundaryProps {
    error: Error & { digest?: string }
    reset: () => void
    title?: string
    message?: string
}

export function AppErrorBoundary({ error, reset, title = "Something went wrong!", message = "An unexpected client-side exception was encountered." }: AppErrorBoundaryProps) {
    return (
        <div className="min-h-[60vh] flex items-center justify-center p-6">
            <div className="max-w-xl w-full">
                <div className="bg-red-950/20 border border-red-900/50 rounded-xl overflow-hidden shadow-2xl backdrop-blur-sm">
                    {/* Header Banner */}
                    <div className="bg-gradient-to-r from-red-900/40 to-red-950/40 px-6 py-4 border-b border-red-900/50 flex items-center gap-3">
                        <div className="p-2 bg-red-500/10 rounded-lg">
                            <AlertOctagon className="w-6 h-6 text-red-400" />
                        </div>
                        <div>
                            <h2 className="text-lg font-semibold text-red-200">{title}</h2>
                            <p className="text-sm text-red-400/80">{message}</p>
                        </div>
                    </div>

                    {/* Developer Details */}
                    <div className="p-6 space-y-6">
                        <div className="space-y-3">
                            <div className="flex items-center gap-2 text-red-300">
                                <Terminal className="w-4 h-4" />
                                <span className="text-xs font-semibold uppercase tracking-wider">Error Details</span>
                            </div>
                            <div className="bg-black/40 border border-gray-800 rounded-lg p-4 custom-scrollbar overflow-x-auto">
                                <p className="font-mono text-sm text-red-300 font-medium whitespace-pre-wrap">
                                    {error.name}: {error.message}
                                </p>
                                {error.digest && (
                                    <p className="mt-2 text-xs font-mono text-gray-500">
                                        Digest Map: {error.digest}
                                    </p>
                                )}
                            </div>
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-3 pt-2">
                            <button
                                onClick={reset}
                                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-red-600 hover:bg-red-500 active:bg-red-700 text-white text-sm font-medium rounded-lg transition-all shadow-[0_0_15px_rgba(220,38,38,0.2)]"
                            >
                                <RefreshCcw className="w-4 h-4" />
                                Try Recovery
                            </button>
                            <Link
                                href="/"
                                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-200 text-sm font-medium rounded-lg transition-colors border border-gray-700 hover:border-gray-600"
                            >
                                <LayoutDashboard className="w-4 h-4" />
                                Return Home
                            </Link>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}
