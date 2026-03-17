import { Badge } from '@/components/ui/badge'

/** Small "X/10" pill badge for history list rows. Full score ring → see score-ring.tsx */
export function ScoreBadge({ score }: { score: number }) {
    const variant =
        score >= 8 ? 'green' as const :
        score >= 5 ? 'yellow' as const :
                     'red' as const
    return (
        <Badge variant={variant} className="tabular-nums font-semibold">
            {score}/10
        </Badge>
    )
}
