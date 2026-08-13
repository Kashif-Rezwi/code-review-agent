'use client'

import { AppErrorBoundary } from '@/components/ui/app-error-boundary'
import { useEffect } from 'react'

export default function GlobalError({
    error,
    reset,
}: {
    error: Error & { digest?: string }
    reset: () => void
}) {
    useEffect(() => {
        console.error('Catastrophic global layout error:', error)
    }, [error])

    return (
        <html lang="en">
            <body className="bg-app-bg text-gray-100 min-h-screen custom-scrollbar">
                <main className="w-full min-h-screen flex items-center justify-center">
                    <AppErrorBoundary 
                        error={error} 
                        reset={reset} 
                        title="Critical Application Fault"
                        message="The entire root level application failed to render."
                    />
                </main>
            </body>
        </html>
    )
}
