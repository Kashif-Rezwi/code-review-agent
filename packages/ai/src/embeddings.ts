/**
 * Pure text-chunking utility — splits a document into overlapping chunks suitable for embedding.
 * Defaults: 2 000 chars/chunk (≈ 500 tokens) with 200-char overlap. Used by RagService before embedding.
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
