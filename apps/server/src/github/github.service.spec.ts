import { BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { GithubCacheService } from './github-cache.service';
import { GithubService } from './github.service';

const PR_URL = 'https://github.com/vercel/next.js/pull/91191';
const FILES_API_URL =
  'https://api.github.com/repos/vercel/next.js/pulls/91191/files?per_page=100';
const PR_API_URL = 'https://api.github.com/repos/vercel/next.js/pulls/91191';
const DIRECT_DIFF_URL = 'https://github.com/vercel/next.js/pull/91191.diff';

const changedFile = {
  filename: 'packages/next/src/example.ts',
  status: 'modified',
  additions: 3,
  deletions: 1,
  patch: '@@ -1,1 +1,3 @@',
};

function createService(token?: string): GithubService {
  const config = {
    get: jest.fn((key: string) => (key === 'GITHUB_TOKEN' ? token : undefined)),
  } as unknown as ConfigService;

  return new GithubService(config, new GithubCacheService());
}

function response(
  body: string,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers });
}

describe('GithubService public fallback', () => {
  let fetchSpy: jest.SpiedFunction<typeof fetch>;
  let warnSpy: jest.SpiedFunction<Logger['warn']>;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([401, 403, 429])(
    'retries the file-list request without credentials after authenticated HTTP %i',
    async (status) => {
      fetchSpy
        .mockResolvedValueOnce(
          response('{"message":"authentication failed"}', status),
        )
        .mockResolvedValueOnce(
          response(JSON.stringify([changedFile]), 200, {
            'content-type': 'application/json',
          }),
        );

      await expect(
        createService('configured-token').fetchPRFiles(PR_URL),
      ).resolves.toEqual([changedFile]);

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fetchSpy.mock.calls[0]?.[0]).toBe(FILES_API_URL);
      expect(
        new Headers(fetchSpy.mock.calls[0]?.[1]?.headers).get('Authorization'),
      ).toBe('Bearer configured-token');
      expect(fetchSpy.mock.calls[1]?.[0]).toBe(FILES_API_URL);
      expect(
        new Headers(fetchSpy.mock.calls[1]?.[1]?.headers).get('Authorization'),
      ).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
    },
  );

  it('preserves the authenticated 401 error when the public file-list fallback also fails', async () => {
    fetchSpy
      .mockResolvedValueOnce(response('{"message":"Bad credentials"}', 401))
      .mockResolvedValueOnce(response('{"message":"Not Found"}', 404));

    const result = createService('expired-token').fetchPRFiles(PR_URL);

    await expect(result).rejects.toBeInstanceOf(BadRequestException);
    await expect(result).rejects.toThrow(
      /token.*invalid|invalid.*token|expired/i,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('preserves an authenticated rate-limit error when the public file-list fallback fails', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        response('{"message":"API rate limit exceeded"}', 403, {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '1784304000',
        }),
      )
      .mockResolvedValueOnce(response('{"message":"Not Found"}', 404));

    await expect(
      createService('limited-token').fetchPRFiles(PR_URL),
    ).rejects.toThrow(/rate limit/i);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('treats a whitespace-only token as absent', async () => {
    fetchSpy.mockResolvedValueOnce(
      response(JSON.stringify([changedFile]), 200, {
        'content-type': 'application/json',
      }),
    );

    await expect(createService('   ').fetchPRFiles(PR_URL)).resolves.toEqual([
      changedFile,
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(
      new Headers(fetchSpy.mock.calls[0]?.[1]?.headers).get('Authorization'),
    ).toBeNull();
  });

  it.each([401, 403, 429])(
    'falls back from authenticated diff HTTP %i to the public .diff endpoint',
    async (status) => {
      const diff = 'diff --git a/a.ts b/a.ts\n+const fixed = true\n';
      fetchSpy
        .mockResolvedValueOnce(
          response('{"message":"authentication failed"}', status),
        )
        .mockResolvedValueOnce(
          response(diff, 200, { 'content-type': 'text/plain' }),
        );

      await expect(
        createService('configured-token').fetchPRDiff(PR_URL),
      ).resolves.toBe(diff);

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fetchSpy.mock.calls[0]?.[0]).toBe(PR_API_URL);
      expect(
        new Headers(fetchSpy.mock.calls[0]?.[1]?.headers).get('Authorization'),
      ).toBe('Bearer configured-token');
      expect(
        new Headers(fetchSpy.mock.calls[0]?.[1]?.headers).get('Accept'),
      ).toBe('application/vnd.github.diff');
      expect(fetchSpy.mock.calls[1]?.[0]).toBe(DIRECT_DIFF_URL);
      expect(
        new Headers(fetchSpy.mock.calls[1]?.[1]?.headers).get('Authorization'),
      ).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
    },
  );

  it('preserves the authenticated diff error when the public .diff fallback also fails', async () => {
    fetchSpy
      .mockResolvedValueOnce(response('{"message":"Bad credentials"}', 401))
      .mockResolvedValueOnce(response('Not Found', 404));

    await expect(
      createService('expired-token').fetchPRDiff(PR_URL),
    ).rejects.toThrow(/token.*invalid|invalid.*token|expired/i);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('rejects an HTML page returned in place of a public diff', async () => {
    fetchSpy.mockResolvedValueOnce(
      response('<!doctype html><title>Sign in</title>', 200, {
        'content-type': 'text/html',
      }),
    );

    await expect(createService().fetchPRDiff(PR_URL)).rejects.toThrow(
      /private|inaccessible/i,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
