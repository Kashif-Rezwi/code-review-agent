import { Logger } from '@nestjs/common'
import type { ReviewData, ReviewStreamEvent } from '@cra/types'

import { AiService } from '../ai/ai.service'
import { GithubService } from '../github/github.service'
import type { NormalizedPRFile, PRSnapshot } from '../github/github.types'
import { LinterService } from '../linter/linter.service'
import { QueueService } from '../queue/queue.service'
import { RedisService } from '../queue/redis.service'
import { RagService } from '../rag/rag.service'
import { ReviewRepository } from './review.repository'
import { ReviewService } from './review.service'
import type { SseConnection } from './review.sse'

jest.mock('ai', () => ({
    generateObject: jest.fn(),
    generateText: jest.fn(),
    streamText: jest.fn(),
    tool: jest.fn((definition) => definition),
}))

const PR_URL = 'https://github.com/vercel/next.js/pull/91191'
const REVIEW_ID = 'review-123'
const USER_ID = 'user-123'
const VALID_REVIEW: ReviewData = {
    summary: 'The change is safe and well scoped.',
    score: 8,
    issues: [],
    positives: ['The intent is clear.'],
}

// Pull mocks from Jest rather than importing AI SDK function types. The SDK's
// overloads are intentionally deep and add no value to this behavioral suite.
const aiMocks = jest.requireMock<{ [key: string]: jest.Mock }>('ai')
const streamTextMock = aiMocks.streamText
const generateTextMock = aiMocks.generateText
const generateObjectMock = aiMocks.generateObject

interface Harness {
    service: ReviewService
    conn: SseConnection
    events: ReviewStreamEvent[]
    operations: string[]
    githubService: {
        assertValidPRUrl: jest.Mock
        fetchPRSnapshot: jest.Mock
    }
    reviewRepository: {
        saveReview: jest.Mock
        markFailed: jest.Mock
    }
}

function workerResult(text: string) {
    return {
        text: Promise.resolve(text),
        steps: Promise.resolve([{ text }]),
    } as never
}

function file(filename: string, patchLength = 50): NormalizedPRFile {
    return {
        filename,
        status: 'modified',
        additions: 2,
        deletions: 1,
        patch: `@@ -1 +1 @@\n-old\n+${'x'.repeat(patchLength)}`,
        patchState: 'full',
    }
}

function snapshot(fileCount: number, source: PRSnapshot['source'] = 'github_files_api'): PRSnapshot {
    return {
        files: Array.from({ length: fileCount }, (_, index) => file(`src/domain-${index % 4}/file-${index}.ts`, 50 + index)),
        source,
        complete: true,
        warnings: source === 'public_diff' ? ['Authenticated and anonymous file-list attempts failed.'] : [],
    }
}

function createHarness(): Harness {
    const events: ReviewStreamEvent[] = []
    const operations: string[] = []
    const conn: SseConnection = {
        startedAt: Date.now(),
        send: (event) => {
            events.push(event)
            operations.push(`send:${event.type}`)
        },
        getTrace: () => events,
        flush: jest.fn().mockResolvedValue(undefined),
    }
    const reviewRepository = {
        createSession: jest.fn(),
        saveReview: jest.fn().mockImplementation(() => {
            operations.push('save')
            return Promise.resolve(REVIEW_ID)
        }),
        markFailed: jest.fn().mockImplementation(() => {
            operations.push('markFailed')
            return Promise.resolve(true)
        }),
        markCancelled: jest.fn(),
    }
    const githubService = {
        assertValidPRUrl: jest.fn(),
        fetchPRSnapshot: jest.fn(),
    }
    const service = new ReviewService(
        reviewRepository as unknown as ReviewRepository,
        githubService as unknown as GithubService,
        { lint: jest.fn() } as unknown as LinterService,
        { retrieveForContext: jest.fn().mockResolvedValue(null) } as unknown as RagService,
        { defaultModel: { modelId: 'configured-test-model' } } as unknown as AiService,
        { enqueue: jest.fn(), removeJob: jest.fn() } as unknown as QueueService,
        { emitEvent: jest.fn() } as unknown as RedisService,
        { kick: jest.fn() } as never,
        { requestCancellation: jest.fn() } as never,
    )

    return { service, conn, events, operations, githubService, reviewRepository }
}

