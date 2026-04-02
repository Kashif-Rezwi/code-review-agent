'use client'

import { AppErrorBoundary } from '@/components/ui/app-error-boundary'
import { useEffect } from 'react'

export default function ReviewErrorPage({
    error,
    reset,
}: {
    error: Error & { digest?: string }
    reset: () => void
}) {
    useEffect(() => {
        console.error('Active Review Session Crash:', error)
    }, [error])

    return (
        <div className="w-full flex-1 flex flex-col items-center justify-center p-6 bg-app-bg text-gray-100">
            <AppErrorBoundary 
                error={error} 
                reset={reset} 
                title="Review Session Interrupted"
                message="A fatal error occurred in the active AI code review pipeline."
            />
        </div>
    )
}
