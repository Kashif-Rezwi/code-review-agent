'use client'

import { useCallback, useRef, useState } from 'react'
import {
    BookOpen,
    Upload,
    Trash2,
    FileText,
    Loader2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AppHeader } from '@/components/layout/app-header'
import { PageHeader } from '@/components/layout/page-header'
import { StatusMessage } from '@/components/ui/status-message'
import { useStandardsDocuments } from '@/lib/use-standards-documents'

export default function StandardsPage() {
    const {
        documents,
        isLoading,
        isUploading,
        deletingId,
        uploadError,
        uploadSuccess,
        uploadFile,
        deleteDocument,
    } = useStandardsDocuments()

    const [isDragging, setIsDragging] = useState(false)
    const fileInputRef = useRef<HTMLInputElement>(null)

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (file) uploadFile(file)
        // Reset so the same file can be re-uploaded after deletion
        e.target.value = ''
    }

    const handleDrop = useCallback(
        (e: React.DragEvent) => {
            e.preventDefault()
            setIsDragging(false)
            const file = e.dataTransfer.files?.[0]
            if (file) uploadFile(file)
        },
        [uploadFile],
    )

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault()
        setIsDragging(true)
    }
    const handleDragLeave = () => setIsDragging(false)

    const formatDate = (iso: string) =>
        new Date(iso).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
        })

    return (
        <div className="min-h-screen bg-app-bg text-gray-100">
            <AppHeader />

            <main className="max-w-4xl mx-auto p-6 space-y-6">
                <PageHeader
                    icon={BookOpen}
                    title="Coding Standards"
                    description="Upload your team's style guides or conventions documents. Reviews will be automatically checked against these standards."
                />

                {/* Upload zone */}
                <div
                    className={`relative border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer
                        ${isDragging
                            ? 'border-blue-500/60 bg-blue-950/10'
                            : 'border-gray-800 bg-gray-900/30 hover:border-gray-700 hover:bg-gray-900/50'
                        }`}
                    onClick={() => !isUploading && fileInputRef.current?.click()}
                    onDrop={handleDrop}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                >
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".txt,.pdf,.md"
                        className="hidden"
                        onChange={handleFileChange}
                        disabled={isUploading}
                    />

                    {isUploading ? (
                        <div className="flex flex-col items-center gap-2">
                            <Loader2 className="w-8 h-8 text-blue-400 animate-spin" />
                            <p className="text-sm text-gray-400">Chunking and embedding document…</p>
                        </div>
                    ) : (
                        <div className="flex flex-col items-center gap-3">
                            <div className="w-12 h-12 rounded-lg bg-gray-900 border border-gray-800 flex items-center justify-center">
                                <Upload className="w-5 h-5 text-gray-500" />
                            </div>
                            <div>
                                <p className="text-sm text-gray-300 font-medium">
                                    Drop a file here or{' '}
                                    <span className="text-blue-400">click to browse</span>
                                </p>
                                <p className="text-xs text-gray-600 mt-1">
                                    .txt or .pdf — max 5 MB
                                </p>
                            </div>
                        </div>
                    )}
                </div>

                {/* Status messages */}
                {uploadError && <StatusMessage variant="error" message={uploadError} />}
                {uploadSuccess && <StatusMessage variant="success" message={uploadSuccess} />}

                {/* Document list */}
                <div className="space-y-3">
                    <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                        Uploaded Standards{!isLoading && ` (${documents.length})`}
                    </h2>

                    {isLoading ? (
                        <div className="space-y-2">
                            {[1, 2, 3].map((i) => (
                                <div
                                    key={i}
                                    className="flex items-center gap-4 rounded-lg border border-gray-800 bg-gray-900/60 px-4 py-3 animate-pulse"
                                >
                                    {/* File icon */}
                                    <div className="w-4 h-4 rounded bg-gray-700 shrink-0" />
                                    {/* Filename + meta */}
                                    <div className="flex-1 space-y-1.5 min-w-0">
                                        <div className="h-3.5 bg-gray-700 rounded w-44" />
                                        <div className="h-3 bg-gray-800 rounded w-28" />
                                    </div>
                                    {/* Delete button */}
                                    <div className="h-8 w-8 rounded-md bg-gray-800 shrink-0" />
                                </div>
                            ))}
                        </div>
                    ) : documents.length === 0 ? (
                        <div className="rounded-lg border border-gray-800 bg-gray-900/40 p-8 text-center">
                            <FileText className="w-8 h-8 text-gray-700 mx-auto mb-3" />
                            <p className="text-sm text-gray-500">
                                No standards uploaded yet.
                            </p>
                            <p className="text-xs text-gray-600 mt-1">
                                Add a style guide to personalize your code reviews.
                            </p>
                        </div>
                    ) : (
                        <ul className="space-y-2">
                            {documents.map((doc) => (
                                <li
                                    key={doc.id}
                                    className="flex items-center gap-4 rounded-lg border border-gray-800 bg-gray-900/60 px-4 py-3"
                                >
                                    <FileText className="w-4 h-4 text-blue-400 shrink-0" />
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm text-gray-200 truncate font-medium">
                                            {doc.name}
                                        </p>
                                        <p className="text-xs text-gray-600">
                                            {doc._count.chunks} chunk
                                            {doc._count.chunks !== 1 ? 's' : ''} ·{' '}
                                            {formatDate(doc.createdAt)}
                                        </p>
                                    </div>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        disabled={deletingId === doc.id}
                                        onClick={() => deleteDocument(doc.id, doc.name)}
                                        className="text-gray-500 hover:text-red-400 hover:bg-red-950/30 h-8 w-8 p-0"
                                    >
                                        {deletingId === doc.id ? (
                                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                        ) : (
                                            <Trash2 className="w-3.5 h-3.5" />
                                        )}
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </main>
        </div>
    )
}
