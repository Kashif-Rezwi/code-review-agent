'use client'

import { GitPullRequest, Copy, Check, ExternalLink } from 'lucide-react'
import { detectLanguage } from '@/lib/detect-language'
import { useCopyToClipboard } from '@/lib/hooks'
import { CodeEditor } from './code-editor'

interface ReviewInputDisplayProps {
    type: 'CODE' | 'PR'
    input: string
}

/**
 * Show the original reviewed input: PR → clickable URL card with Copy/Open-in-GitHub;
 * CODE → read-only CodeEditor (all editor styling and theming live there).
 */
export function ReviewInputDisplay({ type, input }: ReviewInputDisplayProps) {
    const { copied, copy } = useCopyToClipboard()

    /* ── PR URL card ─────────────────────────────────────────────── */
    if (type === 'PR') {
        return (
            <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-4 shadow-[0_0_20px_rgba(59,130,246,0.06)]">
                <div className="flex items-center gap-2 mb-3">
                    <GitPullRequest className="w-4 h-4 text-blue-400" />
                    <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                        Pull Request
                    </span>
                </div>
                <div className="flex items-center gap-2 min-w-0">
                    <a
                        href={input}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 min-w-0 text-sm text-blue-400 hover:text-blue-300 truncate transition-colors"
                    >
                        {input}
                    </a>
                    <button
                        onClick={() => copy(input)}
                        title="Copy URL"
                        className="p-1.5 rounded-md text-gray-500 hover:text-gray-300 hover:bg-gray-800 transition-colors shrink-0"
                    >
                        {copied
                            ? <Check className="w-3.5 h-3.5 text-green-400" />
                            : <Copy className="w-3.5 h-3.5" />}
                    </button>
                    <a
                        href={input}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Open in GitHub"
                        className="p-1.5 rounded-md text-gray-500 hover:text-gray-300 hover:bg-gray-800 transition-colors shrink-0"
                    >
                        <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                </div>
            </div>
        )
    }

    /* ── Read-only code editor ───────────────────────────────────── */
    const language   = detectLanguage(input)
    const lineCount  = input.split('\n').length
    const editorHeight = Math.min(Math.max(lineCount * 19 + 32, 120), 400)

    return (
        <CodeEditor
            value={input}
            language={language}
            readOnly
            label="Reviewed Code"
            height={editorHeight}
        />
    )
}
