import { describe, expect, it } from 'vitest';
import { GhClient, type GhExec, type GhExecResult } from '../src/core/gh.js';

const REPO = 'octo-org/hello-world';
const PR_FIELDS =
  'number,url,title,state,isDraft,headRefOid,headRefName,reviewDecision,mergedAt,closedAt,comments,reviews,updatedAt';

function ok(stdout: string): GhExecResult {
  return { stdout, stderr: '', code: 0 };
}

function fakeExec(responses: GhExecResult[]): { exec: GhExec; calls: string[][] } {
  const calls: string[][] = [];
  const queue = [...responses];
  const exec: GhExec = async (args) => {
    calls.push(args);
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(`unexpected gh invocation: ${args.join(' ')}`);
    }
    return next;
  };
  return { exec, calls };
}

const NOW = new Date('2026-02-01T00:00:00.000Z');

const VIEW = JSON.stringify({
  number: 7,
  url: 'https://example.com/pull/7',
  title: 'Add feature',
  state: 'MERGED',
  isDraft: false,
  headRefOid: 'c'.repeat(40),
  headRefName: 'feature',
  reviewDecision: 'APPROVED',
  updatedAt: '2026-01-06T00:00:00Z',
  mergedAt: '2026-01-05T00:00:00Z',
  closedAt: '2026-01-05T00:00:00Z',
  comments: [{ id: 'IC_1', author: { login: 'alice' }, createdAt: '2026-01-02T00:00:00Z', url: 'https://example.com/c1', body: 'x' }],
  reviews: [
    { id: 'PRR_1', author: { login: 'bob' }, state: 'APPROVED', submittedAt: '2026-01-03T00:00:00Z' },
    { id: 'PRR_2', author: { login: 'carol' }, state: 'PENDING', submittedAt: null },
  ],
});

const INLINE = [
  JSON.stringify({ id: 101, author: 'dave', createdAt: '2026-01-04T00:00:00Z', path: 'src/a.ts', url: 'https://example.com/r101' }),
  '',
  JSON.stringify({ id: 102, author: 'erin', createdAt: '2026-01-04T01:00:00Z', path: null, url: 'https://example.com/r102' }),
].join('\n');

describe('GhClient.prSnapshot', () => {
  it('runs pr view and the paginated review comments through the executor', async () => {
    const { exec, calls } = fakeExec([ok(VIEW), ok(INLINE)]);
    const client = new GhClient({ exec, now: () => NOW });
    const snapshot = await client.prSnapshot(REPO, 7);
    expect(calls[0]).toEqual(['pr', 'view', '7', '--repo', REPO, '--json', PR_FIELDS]);
    expect(calls[1]?.slice(0, 3)).toEqual(['api', `repos/${REPO}/pulls/7/comments`, '--paginate']);
    expect(calls[1]?.[3]).toBe('--jq');
    expect(snapshot).toEqual({
      number: 7,
      url: 'https://example.com/pull/7',
      title: 'Add feature',
      state: 'MERGED',
      isDraft: false,
      headSha: 'c'.repeat(40),
      headRef: 'feature',
      reviewDecision: 'APPROVED',
      mergedAt: '2026-01-05T00:00:00Z',
      closedAt: '2026-01-05T00:00:00Z',
      updatedAt: '2026-01-06T00:00:00Z',
      comments: [{ id: 'IC_1', author: 'alice', createdAt: '2026-01-02T00:00:00Z', url: 'https://example.com/c1' }],
      reviews: [{ id: 'PRR_1', author: 'bob', state: 'APPROVED', submittedAt: '2026-01-03T00:00:00Z' }],
      reviewComments: [
        { id: '101', author: 'dave', createdAt: '2026-01-04T00:00:00Z', path: 'src/a.ts', url: 'https://example.com/r101' },
        { id: '102', author: 'erin', createdAt: '2026-01-04T01:00:00Z', url: 'https://example.com/r102' },
      ],
      checkedAt: '2026-02-01T00:00:00.000Z',
    });
  });

  it('normalises missing fields defensively', async () => {
    const { exec } = fakeExec([ok(JSON.stringify({ number: 3 })), ok('')]);
    const snapshot = await new GhClient({ exec, now: () => NOW }).prSnapshot(REPO, 3);
    expect(snapshot).toEqual({
      number: 3,
      url: '',
      title: '',
      state: 'OPEN',
      isDraft: false,
      headSha: '',
      headRef: '',
      reviewDecision: null,
      comments: [],
      reviews: [],
      reviewComments: [],
      checkedAt: '2026-02-01T00:00:00.000Z',
    });
  });

  it('treats an empty review decision as none', async () => {
    const { exec } = fakeExec([ok(JSON.stringify({ number: 3, reviewDecision: '' })), ok('')]);
    expect((await new GhClient({ exec }).prSnapshot(REPO, 3)).reviewDecision).toBeNull();
  });

  it('fails with the gh message when pr view fails', async () => {
    const { exec } = fakeExec([{ stdout: '', stderr: 'no pull requests found', code: 1 }]);
    await expect(new GhClient({ exec }).prSnapshot(REPO, 9)).rejects.toThrow(/gh pr view 9 failed: no pull requests found/);
  });

  it('fails on malformed inline comment output', async () => {
    const { exec } = fakeExec([ok(VIEW), ok('not json')]);
    await expect(new GhClient({ exec }).prSnapshot(REPO, 7)).rejects.toThrow(/malformed output/);
  });
});

