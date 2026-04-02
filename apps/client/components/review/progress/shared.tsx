import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export const AgentIcon = ({ className = '' }: { className?: string }) => (
    <Loader2 className={cn('shrink-0 animate-spin text-blue-400', className)} />
)

export function PipelineStepLabel({ children }: { children: React.ReactNode }) {
    return (
        <p className="text-xs font-semibold uppercase tracking-widest text-gray-700 mb-1.5 px-0.5">
            {children}
        </p>
    )
}
