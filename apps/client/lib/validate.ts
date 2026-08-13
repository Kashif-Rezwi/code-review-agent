/** Shared validation helpers — single source of truth for input rules across the review page and server-side guards. */

/** Matches a well-formed GitHub pull-request URL, e.g. https://github.com/owner/repo/pull/123 */
export const PR_URL_REGEX = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/

/** Returns true when `url` is a syntactically valid GitHub PR URL. */
export function isValidPrUrl(url: string): boolean {
    return PR_URL_REGEX.test(url.trim())
}
