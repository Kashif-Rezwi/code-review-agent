// Animated skeleton that mirrors the full history detail page layout:
// input display → score header → issues → positives.
export function ReviewSkeleton() {
    return (
        <div className="space-y-4">
            {/* Input display placeholder — PR card or code snippet */}
            <div className="rounded-lg border border-gray-800 bg-gray-900/30 p-4 space-y-3 animate-pulse">
                <div className="flex items-center gap-2">
                    <div className="h-3 w-3 rounded bg-gray-800" />
                    <div className="h-2.5 bg-gray-800 rounded w-20" />
                </div>
                <div className="h-3.5 bg-gray-700 rounded w-2/3" />
            </div>

            {/* Header card: score ring + summary lines */}
            <div className="rounded-lg border border-gray-800 bg-gray-900/40 p-4 flex items-start gap-4">
                {/* Score ring placeholder */}
                <div className="w-[60px] h-[60px] rounded-full bg-gray-800 animate-pulse shrink-0" />
                {/* Summary text lines */}
                <div className="flex-1 space-y-2.5 pt-1">
                    <div className="flex items-center gap-2">
                        <div className="h-4 bg-gray-700 rounded w-36 animate-pulse" />
                        <div className="h-5 bg-gray-800 rounded-full w-16 animate-pulse" />
                    </div>
                    <div className="h-3 bg-gray-800 rounded w-full animate-pulse" />
                    <div className="h-3 bg-gray-800 rounded w-[90%] animate-pulse" />
                    <div className="h-3 bg-gray-800 rounded w-4/5 animate-pulse" />
                </div>
            </div>

            {/* Issues section */}
            <div className="space-y-2">
                {/* "ISSUES (x)" label */}
                <div className="h-3 bg-gray-800 rounded w-24 animate-pulse mx-1" />
                {/* Issue cards */}
                {[0, 1, 2].map((i) => (
                    <div
                        key={i}
                        className="rounded-lg border border-gray-800 bg-gray-900/50 p-4 space-y-2.5 animate-pulse"
                    >
                        <div className="flex items-center gap-2">
                            <div className="h-5 w-14 bg-gray-700 rounded-full" />
                            <div className="h-5 w-12 bg-gray-800 rounded-full" />
                            <div className="h-4 bg-gray-700 rounded w-48" />
                        </div>
                        <div className="h-3 bg-gray-800 rounded w-full" />
                        <div className="h-3 bg-gray-800 rounded w-5/6" />
                        <div className="h-3 bg-gray-700/50 rounded w-2/3 mt-1" />
                    </div>
                ))}
            </div>

            {/* Positives section */}
            <div className="space-y-2">
                <div className="h-3 bg-gray-800 rounded w-20 animate-pulse mx-1" />
                <div className="rounded-lg border border-green-900/30 bg-green-950/10 p-4 space-y-2">
                    {[0, 1].map((i) => (
                        <div key={i} className="flex items-center gap-2 animate-pulse">
                            <div className="h-4 w-4 rounded-full bg-green-900/40 shrink-0" />
                            <div className="h-3 bg-gray-800 rounded w-3/4" />
                        </div>
                    ))}
                </div>
            </div>
        </div>
    )
}
