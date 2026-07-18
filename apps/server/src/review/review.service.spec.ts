import { BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { streamText } from 'ai';
import type { ReviewStreamEvent } from '@cra/types';

import { AiService } from '../ai/ai.service';
import { GithubService } from '../github/github.service';
import { LinterService } from '../linter/linter.service';
import { QueueService } from '../queue/queue.service';
import { RedisService } from '../queue/redis.service';
import { RagService } from '../rag/rag.service';
import { ReviewRepository } from './review.repository';
import { ReviewService } from './review.service';
import type { SseConnection } from './review.sse';

jest.mock('ai', () => ({
  generateText: jest.fn(),
  streamText: jest.fn(),
}));

const PR_URL = 'https://github.com/vercel/next.js/pull/91191';
const REVIEW_ID = 'review-123';
const USER_ID = 'user-123';
const UNIFIED_DIFF = [
  'diff --git a/src/example.ts b/src/example.ts',
  '--- a/src/example.ts',
  '+++ b/src/example.ts',
  '@@ -1 +1 @@',
  '-const enabled = false',
  '+const enabled = true',
].join('\n');
const VALID_REVIEW = {
  summary: 'The change is small and safe.',
  score: 8,
  issues: [],
  positives: ['The intent is clear.'],
};

const streamTextMock = streamText as jest.MockedFunction<typeof streamText>;

interface Harness {
  service: ReviewService;
  conn: SseConnection;
  events: ReviewStreamEvent[];
  operations: string[];
  githubService: {
    assertValidPRUrl: jest.Mock;
    fetchPRFiles: jest.Mock;
    fetchPRDiff: jest.Mock;
  };
  reviewRepository: {
    saveReview: jest.Mock;
    markFailed: jest.Mock;
  };
}

function mockModelText(text: string): void {
  streamTextMock.mockReturnValue({
    text: Promise.resolve(text),
    steps: Promise.resolve([{ text }]),
  } as unknown as ReturnType<typeof streamText>);
}

function createHarness(): Harness {
  const events: ReviewStreamEvent[] = [];
  const operations: string[] = [];
  const conn: SseConnection = {
    startedAt: Date.now(),
    send: (event) => {
      events.push(event);
      operations.push(`send:${event.type}`);
    },
    getTrace: () => events,
  };
  const reviewRepository = {
    createSession: jest.fn(),
    saveReview: jest.fn().mockImplementation(() => {
      operations.push('save');
      return Promise.resolve(REVIEW_ID);
    }),
    markFailed: jest.fn().mockImplementation(() => {
      operations.push('markFailed');
      return Promise.resolve(true);
    }),
    markCancelled: jest.fn(),
  };
  const githubService = {
    assertValidPRUrl: jest.fn(),
    fetchPRFiles: jest.fn(),
    fetchPRDiff: jest.fn(),
    fetchFileContent: jest.fn(),
  };
  const ragService = {
    retrieveForContext: jest.fn().mockResolvedValue(null),
  };
  const aiService = {
    defaultModel: { modelId: 'test-model' },
    provider: jest.fn(),
  };

  const service = new ReviewService(
    {} as ConfigService,
    reviewRepository as unknown as ReviewRepository,
    githubService as unknown as GithubService,
    { lint: jest.fn() } as unknown as LinterService,
    ragService as unknown as RagService,
    aiService as unknown as AiService,
    { enqueue: jest.fn(), removeJob: jest.fn() } as unknown as QueueService,
    { emitEvent: jest.fn() } as unknown as RedisService,
  );

  return {
    service,
    conn,
    events,
    operations,
    githubService,
    reviewRepository,
  };
}

describe('ReviewService PR acquisition and terminal-state handling', () => {
  beforeEach(() => {
    streamTextMock.mockReset();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('supplies a real unified diff to the model when the file-list request fails and persists before completing', async () => {
    const harness = createHarness();
    harness.githubService.fetchPRFiles.mockRejectedValue(
      new Error('file list unavailable'),
    );
    harness.githubService.fetchPRDiff.mockResolvedValue(UNIFIED_DIFF);
    mockModelText(JSON.stringify(VALID_REVIEW));

    await harness.service.runForQueue(
      REVIEW_ID,
      'PR',
      PR_URL,
      USER_ID,
      harness.conn,
    );

    expect(streamTextMock).toHaveBeenCalledTimes(1);
    const request = streamTextMock.mock.calls[0][0];
    const modelMessage = request.messages?.[0];
    expect(modelMessage?.role).toBe('user');
    expect(modelMessage?.content).toEqual(
      expect.stringContaining(UNIFIED_DIFF),
    );
    expect(modelMessage?.content).toEqual(
      expect.stringContaining('<pull_request_diff>'),
    );
    expect(modelMessage?.content).not.toMatch(
      /^\s*https:\/\/github\.com\/[^\s]+\s*$/,
    );

    expect(harness.reviewRepository.markFailed).not.toHaveBeenCalled();
    expect(harness.reviewRepository.saveReview).toHaveBeenCalledTimes(1);
    expect(harness.operations.indexOf('save')).toBeLessThan(
      harness.operations.indexOf('send:complete'),
    );
    expect(
      harness.events.filter((event) => event.type === 'complete'),
    ).toHaveLength(1);
    expect(
      harness.events.filter((event) => event.type === 'error'),
    ).toHaveLength(0);

    const saveCall = harness.reviewRepository.saveReview.mock
      .calls[0] as unknown as Parameters<ReviewRepository['saveReview']>;
    const persistedTrace = saveCall[4] ?? [];
    expect(persistedTrace.at(-1)).toMatchObject({ type: 'complete' });
  });

  it('does not invoke the model and records exactly one terminal failure when both GitHub acquisitions fail', async () => {
    const harness = createHarness();
    harness.githubService.fetchPRFiles.mockRejectedValue(
      new Error('file list unavailable'),
    );
    harness.githubService.fetchPRDiff.mockRejectedValue(
      new BadRequestException('GitHub PR is not accessible'),
    );

    await harness.service.runForQueue(
      REVIEW_ID,
      'PR',
      PR_URL,
      USER_ID,
      harness.conn,
    );

    expect(streamTextMock).not.toHaveBeenCalled();
    expect(harness.reviewRepository.saveReview).not.toHaveBeenCalled();
    expect(harness.reviewRepository.markFailed).toHaveBeenCalledTimes(1);
    expect(harness.reviewRepository.markFailed).toHaveBeenCalledWith(
      REVIEW_ID,
      'GitHub PR is not accessible',
      [
        { type: 'start' },
        { type: 'error', message: 'GitHub PR is not accessible' },
      ],
    );

    const terminalEvents = harness.events.filter(
      (event) => event.type === 'complete' || event.type === 'error',
    );
    expect(terminalEvents).toEqual([
      { type: 'error', message: 'GitHub PR is not accessible' },
    ]);
  });

  it('uses unified diff fallback when GitHub returns files without reviewable patches', async () => {
    const harness = createHarness();
    harness.githubService.fetchPRFiles.mockResolvedValue([
      {
        filename: 'assets/large-binary.dat',
        status: 'modified',
        additions: 0,
        deletions: 0,
      },
    ]);
    harness.githubService.fetchPRDiff.mockResolvedValue(UNIFIED_DIFF);
    mockModelText(JSON.stringify(VALID_REVIEW));

    await harness.service.runForQueue(
      REVIEW_ID,
      'PR',
      PR_URL,
      USER_ID,
      harness.conn,
    );

    expect(harness.githubService.fetchPRDiff).toHaveBeenCalledWith(PR_URL);
    expect(streamTextMock.mock.calls[0][0].messages?.[0]?.content).toEqual(
      expect.stringContaining(UNIFIED_DIFF),
    );
  });

  it('marks the review failed when the model output is not a valid review', async () => {
    const harness = createHarness();
    harness.githubService.fetchPRFiles.mockRejectedValue(
      new Error('file list unavailable'),
    );
    harness.githubService.fetchPRDiff.mockResolvedValue(UNIFIED_DIFF);
    mockModelText("I'm unable to access external websites, including GitHub.");

    await harness.service.runForQueue(
      REVIEW_ID,
      'PR',
      PR_URL,
      USER_ID,
      harness.conn,
    );

    const expectedMessage =
      'The model did not return a valid review. Please try again.';
    expect(harness.reviewRepository.saveReview).not.toHaveBeenCalled();
    expect(harness.reviewRepository.markFailed).toHaveBeenCalledTimes(1);
    expect(harness.reviewRepository.markFailed).toHaveBeenCalledWith(
      REVIEW_ID,
      expectedMessage,
      [{ type: 'start' }, { type: 'error', message: expectedMessage }],
    );
    expect(harness.events.filter((event) => event.type === 'error')).toEqual([
      { type: 'error', message: expectedMessage },
    ]);
  });

  it('does not expose unexpected persistence details to SSE clients or history', async () => {
    const harness = createHarness();
    harness.githubService.fetchPRFiles.mockRejectedValue(
      new Error('file list unavailable'),
    );
    harness.githubService.fetchPRDiff.mockResolvedValue(UNIFIED_DIFF);
    mockModelText(JSON.stringify(VALID_REVIEW));
    harness.reviewRepository.saveReview.mockRejectedValue(
      new Error('database at postgresql://private-host failed'),
    );

    await harness.service.runForQueue(
      REVIEW_ID,
      'PR',
      PR_URL,
      USER_ID,
      harness.conn,
    );

    const publicMessage = 'Review failed unexpectedly. Please try again.';
    expect(harness.reviewRepository.markFailed).toHaveBeenCalledWith(
      REVIEW_ID,
      publicMessage,
      expect.arrayContaining([{ type: 'error', message: publicMessage }]),
    );
    expect(harness.events.at(-1)).toEqual({
      type: 'error',
      message: publicMessage,
    });
    expect(JSON.stringify(harness.events)).not.toContain('private-host');
  });
});
