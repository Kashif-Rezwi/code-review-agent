import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { ReviewData } from '@cra/ai';

import { PrismaService } from '../prisma/prisma.service';
import { ReviewRepository } from './review.repository';

type ReviewDelegateMock = {
  create: jest.Mock;
  update: jest.Mock;
  updateMany: jest.Mock;
};

const reviewData: ReviewData = {
  summary: 'The change is safe and well scoped.',
  score: 8,
  issues: [
    {
      type: 'suggestion',
      severity: 'info',
      title: 'Add a regression test',
      location: 'src/example.ts:10',
      description: 'The new branch is not covered.',
      recommendation: 'Exercise the new branch in a focused test.',
    },
  ],
  positives: ['Clear naming'],
};

describe('ReviewRepository terminal state transitions', () => {
  let review: ReviewDelegateMock;
  let reviewDispatch: { create: jest.Mock; updateMany: jest.Mock };
  let repository: ReviewRepository;

  beforeEach(() => {
    review = {
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    };
    const config = {
      get: jest.fn().mockReturnValue('postgresql://configured'),
    } as unknown as ConfigService;
    reviewDispatch = {
      create: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    const prisma = {
      review,
      reviewDispatch,
      $transaction: jest.fn((callback: (transaction: unknown) => unknown) =>
        Promise.resolve(callback({ review, reviewDispatch })),
      ),
    } as unknown as PrismaService;

    repository = new ReviewRepository(config, prisma);
  });

  it('creates the review and dispatch intent in the same transaction', async () => {
    review.create.mockResolvedValue({
      id: 'review-1',
      type: 'PR',
      input: 'https://github.com/acme/repo/pull/1',
      userId: 'user-1',
      status: 'PENDING',
    });
    reviewDispatch.create.mockResolvedValue({ id: 'dispatch-1' });

    await expect(repository.createSession('PR', 'https://github.com/acme/repo/pull/1', 'user-1'))
      .resolves.toMatchObject({ id: 'review-1' });
    expect(review.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        type: 'PR',
        input: 'https://github.com/acme/repo/pull/1',
        status: 'PENDING',
      },
    });
    expect(reviewDispatch.create).toHaveBeenCalledWith({ data: { reviewId: 'review-1' } });
  });

  describe('markFailed', () => {
    it('updates only a PENDING review and returns true when the transition wins', async () => {
      review.updateMany.mockResolvedValue({ count: 1 });
      const traceLog = [{ type: 'start' as const }];

      await expect(
        repository.markFailed('review-1', 'GitHub fetch failed', traceLog),
      ).resolves.toBe(true);
      expect(review.updateMany).toHaveBeenCalledWith({
        where: { id: 'review-1', status: 'PENDING' },
        data: {
          status: 'FAILED',
          summary: 'GitHub fetch failed',
          traceLog,
        },
      });
    });

    it('returns false when the review is already terminal', async () => {
      review.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        repository.markFailed('review-1', 'late failure'),
      ).resolves.toBe(false);
      expect(review.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'review-1', status: 'PENDING' },
        }),
      );
    });
  });

  describe('markCancelled', () => {
    it.each([
      [1, true],
      [0, false],
    ])(
      'updates only PENDING and maps count %i to %s',
      async (count, expected) => {
        review.updateMany.mockResolvedValue({ count });

        await expect(repository.markCancelled('review-1')).resolves.toBe(
          expected,
        );
        expect(review.updateMany).toHaveBeenCalledWith({
          where: { id: 'review-1', status: 'PENDING' },
          data: { status: 'CANCELLED' },
        });
      },
    );
  });

  describe('saveReview', () => {
    it('completes an existing review only while it is PENDING', async () => {
      review.update.mockResolvedValue({ id: 'review-1' });

      await expect(
        repository.saveReview(
          'input',
          'PR',
          reviewData,
          'user-1',
          undefined,
          'review-1',
        ),
      ).resolves.toBe('review-1');
      expect(review.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'review-1', status: 'PENDING' },
          data: expect.objectContaining({ status: 'COMPLETE' }),
        }),
      );
    });

    it('atomically persists PARTIAL status and coverage on a pending review', async () => {
      review.update.mockResolvedValue({ id: 'review-1' });
      const partialData: ReviewData = {
        ...reviewData,
        coverage: {
          totalFiles: 4,
          assignedFiles: 4,
          reviewedFiles: 2,
          truncatedFiles: [],
          metadataOnlyFiles: [],
          unreviewedFiles: ['src/c.ts', 'src/d.ts'],
          failedClusters: ['review-group-2'],
          acquisitionSource: 'public_diff',
        },
      };

      await expect(
        repository.saveReview(
          'input',
          'PR',
          partialData,
          'user-1',
          undefined,
          'review-1',
          'partial',
        ),
      ).resolves.toBe('review-1');

      expect(review.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'review-1', status: 'PENDING' },
          data: expect.objectContaining({
            status: 'PARTIAL',
            coverage: partialData.coverage,
          }),
        }),
      );
    });

    it('returns undefined when a terminal review causes Prisma P2025', async () => {
      review.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Record not found', {
          code: 'P2025',
          clientVersion: 'test',
        }),
      );

      await expect(
        repository.saveReview(
          'input',
          'PR',
          reviewData,
          'user-1',
          undefined,
          'review-1',
        ),
      ).resolves.toBeUndefined();
    });

    it('propagates unexpected Prisma write failures', async () => {
      const writeError = new Error('database unavailable');
      review.update.mockRejectedValue(writeError);

      await expect(
        repository.saveReview(
          'input',
          'PR',
          reviewData,
          'user-1',
          undefined,
          'review-1',
        ),
      ).rejects.toBe(writeError);
    });
  });
});
