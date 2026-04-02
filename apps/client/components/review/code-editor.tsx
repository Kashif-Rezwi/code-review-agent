'use client'

import dynamic from 'next/dynamic'
import { useCallback } from 'react'
import { Code2, Copy, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { LANGUAGE_LABELS } from '@/types/review-config'
import { useCopyToClipboard } from '@/lib/hooks'
import { Button } from '@/components/ui/button'
import type { Monaco } from '@monaco-editor/react'
import { EditorSkeleton } from './editor-skeleton'

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), {
    ssr: false,
    loading: EditorSkeleton,
})

// Solid-colour equivalent of Tailwind's `bg-gray-900/60` on the page background (#0d1117).
// Exported so ReviewInputDisplay can use it for the container background without re-deriving.
export const EDITOR_BG = '#0f1521'

/** Register the custom Monaco theme once — called via beforeMount on every instance. */
export function registerEditorTheme(monaco: Monaco) {
    monaco.editor.defineTheme('cra-dark', {
        base: 'vs-dark',
        inherit: true,
        rules: [],
        colors: {
            'editor.background':                EDITOR_BG,
            'editor.lineHighlightBackground':   '#1a2332',
            'editorGutter.background':          EDITOR_BG,
            'editorLineNumber.foreground':      '#30363d',
            'editorLineNumber.activeForeground':'#8b949e',
            'scrollbar.shadow':                 '#00000000',
            'editor.selectionBackground':       '#264f78',
        },
    })
}

interface CodeEditorProps {
    value: string
    language: string
    // ── Editable mode (Review page) ──────────────────────────────
    tokenCount?: number
    isOverLimit?: boolean
    onChange?: (value: string | undefined) => void
    // ── Display / read-only mode (History detail page) ───────────
    readOnly?: boolean
    label?: string          // toolbar label — defaults to 'Code' or 'Reviewed Code'
    height?: number | string
    isLoading?: boolean
}

/**
 * Unified Monaco-powered code editor used across the whole app.
 *
 *  - Editable (default)  — Review page: token counter on the right.
 *  - readOnly            — History detail: Copy button on the right.
 *
 * Toolbar height is pinned at 41 px so the layout never shifts when
 * the language badge appears or disappears.
 */
export function CodeEditor({
    value,
    language,
    tokenCount,
    isOverLimit,
    onChange,
    readOnly = false,
    label,
    height,
    isLoading,
}: CodeEditorProps) {
    const { copied, copy } = useCopyToClipboard()
    const handleChange = useCallback(
        (val: string | undefined) => { onChange?.(val) },
        [onChange],
    )

    const langLabel      = LANGUAGE_LABELS[language] ?? language
    const toolbarLabel   = label ?? (readOnly ? 'Reviewed Code' : 'Code')
    const editorHeight   = height ?? '300px'

    return (
        <div className="rounded-lg border border-gray-800 overflow-hidden" style={{ background: EDITOR_BG }}>

            {/* ── Toolbar ─────────────────────────────────────────── */}
            <div className="flex items-center justify-between h-[41px] px-4 border-b border-gray-800/70">
                <div className="flex items-center gap-2">
                    <Code2 className="w-4 h-4 text-gray-500" />
                    <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                        {toolbarLabel}
                    </span>
                    {language !== 'plaintext' && (
                        <span className="px-2 py-0.5 rounded-md text-xs bg-blue-500/10 text-blue-300 border border-blue-500/20 font-mono">
                            {langLabel}
                        </span>
                    )}
                </div>

                {readOnly ? (
                    /* Copy button — read-only / history mode */
                    <Button
                        variant="ghost-icon"
                        size="sm"
                        onClick={() => copy(value)}
                        className="gap-1.5 text-xs"
                    >
                        {copied
                            ? <><Check className="w-3 h-3 text-green-400" /> Copied</>
                            : <><Copy className="w-3 h-3" /> Copy</>}
                    </Button>
                ) : (
                    /* Token counter — editable / review mode */
                    <span className={cn(
                        'text-xs tabular-nums',
                        isOverLimit ? 'text-red-400' : 'text-gray-600',
                    )}>
                        {(tokenCount ?? 0).toLocaleString()} / 8,000 tokens
                        {isOverLimit && ' — too long'}
                    </span>
                )}
            </div>

            {/* ── Monaco ──────────────────────────────────────────── */}
            {isLoading ? (
                <EditorSkeleton />
            ) : (
                <MonacoEditor
                    height={editorHeight}
                    language={language}
                    value={value}
                    theme="cra-dark"
                    beforeMount={registerEditorTheme}
                    onMount={(editor) => {
                        if (!readOnly) editor.focus()
                    }}
                    loading={<EditorSkeleton />}
                    onChange={readOnly ? undefined : handleChange}
                    options={{
                        readOnly,
                        domReadOnly: readOnly,
                        fontSize: 13,
                        fontFamily: '"JetBrains Mono", "Fira Code", monospace',
                        minimap: { enabled: false },
                        scrollBeyondLastLine: false,
                        lineNumbers: 'on',
                        wordWrap: 'on',
                        renderLineHighlight: 'line',
                        scrollbar: { vertical: 'auto', horizontal: 'hidden' },
                        overviewRulerLanes: 0,
                        padding: { top: 10, bottom: 10 },
                        automaticLayout: true,
                        // Extra read-only hardening
                        ...(readOnly && {
                            folding: false,
                            contextmenu: false,
                            cursorStyle: 'line',
                            cursorBlinking: 'solid',
                            renderWhitespace: 'none',
                        }),
                    }}
                />
            )}
        </div>
    )
}
