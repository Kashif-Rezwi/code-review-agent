'use client'

import dynamic from 'next/dynamic'
import { useCallback } from 'react'
import { cn } from '@/lib/utils'
import { LANGUAGE_LABELS } from '@/types/review.types'

import { EditorSkeleton } from './editor-skeleton'

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), {
    ssr: false,
    loading: EditorSkeleton,
})



interface CodeEditorProps {
    value: string
    language: string
    tokenCount: number
    isOverLimit: boolean
    onChange: (value: string | undefined) => void
}

// Monaco-powered code editor with language badge and token counter.
export function CodeEditor({ value, language, tokenCount, isOverLimit, onChange }: CodeEditorProps) {
    const handleChange = useCallback((val: string | undefined) => {
        onChange(val)
    }, [onChange])

    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-gray-400">Language</span>
                    <span className="px-2 py-0.5 bg-blue-900/40 border border-blue-700/40 rounded text-xs text-blue-300 font-mono">
                        {LANGUAGE_LABELS[language] ?? language}
                    </span>
                </div>
                <span className={cn('text-xs tabular-nums', isOverLimit ? 'text-red-400' : 'text-gray-500')}>
                    {tokenCount.toLocaleString()} / 8,000 tokens{isOverLimit && ' — too long'}
                </span>
            </div>
            <div className="rounded-lg border border-gray-700 overflow-hidden">
                <MonacoEditor
                    height="300px"
                    language={language}
                    value={value}
                    onChange={handleChange}
                    theme="vs-dark"
                    loading={<EditorSkeleton />}
                    options={{
                        fontSize: 14,
                        fontFamily: '"JetBrains Mono", "Fira Code", monospace',
                        minimap: { enabled: false },
                        scrollBeyondLastLine: false,
                        lineNumbers: 'on',
                        padding: { top: 12, bottom: 12 },
                        wordWrap: 'on',
                        automaticLayout: true,
                    }}
                />
            </div>
        </div>
    )
}
