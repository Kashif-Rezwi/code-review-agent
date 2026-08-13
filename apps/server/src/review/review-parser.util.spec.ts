import { InternalServerErrorException } from '@nestjs/common';

import { parseReviewFromSteps, parseReviewText } from './review-parser.util';

const validReview = {
  summary: 'The change is safe and well scoped.',
  score: 8,
  issues: [
    {
      type: 'suggestion' as const,
      severity: 'info' as const,
      title: 'Add a regression test',
      location: 'src/example.ts:10',
      description: 'The new branch is not covered.',
      recommendation: 'Exercise the new branch in a focused test.',
    },
  ],
  positives: ['Clear naming'],
};

describe('parseReviewText', () => {
  it('parses a clean review JSON object', () => {
    expect(parseReviewText(JSON.stringify(validReview))).toEqual(validReview);
  });

  it('extracts fenced review JSON surrounded by model prose', () => {
    const text = [
      'I reviewed the supplied changes.',
      '```json',
      JSON.stringify(validReview, null, 2),
      '```',
      'Let me know if you want more detail.',
    ].join('\n');

    expect(parseReviewText(text)).toEqual(validReview);
  });

  it('ignores braces inside JSON string values when extracting a review', () => {
    const review = {
      ...validReview,
      summary: 'The object shape { key: "value" } remains compatible.',
    };
    const text = `Analysis before the result.\n${JSON.stringify(review)}\nTrailing prose with } braces.`;

    expect(parseReviewText(text)).toEqual(review);
  });

  it('rejects a GitHub-access refusal instead of treating prose as a review', () => {
    const refusal =
      "I'm unable to access external websites, including GitHub. " +
      'Please provide the code diffs or specific changes made in the pull request.';

    expect(() => parseReviewText(refusal)).toThrow(
      InternalServerErrorException,
    );
    expect(() => parseReviewText(refusal)).toThrow(
      'The model did not return a valid review. Please try again.',
    );
  });
});

describe('parseReviewFromSteps', () => {
  it('prefers the final text when it parses', () => {
    expect(parseReviewFromSteps(JSON.stringify(validReview), [{ text: 'garbage' }])).toEqual(validReview);
  });

  it('falls back to the most recent parseable step text', () => {
    const steps = [{ text: 'early prose' }, { text: JSON.stringify(validReview) }];
    expect(parseReviewFromSteps('', steps)).toEqual(validReview);
  });

  it('throws when neither the final text nor any step parses', () => {
    expect(() => parseReviewFromSteps('nope', [{ text: 'still nope' }])).toThrow(
      'The model did not return a valid review. Please try again.',
    );
  });
});
