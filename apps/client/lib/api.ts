/** Base URL for all server API calls — set NEXT_PUBLIC_API_URL in your .env */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? ''

/**
 * Typed fetch wrapper for the CRA API.
 * - Prepends API_URL automatically
 * - Merges an optional Bearer token into the Authorization header
 * - Throws an Error with the server's text message on non-2xx responses
 * - Returns the parsed JSON body on success
 */
export async function apiFetch<T>(path: string, init?: RequestInit, token?: string): Promise<T> {
    const authHeader: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
    const res = await fetch(`${API_URL}${path}`, {
        ...init,
        headers: {
            ...(init?.headers as Record<string, string> | undefined),
            ...authHeader,
        },
    })
    if (!res.ok) {
        const msg = await res.text().catch(() => `HTTP ${res.status}`)
        throw new Error(msg || `Request failed with status ${res.status}`)
    }
    // 204 No Content (and any other bodyless response) must not be parsed as JSON
    if (res.status === 204 || res.headers.get('content-length') === '0') {
        return undefined as T
    }
    return res.json() as Promise<T>
}

// ── Structured API Endpoints ──────────────────────────────────────────────────

export const historyService = {
    getReviews: <T = unknown[]>(token?: string) =>
        apiFetch<T>('/history', undefined, token),
    getStats: <T = unknown>(token?: string) =>
        apiFetch<T>('/history/stats', undefined, token),
    getReview: <T = unknown>(id: string, token?: string) =>
        apiFetch<T>(`/history/${id}`, undefined, token),
    deleteReview: (id: string, token?: string) =>
        apiFetch<void>(`/history/${id}`, { method: 'DELETE' }, token),
}

export const reviewService = {
    getSession: <T = { type: 'CODE' | 'PR'; input: string }>(id: string, token?: string) =>
        apiFetch<T>(`/review/${id}`, undefined, token),
    createSession: (payload: { type: string, input: string }, token?: string) =>
        apiFetch<{ reviewId: string }>('/review/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        }, token),
    cancelSession: (reviewId: string, token?: string) =>
        apiFetch<void>(`/review/${reviewId}`, { method: 'DELETE' }, token),
}

export const ragService = {
    getDocuments: <T = unknown[]>(token?: string) =>
        apiFetch<T>('/rag/documents', undefined, token),
    uploadDocument: <T = unknown>(formData: FormData, token?: string) => 
        apiFetch<T>('/rag/upload', { method: 'POST', body: formData }, token),
    deleteDocument: (id: string, token?: string) => 
        apiFetch<void>(`/rag/documents/${id}`, { method: 'DELETE' }, token)
}
