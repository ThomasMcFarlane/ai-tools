import { PR_EVENT_KINDS } from './types.js';
import type { PrEvent, PrEventKind, PrLastState, PrReview, PrSnapshot, PrSummary } from './types.js';

/** The part of a snapshot a diff needs; a full snapshot satisfies it. */
export interface PrDiffBase {
  state: PrSnapshot['state'];
  isDraft: boolean;
  headSha: string;
  reviewDecision: string | null;
  comments: { id: string }[];
  reviews: { id: string }[];
  reviewComments: { id: string }[];
}

export interface ParsedKinds {
  kinds: PrEventKind[];
  /** True when `any` was given: every kind is wanted and initial state matching is skipped. */
  any: boolean;
}

export function isPrEventKind(value: string): value is PrEventKind {
  return (PR_EVENT_KINDS as readonly string[]).includes(value);
}

/** Parse a comma-separated kind list; `any` expands to every kind. */
export function parseEventKinds(input: string): ParsedKinds {
  const tokens = input
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    throw new Error(`invalid --on "${input}": give at least one of any, ${PR_EVENT_KINDS.join(', ')}`);
  }
  let any = false;
  const kinds: PrEventKind[] = [];
  for (const token of tokens) {
    if (token === 'any') {
      any = true;
    } else if (isPrEventKind(token)) {
      if (!kinds.includes(token)) {
        kinds.push(token);
      }
    } else {
      throw new Error(`invalid event kind "${token}": use any, ${PR_EVENT_KINDS.join(', ')}`);
    }
  }
  return any ? { kinds: [...PR_EVENT_KINDS], any: true } : { kinds, any: false };
}

function itemEvents(snapshot: PrSnapshot, previous: PrDiffBase | undefined, after?: number): PrEvent[] {
  const events: PrEvent[] = [];
  const known = (items: { id: string }[] | undefined): Set<string> => new Set((items ?? []).map((item) => item.id));
  const isNew = (seen: Set<string>, id: string, at: string): boolean =>
    after === undefined ? !seen.has(id) : Date.parse(at) > after;
  const seenComments = known(previous?.comments);
  const seenReviews = known(previous?.reviews);
  const seenReviewComments = known(previous?.reviewComments);
  for (const comment of snapshot.comments) {
    if (isNew(seenComments, comment.id, comment.createdAt)) {
      events.push({ kind: 'comment', at: comment.createdAt, author: comment.author, url: comment.url });
    }
  }
  for (const review of snapshot.reviews) {
    if (isNew(seenReviews, review.id, review.submittedAt)) {
      const event: PrEvent = { kind: 'review', at: review.submittedAt, author: review.author, reviewState: review.state };
      if (review.url !== undefined) {
        event.url = review.url;
      }
      events.push(event);
    }
  }
  for (const comment of snapshot.reviewComments) {
    if (isNew(seenReviewComments, comment.id, comment.createdAt)) {
      const event: PrEvent = { kind: 'review_comment', at: comment.createdAt, author: comment.author, url: comment.url };
      if (comment.path !== undefined) {
        event.path = comment.path;
      }
      events.push(event);
    }
  }
  return events.sort((left, right) => left.at.localeCompare(right.at));
}

/**
 * Events that happened between two snapshots of one pull request. An undefined `prev` means the
 * pull request did not exist before: the result is a single `opened`.
 */
export function diffPr(prev: PrDiffBase | undefined, next: PrSnapshot): PrEvent[] {
  if (prev === undefined) {
    return [{ kind: 'opened', at: next.checkedAt, url: next.url }];
  }
  const events: PrEvent[] = [];
  if (prev.state !== next.state) {
    if (next.state === 'MERGED') {
      events.push({ kind: 'merged', at: next.mergedAt ?? next.checkedAt });
    } else if (next.state === 'CLOSED') {
      events.push({ kind: 'closed', at: next.closedAt ?? next.checkedAt });
    } else {
      events.push({ kind: 'reopened', at: next.checkedAt });
    }
  } else if (next.state === 'OPEN' && prev.isDraft !== next.isDraft) {
    events.push({ kind: next.isDraft ? 'draft' : 'ready', at: next.checkedAt });
  }
  if (prev.headSha !== next.headSha) {
    events.push({ kind: 'push', at: next.checkedAt, from: prev.headSha, to: next.headSha });
  }
  if (prev.reviewDecision !== next.reviewDecision) {
    events.push({ kind: 'review_decision', at: next.checkedAt, from: prev.reviewDecision, to: next.reviewDecision });
  }
  events.push(...itemEvents(next, prev));
  return events;
}