describe('GhClient.prSnapshot reuse', () => {
  const stub = [{ id: '101', author: 'dave', createdAt: 't', url: 'u' }];

  it('skips the inline comments call when updatedAt is unchanged', async () => {
    const { exec, calls } = fakeExec([ok(VIEW)]);
    const snapshot = await new GhClient({ exec }).prSnapshot(REPO, 7, {
      updatedAt: '2026-01-06T00:00:00Z',
      reviewComments: stub,
    });
    expect(calls).toHaveLength(1);
    expect(snapshot.reviewComments).toEqual(stub);
  });

  it('fetches the inline comments again when updatedAt changed', async () => {
    const { exec, calls } = fakeExec([ok(VIEW), ok(INLINE)]);
    const snapshot = await new GhClient({ exec }).prSnapshot(REPO, 7, {
      updatedAt: '2026-01-01T00:00:00Z',
      reviewComments: stub,
    });
    expect(calls).toHaveLength(2);
    expect(snapshot.reviewComments).toHaveLength(2);
  });

  it('never reuses when the view has no updatedAt', async () => {
    const { exec, calls } = fakeExec([ok(JSON.stringify({ number: 3 })), ok('')]);
    await new GhClient({ exec }).prSnapshot(REPO, 3, { updatedAt: '', reviewComments: stub });
    expect(calls).toHaveLength(2);
  });
});

describe('GhClient.findPrForBranch', () => {
  it('returns the newest pull request number', async () => {
    const { exec, calls } = fakeExec([
      ok(
        JSON.stringify([
          { number: 4, createdAt: '2026-01-01T00:00:00Z' },
          { number: 9, createdAt: '2026-01-03T00:00:00Z' },
          { number: 6, createdAt: '2026-01-02T00:00:00Z' },
        ]),
      ),
    ]);
    expect(await new GhClient({ exec }).findPrForBranch(REPO, 'feature')).toBe(9);
    expect(calls[0]).toEqual([
      'pr', 'list', '--repo', REPO, '--head', 'feature', '--state', 'all', '--limit', '5', '--json', 'number,createdAt',
    ]);
  });

  it('returns undefined when there is none', async () => {
    const { exec } = fakeExec([ok('[]')]);
    expect(await new GhClient({ exec }).findPrForBranch(REPO, 'feature')).toBeUndefined();
  });
});