describe('ReviewService coverage-safe PR orchestration', () => {
    beforeEach(() => {
        streamTextMock.mockReset()
        generateTextMock.mockReset()
        generateObjectMock.mockReset()
        generateObjectMock.mockRejectedValue(new Error('planner unavailable'))
        streamTextMock.mockImplementation(() => workerResult(JSON.stringify(VALID_REVIEW)))
        generateTextMock.mockResolvedValue({ text: JSON.stringify(VALID_REVIEW) } as never)
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
        jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    })

    afterEach(() => jest.restoreAllMocks())

    it('runs files API acquisition through planner, workers and synthesis, then persists before completion', async () => {
        const harness = createHarness()
        harness.githubService.fetchPRSnapshot.mockResolvedValue(snapshot(8))

        await harness.service.runForQueue(REVIEW_ID, 'PR', PR_URL, USER_ID, harness.conn)

        const acquisition = harness.events.find((event) => event.type === 'acquisition')
        const plan = harness.events.find((event) => event.type === 'cluster_plan')
        const taskPlan = harness.events.find((event) => event.type === 'task_plan')
        expect(acquisition).toMatchObject({ source: 'github_files_api', fileCount: 8 })
        expect(plan?.type === 'cluster_plan' ? plan.clusters.length : 0).toBeGreaterThanOrEqual(2)
        expect(taskPlan?.type === 'task_plan' ? taskPlan.tasks.map((task) => task.id) : []).toEqual(
            snapshot(8).files.map((item) => item.filename),
        )
        expect(harness.events.filter((event) => event.type === 'cluster_done')).toHaveLength(2)
        expect(harness.events.filter((event) => event.type === 'synthesis_start')).toHaveLength(1)
        expect(streamTextMock).toHaveBeenCalledTimes(2)
        expect(streamTextMock.mock.calls.every(([request]) =>
            String(request.messages?.[0]?.content).includes('untrusted pull-request data'),
        )).toBe(true)
        expect(harness.reviewRepository.saveReview).toHaveBeenCalledWith(
            PR_URL,
            'PR',
            expect.objectContaining({ coverage: expect.objectContaining({ totalFiles: 8, assignedFiles: 8 }) }),
            USER_ID,
            expect.any(Array),
            REVIEW_ID,
            'complete',
        )
        expect(harness.operations.indexOf('save')).toBeLessThan(harness.operations.indexOf('send:complete'))
    })

    it('surfaces provider stream errors instead of misreporting unparseable model output', async () => {
        const harness = createHarness()
        streamTextMock.mockImplementation((options: { onError?: (arg: { error: unknown }) => void }) => {
            options.onError?.({
                error: { error: { code: 'billing_not_active', message: 'Your account is not active' } },
            })
            return workerResult('')
        })

        await harness.service.runForQueue(REVIEW_ID, 'CODE', 'const a = 1', USER_ID, harness.conn)

        const errorEvent = harness.events.find((event) => event.type === 'error')
        expect(errorEvent).toMatchObject({
            message: 'The AI provider returned an error. Please try again later.',
        })
        expect(harness.reviewRepository.markFailed).toHaveBeenCalledWith(
            REVIEW_ID,
            'The AI provider returned an error. Please try again later.',
            expect.any(Array),
        )
    })

    it('prefers the captured provider error when the stream rejects with generic no-output', async () => {
        const harness = createHarness()
        streamTextMock.mockImplementation((options: { onError?: (arg: { error: unknown }) => void }) => {
            options.onError?.({
                error: { error: { code: 'billing_not_active', message: 'Your account is not active' } },
            })
            return {
                text: Promise.reject(new Error('No output generated. Check the stream for errors.')),
                steps: Promise.resolve([]),
            }
        })

        await harness.service.runForQueue(REVIEW_ID, 'CODE', 'const a = 1', USER_ID, harness.conn)

        // Non-transient billing error — no retry.
        expect(streamTextMock).toHaveBeenCalledTimes(1)
        expect(harness.events).toContainEqual(
            expect.objectContaining({ type: 'error', message: 'The AI provider returned an error. Please try again later.' }),
        )
    })

    it('waits out a transient quota error and completes the pasted-code review', async () => {
        const harness = createHarness()
        let call = 0
        streamTextMock.mockImplementation((options: { onError?: (arg: { error: unknown }) => void }) => {
            call++
            if (call === 1) {
                options.onError?.({
                    error: new Error('Failed after 2 attempts. Last error: You exceeded your current quota. Please retry in 0.05s.'),
                })
                return {
                    text: Promise.reject(new Error('No output generated. Check the stream for errors.')),
                    steps: Promise.resolve([]),
                }
            }
            return workerResult(JSON.stringify(VALID_REVIEW))
        })

        await harness.service.runForQueue(REVIEW_ID, 'CODE', 'const a = 1', USER_ID, harness.conn)

        expect(streamTextMock).toHaveBeenCalledTimes(2)
        expect(harness.events).toContainEqual(expect.objectContaining({ type: 'complete', outcome: 'complete' }))
    })

    it('backs off and retries a worker when the provider rate-limits the stream', async () => {
        const harness = createHarness()
        harness.githubService.fetchPRSnapshot.mockResolvedValue(snapshot(3))
        let call = 0
        streamTextMock.mockImplementation((options: { onError?: (arg: { error: unknown }) => void }) => {
            call++
            if (call === 1) {
                options.onError?.({
                    error: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } },
                })
                return workerResult('')
            }
            return workerResult(JSON.stringify(VALID_REVIEW))
        })

        await harness.service.runForQueue(REVIEW_ID, 'PR', PR_URL, USER_ID, harness.conn)

        expect(streamTextMock).toHaveBeenCalledTimes(2)
        expect(harness.events.some((event) => event.type === 'thinking' && event.text.includes('rate-limited'))).toBe(true)
        expect(harness.events).toContainEqual(expect.objectContaining({ type: 'complete', outcome: 'complete' }))
    })

    it('uses the same clustered path for a public-diff snapshot and never invokes the generic PR agent', async () => {
        const harness = createHarness()
        harness.githubService.fetchPRSnapshot.mockResolvedValue(snapshot(7, 'public_diff'))

        await harness.service.runForQueue(REVIEW_ID, 'PR', PR_URL, USER_ID, harness.conn)

        expect(harness.events).toContainEqual(expect.objectContaining({
            type: 'acquisition',
            source: 'public_diff',
            fileCount: 7,
        }))
        expect(harness.events.filter((event) => event.type === 'cluster_done')).toHaveLength(2)
        expect(harness.events.some((event) => event.type === 'synthesis_start')).toBe(true)
        expect(streamTextMock.mock.calls.every(([request]) =>
            String(request.messages?.[0]?.content).includes('"focusHint"'),
        )).toBe(true)
    })

    it('assigns every file in a 20-file PR exactly once and runs no more than three workers concurrently', async () => {
        const harness = createHarness()
        harness.githubService.fetchPRSnapshot.mockResolvedValue(snapshot(20))
        let active = 0
        let maxActive = 0
        streamTextMock.mockImplementation(() => {
            active++
            maxActive = Math.max(maxActive, active)
            const text = new Promise<string>((resolve) => {
                setTimeout(() => {
                    active--
                    resolve(JSON.stringify(VALID_REVIEW))
                }, 5)
            })
            return {
                text,
                steps: text.then((value) => [{ text: value }]),
            } as never
        })

        await harness.service.runForQueue(REVIEW_ID, 'PR', PR_URL, USER_ID, harness.conn)

        const plan = harness.events.find((event) => event.type === 'cluster_plan')
        const assignments = plan?.type === 'cluster_plan'
            ? plan.clusters.flatMap((cluster) => cluster.files.map((item) => item.name))
            : []
        expect(assignments).toHaveLength(20)
        expect(new Set(assignments).size).toBe(20)
        expect(plan?.type === 'cluster_plan' ? plan.clusters.length : 0).toBeGreaterThanOrEqual(2)
        expect(maxActive).toBe(3)
        const savedReview = harness.reviewRepository.saveReview.mock.calls[0][2] as ReviewData
        expect(savedReview.coverage).toMatchObject({ totalFiles: 20, assignedFiles: 20, reviewedFiles: 20 })
    })

    it('retries an invalid worker once at temperature zero and finishes COMPLETE', async () => {
        const harness = createHarness()
        harness.githubService.fetchPRSnapshot.mockResolvedValue(snapshot(3))
        streamTextMock
            .mockImplementationOnce(() => workerResult('not valid JSON'))
            .mockImplementationOnce(() => workerResult(JSON.stringify(VALID_REVIEW)))

        await harness.service.runForQueue(REVIEW_ID, 'PR', PR_URL, USER_ID, harness.conn)

        expect(streamTextMock).toHaveBeenCalledTimes(2)
        expect(streamTextMock.mock.calls[1][0].temperature).toBe(0)
        expect(harness.events).toContainEqual(expect.objectContaining({ type: 'cluster_done', attempts: 2 }))
        expect(harness.events).toContainEqual(expect.objectContaining({ type: 'complete', outcome: 'complete' }))
        expect(harness.events.some((event) => event.type === 'synthesis_start')).toBe(false)
    })

    it('persists PARTIAL with exact unreviewed files after one cluster permanently fails', async () => {
        const harness = createHarness()
        const data = snapshot(7)
        data.files[0].filename = 'src/failing/always-fail.ts'
        harness.githubService.fetchPRSnapshot.mockResolvedValue(data)
        streamTextMock.mockImplementation((request) => {
            const prompt = String(request.messages?.[0]?.content)
            return workerResult(prompt.includes('always-fail.ts') ? 'invalid output' : JSON.stringify(VALID_REVIEW))
        })

        await harness.service.runForQueue(REVIEW_ID, 'PR', PR_URL, USER_ID, harness.conn)

        const plan = harness.events.find((event) => event.type === 'cluster_plan')
        const failedEvent = harness.events.find((event) => event.type === 'cluster_failed')
        expect(plan?.type).toBe('cluster_plan')
        expect(failedEvent?.type).toBe('cluster_failed')
        const failedFiles = plan?.type === 'cluster_plan' && failedEvent?.type === 'cluster_failed'
            ? plan.clusters.find((cluster) => cluster.id === failedEvent.clusterId)?.files.map((item) => item.name).sort()
            : undefined
        const savedReview = harness.reviewRepository.saveReview.mock.calls[0][2] as ReviewData
        expect(savedReview.coverage?.unreviewedFiles).toEqual(failedFiles)
        expect(savedReview.coverage?.failedClusters).toEqual([failedEvent?.type === 'cluster_failed' ? failedEvent.clusterId : ''])
        expect(harness.reviewRepository.saveReview.mock.calls[0][6]).toBe('partial')
        expect(harness.events.at(-1)).toEqual(expect.objectContaining({ type: 'complete', outcome: 'partial' }))
        expect(harness.events.some((event) => event.type === 'synthesis_start')).toBe(true)
    })

    it('fails atomically with one terminal event when all workers fail', async () => {
        const harness = createHarness()
        harness.githubService.fetchPRSnapshot.mockResolvedValue(snapshot(7))
        streamTextMock.mockImplementation(() => workerResult('invalid output'))

        await harness.service.runForQueue(REVIEW_ID, 'PR', PR_URL, USER_ID, harness.conn)

        expect(harness.events.filter((event) => event.type === 'cluster_failed')).toHaveLength(2)
        expect(harness.events.filter((event) => event.type === 'error')).toHaveLength(1)
        expect(harness.events.filter((event) => event.type === 'complete')).toHaveLength(0)
        expect(harness.reviewRepository.markFailed).toHaveBeenCalledTimes(1)
        expect(harness.reviewRepository.saveReview).not.toHaveBeenCalled()
    })

    it('discloses truncated context while remaining COMPLETE when its worker succeeds', async () => {
        const harness = createHarness()
        const data = snapshot(1)
        data.files[0] = file('src/large.ts', 20_000)
        harness.githubService.fetchPRSnapshot.mockResolvedValue(data)

        await harness.service.runForQueue(REVIEW_ID, 'PR', PR_URL, USER_ID, harness.conn)

        const prompt = String(streamTextMock.mock.calls[0][0].messages?.[0]?.content)
        const savedReview = harness.reviewRepository.saveReview.mock.calls[0][2] as ReviewData
        expect(prompt).toContain('additional diff hunks omitted')
        expect(savedReview.coverage?.truncatedFiles).toEqual(['src/large.ts'])
        expect(savedReview.coverage?.unreviewedFiles).toEqual([])
        expect(harness.reviewRepository.saveReview.mock.calls[0][6]).toBe('complete')
    })

    it('fails a binary-only PR before planner or worker invocation', async () => {
        const harness = createHarness()
        const data = snapshot(1)
        data.files[0] = { ...data.files[0], patch: undefined, patchState: 'binary' }
        harness.githubService.fetchPRSnapshot.mockResolvedValue(data)

        await harness.service.runForQueue(REVIEW_ID, 'PR', PR_URL, USER_ID, harness.conn)

        expect(generateObjectMock).not.toHaveBeenCalled()
        expect(streamTextMock).not.toHaveBeenCalled()
        expect(harness.reviewRepository.markFailed).toHaveBeenCalledWith(
            REVIEW_ID,
            expect.stringMatching(/no usable text diff/i),
            expect.any(Array),
        )
    })

    it('keeps the complete worker prompt within 40,000 characters and does not mutate snapshot state', async () => {
        const harness = createHarness()
        const data = snapshot(12)
        data.files = data.files.map((item, index) => file(`src/domain/file-${index}.ts`, 20_000))
        const originalStates = data.files.map((item) => item.patchState)
        harness.githubService.fetchPRSnapshot.mockResolvedValue(data)

        await harness.service.runForQueue(REVIEW_ID, 'PR', PR_URL, USER_ID, harness.conn)

        for (const [request] of streamTextMock.mock.calls) {
            expect(String(request.system).length + String(request.messages?.[0]?.content).length).toBeLessThanOrEqual(40_000)
        }
        expect(data.files.map((item) => item.patchState)).toEqual(originalStates)
    })
})
