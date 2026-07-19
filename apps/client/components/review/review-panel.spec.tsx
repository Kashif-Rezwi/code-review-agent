import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ReviewPanel } from './review-panel'

describe('ReviewPanel coverage', () => {
    it('labels a partial review and lists unreviewed files explicitly', () => {
        render(<ReviewPanel review={{
            summary: 'The reviewed files are sound.',
            score: 7,
            issues: [],
            positives: [],
            coverage: {
                totalFiles: 3,
                assignedFiles: 3,
                reviewedFiles: 2,
                truncatedFiles: [],
                metadataOnlyFiles: [],
                unreviewedFiles: ['src/c.ts'],
                failedClusters: ['cluster-c'],
                acquisitionSource: 'github_files_api',
            },
        }} />)

        expect(screen.getByText('Partial review — 2/3 files reviewed')).toBeInTheDocument()
        expect(screen.getByText(/src\/c\.ts/)).toBeInTheDocument()
    })
})
