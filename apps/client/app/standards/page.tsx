'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
    BookOpen,
    Upload,
    Trash2,
    FileText,
    Loader2,
    AlertTriangle,
    CheckCircle2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AppHeader } from '@/components/layout/app-header'

interface Document {
    id: string
    name: string
    createdAt: string
    _count: { chunks: number }
}

export default function StandardsPage() {
    const [documents, setDocuments] = useState<Document[]>([])
    const [isLoadingDocs, setIsLoadingDocs] = useState(true)
    const [isUploading, setIsUploading] = useState(false)
    const [uploadError, setUploadError] = useState<string | null>(null)
    const [uploadSuccess, setUploadSuccess] = useState<string | null>(null)
    const [deletingId, setDeletingId] = useState<string | null>(null)
    const [isDragging, setIsDragging] = useState(false)
    const fileInputRef = useRef<HTMLInputElement>(null)

    const apiUrl = process.env.NEXT_PUBLIC_API_URL

    const fetchDocuments = useCallback(async () => {
        try {
            const res = await fetch(`${apiUrl}/rag/documents`)
            if (res.ok) setDocuments(await res.json())
        } catch {
            // silently ignore — list can be refetched on next interaction
        } finally {
            setIsLoadingDocs(false)
        }
    }, [apiUrl])

    useEffect(() => {
        fetchDocuments()
    }, [fetchDocuments])

    const uploadFile = useCallback(async (file: File) => {
        const allowed = ['text/plain', 'application/pdf', 'text/markdown']
        if (!allowed.includes(file.type)) {
            setUploadError('Only .txt and .pdf files are supported.')
            return
        }
        if (file.size > 5 * 1024 * 1024) {
            setUploadError('File must be smaller than 5 MB.')
            return
        }

        setIsUploading(true)
        setUploadError(null)
        setUploadSuccess(null)

        const formData = new FormData()
        formData.append('file', file)

        try {
            const res = await fetch(`${apiUrl}/rag/upload`, {
                method: 'POST',
                body: formData,
            })
            if (!res.ok) {
                const msg = await res.text()
                throw new Error(msg || 'Upload failed.')
            }
            setUploadSuccess(`"${file.name}" uploaded successfully.`)
            await fetchDocuments()
        } catch (err) {
            setUploadError(err instanceof Error ? err.message : 'Upload failed.')
        } finally {
            setIsUploading(false)
        }
    }, [apiUrl, fetchDocuments])

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

    const handleDelete = async (id: string, name: string) => {
        setDeletingId(id)
        try {
            const res = await fetch(`${apiUrl}/rag/documents/${id}`, { method: 'DELETE' })
            if (res.ok) {
                setDocuments((prev) => prev.filter((d) => d.id !== id))
                if (uploadSuccess?.includes(name)) setUploadSuccess(null)
            }
        } catch {
            // Network error — document stays in list, user can retry
        } finally {
            setDeletingId(null)
        }
    }

    const formatDate = (iso: string) =>
        new Date(iso).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
        })

    return (
        <div className="min-h-screen bg-[#0d1117] text-gray-100">
            <AppHeader />

            <main className="max-w-3xl mx-auto p-6 space-y-8">
                <div>
                    <h1 className="text-2xl font-bold text-white flex items-center gap-2">
                        <BookOpen className="w-6 h-6 text-blue-400" />
                        Coding Standards
                    </h1>
                    <p className="text-gray-400 text-sm mt-1">
                        Upload your team's style guides or conventions documents. Reviews will be
                        automatically checked against these standards.
                    </p>
                </div>

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
                            <div className="w-12 h-12 rounded-xl bg-gray-900 border border-gray-800 flex items-center justify-center">
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
                {uploadError && (
                    <div className="flex items-center gap-2 text-sm text-red-300 bg-red-950/40 border border-red-800 rounded-lg px-4 py-3">
                        <AlertTriangle className="w-4 h-4 shrink-0" />
                        {uploadError}
                    </div>
                )}
                {uploadSuccess && (
                    <div className="flex items-center gap-2 text-sm text-green-300 bg-green-950/40 border border-green-800 rounded-lg px-4 py-3">
                        <CheckCircle2 className="w-4 h-4 shrink-0" />
                        {uploadSuccess}
                    </div>
                )}

                {/* Document list */}
                <div className="space-y-3">
                    <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                        Uploaded Standards ({documents.length})
                    </h2>

                    {isLoadingDocs ? (
                        <div className="space-y-2">
                            {[1, 2].map((i) => (
                                <div
                                    key={i}
                                    className="h-16 rounded-lg bg-gray-900/60 border border-gray-800 animate-pulse"
                                />
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
                                        onClick={() => handleDelete(doc.id, doc.name)}
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
