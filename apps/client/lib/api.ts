/** Base URL for all server API calls — set NEXT_PUBLIC_API_URL in your .env */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? ''

export async function apiErrorMessage(response: Response): Promise<string> {
    const fallback = `Request failed with status ${response.status}`
    const text = await response.text().catch(() => '')
    if (!text) return fallback
    try {
        const parsed = JSON.parse(text) as { message?: unknown; error?: unknown }
        if (Array.isArray(parsed.message)) return parsed.message.filter((item): item is string => typeof item === 'string').join(', ') || fallback
        if (typeof parsed.message === 'string') return parsed.message
        if (typeof parsed.error === 'string') return parsed.error
    } catch {
        // A non-JSON upstream error is still more useful than a generic status.
    }
    return text
}

/**
 * Typed fetch wrapper for the CRA API: prepends API_URL, merges an optional Bearer token,
 * throws the server's message on non-2xx, and returns the parsed JSON body on success.
 */
export async function apiFetch<T>(path: string, init?: RequestInit, token?: string): Promise<T> {
    if (!API_URL) {
        // Without a configured API origin the request would go same-origin and 404
        // against the Next.js server with a confusing error.
        throw new Error('NEXT_PUBLIC_API_URL is not configured — set it to the API origin (e.g. http://localhost:4000) and rebuild the client.')
    }
    const authHeader: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
    const res = await fetch(`${API_URL}${path}`, {
        ...init,
        headers: {
            ...(init?.headers as Record<string, string> | undefined),
            ...authHeader,
        },
    })
    if (!res.ok) {
        throw new Error(await apiErrorMessage(res))
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

import type { WalletResponse } from '@cra/types'

export const paymentsService = {
    createOrder: (payload: { packageId: string }, token?: string) =>
        apiFetch<{
            orderId: string
            razorpayOrderId: string
            amount: number
            currency: string
            keyId: string
        }>('/payments/order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        }, token),
    getWallet: <T = WalletResponse>(token?: string) =>
        apiFetch<T>('/payments/wallet', undefined, token),
}


