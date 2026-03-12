/**
 * Pure text-chunking utility — no external dependencies.
 *
 * Splits a document into overlapping chunks suitable for embedding.
 * Default sizing: ~2 000 chars per chunk ≈ 500 tokens at 4 chars/token.
 *                  200 char overlap         ≈  50 tokens.
 *
 * Used by RagService (NestJS) before calling the OpenAI embedding model.
 */
export function chunkText(
    text: string,
    chunkSize = 2000,
    overlap = 200,
): string[] {
    const chunks: string[] = []
    let start = 0

    while (start < text.length) {
        chunks.push(text.slice(start, start + chunkSize))
        start += chunkSize - overlap
    }

    // Drop any chunks that are purely whitespace (can happen at end of doc)
    return chunks.filter((c) => c.trim().length > 0)
}
