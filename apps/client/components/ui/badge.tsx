import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
    'inline-flex items-center gap-1 font-medium border',
    {
        variants: {
            variant: {
                default:  'text-gray-400 bg-gray-900/60 border-gray-800',
                blue:     'text-blue-400/80 bg-blue-950/30 border-blue-800/40',
                green:    'text-green-400 bg-green-900/40 border-green-700/60',
                red:      'text-red-400 bg-red-900/40 border-red-700/60',
                yellow:   'text-yellow-400 bg-yellow-900/40 border-yellow-700/60',
                purple:   'text-purple-400/80 bg-purple-950/30 border-purple-800/40',
                cyan:     'text-cyan-400 bg-cyan-400/10 border-cyan-400/20',
                amber:    'text-amber-400 bg-amber-500/10 border-amber-500/20',
            },
            shape: {
                pill:   'rounded-full px-2.5 py-0.5 text-xs',
                square: 'rounded px-1.5 py-0.5 text-xs',
            },
        },
        defaultVariants: {
            variant: 'default',
            shape: 'pill',
        },
    },
)

export interface BadgeProps
    extends React.HTMLAttributes<HTMLSpanElement>,
        VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, shape, ...props }: BadgeProps) {
    return (
        <span className={cn(badgeVariants({ variant, shape }), className)} {...props} />
    )
}
