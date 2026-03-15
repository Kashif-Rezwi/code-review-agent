'use client'

import dynamic from 'next/dynamic'
import { GitPullRequest, Code2, Copy, Check, ExternalLink } from 'lucide-react'
import { detectLanguage } from '@/lib/detect-language'
import { useCopyToClipboard } from '@/lib/hooks'
import type { Monaco } from '@monaco-editor/react'

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false })

const PAGE_BG = '#0d1117'

/** Register once — Monaco theme whose background matches the page colour. */
function registerTheme(monaco: Monaco) {
    monaco.editor.defineTheme('cra-dark', {
        base: 'vs-dark',
        inherit: true,
        rules: [],
        colors: {
            'editor.background':             PAGE_BG,
            'editor.lineHighlightBackground': '#161b22',
            'editorGutter.background':        PAGE_BG,
            'editorLineNumber.foreground':    '#30363d',
            'editorLineNumber.activeForeground': '#8b949e',
            'scrollbar.shadow':              '#00000000',
            'editor.selectionBackground':    '#264f78',
        },
    })
}

interface ReviewInputDisplayProps {
    type: 'CODE' | 'PR'
    input: string
}

/**
 * Shows the original input that was reviewed:
 * - PR   → card with a clickable URL, Copy, and Open-in-GitHub buttons
 * - CODE → read-only Monaco editor (custom theme blended with the page)
 */
export function ReviewInputDisplay({ type, input }: ReviewInputDisplayProps) {
    const { copied, copy } = useCopyToClipboard()

    /* ── PR URL card ─────────────────────────────────────────────── */
    if (type === 'PR') {
        return (
            <div className="rounded-xl border border-gray-700 bg-gray-900/60 p-4">
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
                        {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
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
    const language = detectLanguage(input)
    const lineCount = input.split('\n').length
    const editorHeight = Math.min(Math.max(lineCount * 19 + 32, 120), 400)

    return (
        <div className="rounded-xl border border-gray-800 overflow-hidden" style={{ background: PAGE_BG }}>
            {/* Toolbar */}
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-800/70">
                <div className="flex items-center gap-2">
                    <Code2 className="w-4 h-4 text-gray-500" />
                    <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                        Reviewed Code
                    </span>
                    {language !== 'plaintext' && (
                        <span className="px-2 py-0.5 rounded text-xs bg-gray-800/60 text-gray-400 border border-gray-700/50 font-mono">
                            {language}
                        </span>
                    )}
                </div>
                <button
                    onClick={() => copy(input)}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-gray-600
                               hover:text-gray-300 hover:bg-gray-800/60 transition-colors"
                >
                    {copied
                        ? <><Check className="w-3 h-3 text-green-400" /> Copied</>
                        : <><Copy className="w-3 h-3" /> Copy</>}
                </button>
            </div>

            {/* Monaco — background matches PAGE_BG exactly via custom theme */}
            <MonacoEditor
                height={editorHeight}
                language={language}
                value={input}
                theme="cra-dark"
                beforeMount={registerTheme}
                options={{
                    readOnly: true,
                    domReadOnly: true,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    fontSize: 13,
                    lineNumbers: 'on',
                    wordWrap: 'on',
                    renderLineHighlight: 'line',
                    scrollbar: { vertical: 'auto', horizontal: 'hidden' },
                    overviewRulerLanes: 0,
                    folding: false,
                    contextmenu: false,
                    cursorStyle: 'line',
                    cursorBlinking: 'solid',
                    renderWhitespace: 'none',
                    padding: { top: 10, bottom: 10 },
                    automaticLayout: true,
                }}
            />
        </div>
    )
}
