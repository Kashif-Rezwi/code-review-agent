'use client'

import { AppErrorBoundary } from '@/components/ui/app-error-boundary'
import { useEffect } from 'react'

export default function ErrorPage({
    error,
    reset,
}: {
    error: Error & { digest?: string }
    reset: () => void
}) {
    useEffect(() => {
        // Log application crash
        console.error('Unhandled Application Exception:', error)
    }, [error])

    return (
        <main className="w-full flex-1 flex flex-col items-center justify-center p-6 bg-app-bg text-gray-100">
            <AppErrorBoundary 
                error={error} 
                reset={reset} 
                title="Page Crash Intercepted"
                message="A routing or component sequence failed unexpectedly."
            />
        </main>
    )
}
