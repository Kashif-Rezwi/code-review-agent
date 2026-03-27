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
    return res.json() as Promise<T>
}
