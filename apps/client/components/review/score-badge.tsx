/** Small "X/10" pill badge for history list rows. Full score ring → see score-ring.tsx */
export function ScoreBadge({ score }: { score: number }) {
    const color =
        score >= 8 ? 'text-green-400 bg-green-900/40 border-green-700/60' :
        score >= 5 ? 'text-yellow-400 bg-yellow-900/40 border-yellow-700/60' :
                     'text-red-400 bg-red-900/40 border-red-700/60'
    return (
        <span className={`px-2 py-0.5 rounded-full text-xs font-semibold border tabular-nums ${color}`}>
            {score}/10
        </span>
    )
}
