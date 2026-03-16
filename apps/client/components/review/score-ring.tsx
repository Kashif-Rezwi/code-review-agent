// Animated SVG ring showing the overall code quality score (1-10).
export function ScoreRing({ score }: { score: number }) {
    const color = score >= 8
        ? 'var(--color-score-high)'
        : score >= 5
            ? 'var(--color-score-mid)'
            : 'var(--color-score-low)'
    const r = 28, circ = 2 * Math.PI * r
    const dash = (score / 10) * circ

    return (
        <div className="relative flex items-center justify-center w-16 h-16">
            <svg width="64" height="64" className="-rotate-90">
                <circle cx="32" cy="32" r={r} fill="none" stroke="#1f2937" strokeWidth="5" />
                <circle cx="32" cy="32" r={r} fill="none" stroke={color} strokeWidth="5"
                    strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
                    style={{ transition: 'stroke-dasharray 0.6s ease' }} />
            </svg>
            <span className="absolute text-sm font-bold text-white">{score}<span className="text-xs text-gray-400">/10</span></span>
        </div>
    )
}