/** Comments, reviews and inline comments created after `since`, even when already in an earlier snapshot. */
export function sinceEvents(snapshot: PrSnapshot, since: string): PrEvent[] {
  const after = Date.parse(since);
  if (Number.isNaN(after)) {
    throw new Error(`invalid time "${since}": use an ISO 8601 timestamp`);
  }
  return itemEvents(snapshot, undefined, after);
}

/** The state kinds the pull request currently is in. */
export function stateEvents(snapshot: PrSnapshot): PrEvent[] {
  if (snapshot.state === 'MERGED') {
    return [{ kind: 'merged', at: snapshot.mergedAt ?? snapshot.checkedAt }];
  }
  if (snapshot.state === 'CLOSED') {
    return [{ kind: 'closed', at: snapshot.closedAt ?? snapshot.checkedAt }];
  }
  const at = snapshot.checkedAt;
  return [{ kind: 'opened', at }, { kind: snapshot.isDraft ? 'draft' : 'ready', at }];
}

export function summarisePr(snapshot: PrSnapshot): PrSummary {
  return {
    number: snapshot.number,
    url: snapshot.url,
    state: snapshot.state,
    isDraft: snapshot.isDraft,
    headSha: snapshot.headSha,
    reviewDecision: snapshot.reviewDecision,
  };
}

export function toLastState(snapshot: PrSnapshot): PrLastState {
  return {
    number: snapshot.number,
    state: snapshot.state,
    isDraft: snapshot.isDraft,
    headSha: snapshot.headSha,
    reviewDecision: snapshot.reviewDecision,
    commentIds: snapshot.comments.map((item) => item.id),
    reviewIds: snapshot.reviews.map((item) => item.id),
    reviewCommentIds: snapshot.reviewComments.map((item) => item.id),
  };
}

export function lastStateToBase(last: PrLastState): PrDiffBase {
  return {
    state: last.state,
    isDraft: last.isDraft,
    headSha: last.headSha,
    reviewDecision: last.reviewDecision,
    comments: last.commentIds.map((id) => ({ id })),
    reviews: last.reviewIds.map((id) => ({ id })),
    reviewComments: last.reviewCommentIds.map((id) => ({ id })),
  };
}

/** The most recent review of each author, newest author first. */
export function latestReviewPerAuthor(reviews: PrReview[]): PrReview[] {
  const latest = new Map<string, PrReview>();
  for (const review of reviews) {
    const current = latest.get(review.author);
    if (current === undefined || review.submittedAt >= current.submittedAt) {
      latest.set(review.author, review);
    }
  }
  return [...latest.values()].sort((left, right) => right.submittedAt.localeCompare(left.submittedAt));
}

export function describePrEvent(event: PrEvent): string {
  const by = event.author !== undefined && event.author.length > 0 ? ` by ${event.author}` : '';
  switch (event.kind) {
    case 'review':
      return `review${event.reviewState !== undefined ? ` ${event.reviewState}` : ''}${by}`;
    case 'push':
      return `push ${String(event.from ?? '').slice(0, 7)} -> ${String(event.to ?? '').slice(0, 7)}`;
    case 'review_decision':
      return `review decision ${event.from ?? 'none'} -> ${event.to ?? 'none'}`;
    case 'comment':
    case 'review_comment':
      return `${event.kind}${by}`;
    default:
      return event.kind;
  }
}
