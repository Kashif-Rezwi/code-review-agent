interface PrUrlInputProps {
    value: string
    onChange: (value: string) => void
    onSubmit: () => void
    disabled?: boolean
    isLoading?: boolean
}

/** Reusable GitHub PR URL input with label, validation hint, and Enter-key submission. */
export function PrUrlInput({ value, onChange, onSubmit, disabled, isLoading }: PrUrlInputProps) {
    return (
        <div className="space-y-2">
            <label className="text-xs font-medium text-gray-400 uppercase tracking-wide">
                Pull Request URL
            </label>

            {isLoading ? (
                <div className="w-full bg-gray-900/60 border border-gray-800 rounded-lg h-[46px] flex items-center px-4 overflow-hidden relative">
                    <div className="h-4 w-2/5 bg-[#569cd6] rounded animate-pulse opacity-45" />
                </div>
            ) : (
                <input
                    type="url"
                    value={value}
                    disabled={disabled}
                    onChange={e => onChange(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && onSubmit()}
                    placeholder="https://github.com/owner/repo/pull/123"
                    className="w-full bg-gray-900/60 border border-gray-800 rounded-lg px-4 py-3
                               text-sm text-gray-100 placeholder-gray-600
                               focus:outline-none focus:border-blue-500/50 focus:shadow-[0_0_0_1px_rgba(59,130,246,0.15),0_0_15px_rgba(59,130,246,0.08)]
                               transition-all duration-200
                               disabled:opacity-50 disabled:cursor-not-allowed"
                />
            )}

            <p className="text-xs text-gray-600">
                Public repositories only — private repos require a{' '}
                <code className="text-gray-500">GITHUB_TOKEN</code> on the server.
            </p>
        </div>
    )
}
