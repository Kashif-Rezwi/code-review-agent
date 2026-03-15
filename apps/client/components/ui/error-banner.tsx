import { AlertTriangle } from 'lucide-react'

/** Red error card — used on every page to surface API / validation failures. */
export function ErrorBanner({ message }: { message: string }) {
    return (
        <div className="flex items-start gap-3 bg-red-950/50 border border-red-800 rounded-lg p-4 text-sm text-red-300">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            {message}
        </div>
    )
}
