import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react'

const VARIANTS = {
    error:   { wrapper: 'bg-red-950/50 border-red-800 text-red-300',             Icon: XCircle     },
    success: { wrapper: 'bg-green-950/40 border-green-800 text-green-300',        Icon: CheckCircle2 },
    warning: { wrapper: 'bg-yellow-950/40 border-yellow-800/60 text-yellow-300',  Icon: AlertTriangle },
    info:    { wrapper: 'bg-blue-950/40 border-blue-800/60 text-blue-300',        Icon: Info        },
} as const

type StatusVariant = keyof typeof VARIANTS

interface StatusMessageProps {
    variant: StatusVariant
    message: string
}

export function StatusMessage({ variant, message }: StatusMessageProps) {
    const { wrapper, Icon } = VARIANTS[variant]
    return (
        <div className={`flex items-center gap-2 text-sm border rounded-lg px-4 py-3 ${wrapper}`}>
            <Icon className="w-4 h-4 shrink-0" />
            {message}
        </div>
    )
}
