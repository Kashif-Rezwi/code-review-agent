import type { Job } from 'bullmq';

import type { ReviewJobPayload } from '../queue/queue.service';
import { RedisService } from '../queue/redis.service';
import { ReviewProcessor } from './review.processor';
import { ReviewRepository } from './review.repository';
import { ReviewService } from './review.service';

const REVIEW_ID = 'review-123';

function createJob(): Job<ReviewJobPayload> {
  return {
    data: {
      reviewId: REVIEW_ID,
      type: 'PR',
      input: 'https://github.com/owner/repository/pull/42',
      userId: 'user-123',
    },
  } as unknown as Job<ReviewJobPayload>;
}

describe('ReviewProcessor failed-job terminal signaling', () => {
  let processor: ReviewProcessor;
  let reviewRepository: { markFailed: jest.Mock };
  let redisService: { emitEvent: jest.Mock };

  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    reviewRepository = { markFailed: jest.fn() };
    redisService = { emitEvent: jest.fn().mockResolvedValue(undefined) };
    processor = new ReviewProcessor(
      {} as ReviewService,
      redisService as unknown as RedisService,
      reviewRepository as unknown as ReviewRepository,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('emits a Redis error when the database transitions the review to FAILED', async () => {
    reviewRepository.markFailed.mockResolvedValue(true);

    await processor.onFailed(createJob(), new Error('worker crashed'));

    expect(reviewRepository.markFailed).toHaveBeenCalledWith(
      REVIEW_ID,
      'Background review worker failed. Please try again.',
    );
    expect(redisService.emitEvent).toHaveBeenCalledWith(
      REVIEW_ID,
      JSON.stringify({
        type: 'error',
        message: 'Background review worker failed. Please try again.',
      }),
    );
  });

  it('emits nothing when the review is already terminal or cancelled', async () => {
    reviewRepository.markFailed.mockResolvedValue(false);

    await processor.onFailed(createJob(), new Error('late worker failure'));

    expect(redisService.emitEvent).not.toHaveBeenCalled();
  });

  it('still emits a terminal Redis error when failure persistence rejects', async () => {
    const persistenceError = new Error('database unavailable');
    const consoleError = jest.mocked(console.error);
    reviewRepository.markFailed.mockRejectedValue(persistenceError);

    await processor.onFailed(createJob(), new Error('worker crashed'));

    expect(consoleError).toHaveBeenCalledWith(
      'Failed to persist terminal failure state',
      persistenceError,
    );
    expect(redisService.emitEvent).toHaveBeenCalledWith(
      REVIEW_ID,
      JSON.stringify({
        type: 'error',
        message: 'Background review worker failed. Please try again.',
      }),
    );
  });
});
