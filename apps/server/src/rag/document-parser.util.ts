/**
 * Extracts raw text from an uploaded document buffer based on its MIME type.
 * Handles PDF parsing via dynamic import to prevent Jest initialization side-effects.
 */
export async function extractText(buffer: Buffer, mimeType: string): Promise<string> {
    if (mimeType === 'application/pdf') {
        // Dynamic import — pdf-parse has side-effects that break Jest at the top level
        const pdfParse = (await import('pdf-parse')).default
        return (await pdfParse(buffer)).text
    }
    return buffer.toString('utf-8')
}
