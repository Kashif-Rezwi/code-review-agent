/**
 * Custom hook that manages the Standards page document list.
 *
 * Encapsulates all fetch / upload / delete logic so the page component
 * stays focused on presentation only.
 */

import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api'

export interface StandardsDocument {
    id: string
    name: string
    createdAt: string
    _count: { chunks: number }
}

interface UseStandardsDocuments {
    documents: StandardsDocument[]
    isLoading: boolean
    isUploading: boolean
    deletingId: string | null
    uploadError: string | null
    uploadSuccess: string | null
    uploadFile: (file: File) => Promise<void>
    deleteDocument: (id: string, name: string) => Promise<void>
    clearUploadSuccess: () => void
    clearUploadError: () => void
}

const ALLOWED_TYPES = ['text/plain', 'application/pdf', 'text/markdown']
const MAX_SIZE_BYTES = 5 * 1024 * 1024 // 5 MB

export function useStandardsDocuments(githubToken?: string): UseStandardsDocuments {
    const [documents,     setDocuments]     = useState<StandardsDocument[]>([])
    const [isLoading,     setIsLoading]     = useState(true)
    const [isUploading,   setIsUploading]   = useState(false)
    const [deletingId,    setDeletingId]    = useState<string | null>(null)
    const [uploadError,   setUploadError]   = useState<string | null>(null)
    const [uploadSuccess, setUploadSuccess] = useState<string | null>(null)

    const fetchDocuments = useCallback(async () => {
        try {
            const docs = await apiFetch<StandardsDocument[]>('/rag/documents', undefined, githubToken)
            setDocuments(docs)
        } catch {
            // silently ignore — list can be refetched on next interaction
        } finally {
            setIsLoading(false)
        }
    }, [githubToken])

    useEffect(() => { fetchDocuments() }, [fetchDocuments])

    const uploadFile = useCallback(async (file: File) => {
        if (!ALLOWED_TYPES.includes(file.type)) {
            setUploadError('Only .txt and .pdf files are supported.')
            return
        }
        if (file.size > MAX_SIZE_BYTES) {
            setUploadError('File must be smaller than 5 MB.')
            return
        }

        setIsUploading(true)
        setUploadError(null)
        setUploadSuccess(null)

        const formData = new FormData()
        formData.append('file', file)

        try {
            await apiFetch<unknown>('/rag/upload', { method: 'POST', body: formData }, githubToken)
            setUploadSuccess(`"${file.name}" uploaded successfully.`)
            await fetchDocuments()
        } catch (err) {
            setUploadError(err instanceof Error ? err.message : 'Upload failed.')
        } finally {
            setIsUploading(false)
        }
    }, [fetchDocuments])

    const deleteDocument = useCallback(async (id: string, name: string) => {
        setDeletingId(id)
        try {
            await apiFetch<void>(`/rag/documents/${id}`, { method: 'DELETE' }, githubToken)
            setDocuments(prev => prev.filter(d => d.id !== id))
            setUploadSuccess(prev => (prev?.includes(name) ? null : prev))
        } catch {
            // Network error — document stays in list, user can retry
        } finally {
            setDeletingId(null)
        }
    }, [])

    return {
        documents,
        isLoading,
        isUploading,
        deletingId,
        uploadError,
        uploadSuccess,
        uploadFile,
        deleteDocument,
        clearUploadSuccess: () => setUploadSuccess(null),
        clearUploadError:   () => setUploadError(null),
    }
}
