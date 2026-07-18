import type { PRFile } from '@cra/ai'
import type { ReviewAcquisitionSource } from '@cra/types'

export type PatchState = 'full' | 'truncated' | 'metadata_only' | 'binary'

export type NormalizedPRFile = PRFile & {
    patchState: PatchState
    previousFilename?: string
}

export interface PRSnapshot {
    files: NormalizedPRFile[]
    source: ReviewAcquisitionSource
    complete: boolean
    warnings: string[]
}

export type GithubTokenHealth = 'valid' | 'invalid' | 'missing' | 'unchecked'
