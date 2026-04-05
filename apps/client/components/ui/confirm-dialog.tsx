'use client'

import { useEffect } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'

interface ConfirmDialogProps {
    title: string
    description: string
    confirmLabel?: string
    cancelLabel?: string
    isLoading?: boolean
    onConfirm: () => void
    onCancel: () => void
}

/**
 * A reusable, accessible confirmation dialog with a dark glassmorphism look.
 * Traps focus and responds to the Escape key.
 */
export function ConfirmDialog({
    title,
    description,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    isLoading = false,
    onConfirm,
    onCancel,
}: ConfirmDialogProps) {
    // Close on Escape
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !isLoading) onCancel()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [isLoading, onCancel])

    return (
        /* Scrim */
        <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            aria-modal="true"
            role="dialog"
            aria-labelledby="confirm-dialog-title"
        >
            {/* Backdrop */}
            <div
                className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150"
                onClick={!isLoading ? onCancel : undefined}
            />

            {/* Card */}
            <div className="relative z-10 w-full max-w-sm rounded-xl border border-gray-700/60 bg-gray-900/95 shadow-2xl shadow-black/50 animate-in slide-in-from-bottom-4 fade-in duration-200">

                <div className="p-6 space-y-4">
                    {/* Icon + Title */}
                    <div className="flex items-start gap-3">
                        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-500/10 border border-red-500/20">
                            <AlertTriangle className="h-4 w-4 text-red-400" />
                        </div>
                        <div className="space-y-1">
                            <h2
                                id="confirm-dialog-title"
                                className="text-sm font-semibold text-gray-100"
                            >
                                {title}
                            </h2>
                            <p className="text-xs text-gray-400 leading-relaxed">
                                {description}
                            </p>
                        </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center justify-end gap-2 pt-1">
                        <button
                            type="button"
                            onClick={onCancel}
                            disabled={isLoading}
                            className="px-4 py-2 text-sm font-medium text-gray-400 hover:text-gray-200
                                       hover:bg-gray-800/80 rounded-lg transition-all duration-150
                                       disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                        >
                            {cancelLabel}
                        </button>
                        <button
                            type="button"
                            onClick={onConfirm}
                            disabled={isLoading}
                            className="flex items-center gap-2 px-4 py-2 text-sm font-medium
                                       text-red-100 bg-red-500/15 hover:bg-red-500/25
                                       border border-red-500/25 hover:border-red-400/50
                                       rounded-lg transition-all duration-150 shadow-[0_0_15px_rgba(239,68,68,0.1)]
                                       hover:shadow-[0_0_20px_rgba(239,68,68,0.2)]
                                       disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer active:scale-95"
                        >
                            {isLoading ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : null}
                            {confirmLabel}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}
