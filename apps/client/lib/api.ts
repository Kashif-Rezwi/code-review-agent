/** Base URL for all server API calls — set NEXT_PUBLIC_API_URL in your .env */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? ''

/**
 * Typed fetch wrapper for the CRA API.
 * - Prepends API_URL automatically
 * - Throws an Error with the server's text message on non-2xx responses
 * - Returns the parsed JSON body on success
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${API_URL}${path}`, init)
    if (!res.ok) {
        const msg = await res.text().catch(() => `HTTP ${res.status}`)
        throw new Error(msg || `Request failed with status ${res.status}`)
    }
    return res.json() as Promise<T>
}
