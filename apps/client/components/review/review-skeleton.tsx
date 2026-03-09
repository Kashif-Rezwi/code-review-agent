import { Loader2 } from 'lucide-react'

// Animated loading skeleton shown while the review is streaming.
export function ReviewSkeleton() {
    return (
        <div className="rounded-xl border border-gray-700 bg-gray-900/50 p-6 space-y-4">
            <div className="flex items-center gap-3 text-blue-400 mb-2">
                <Loader2 className="w-5 h-5 animate-spin" />
                <span className="text-sm font-medium">Analyzing your code...</span>
            </div>
            <div className="space-y-3">
                <div className="h-4 bg-gray-800 rounded w-3/4 animate-pulse" />
                <div className="h-4 bg-gray-800 rounded w-full animate-pulse" />
                <div className="h-4 bg-gray-800 rounded w-5/6 animate-pulse" />
            </div>
            <div className="mt-6 space-y-3">
                <div className="h-20 bg-gray-800/50 rounded-lg border border-gray-800 animate-pulse" />
                <div className="h-20 bg-gray-800/50 rounded-lg border border-gray-800 animate-pulse" />
            </div>
        </div>
    )
}
