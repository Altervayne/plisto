/*
 * A frame's message budget: a token bucket spent by every message the page posts, before the host parses
 * it. The clock is passed in, so the bucket holds no timer and tests drive it.
 */

/** A bucket's size and its refill per second. */
export interface BudgetLimit {
  burst: number;
  perSec: number;
}

/** Everything a frame posts except a pong. */
export const FRAME_LIMIT: BudgetLimit = { burst: 200, perSec: 100 };

/** A frame's pongs, apart from its other traffic so a flood cannot starve its heartbeat. */
export const PONG_LIMIT: BudgetLimit = { burst: 5, perSec: 2 };

export interface FrameBudget {
  limit: BudgetLimit;
  tokens: number;
  /** The clock reading of the last refill, in milliseconds. */
  at: number;
}

export function newBudget(now: number, limit: BudgetLimit): FrameBudget {
  return { limit, tokens: limit.burst, at: now };
}

/** Takes one token. False when none is left; the caller drops the message without a reply. */
export function admit(budget: FrameBudget, now: number): boolean {
  // A clock that steps back refills nothing.
  const elapsed = Math.max(0, now - budget.at);
  budget.at = now;
  budget.tokens = Math.min(budget.limit.burst, budget.tokens + (elapsed * budget.limit.perSec) / 1000);
  if (budget.tokens < 1) return false;
  budget.tokens -= 1;
  return true;
}

/** The production clock: monotonic, so a wall-clock change cannot refill a budget. */
export const defaultNow = (): number => performance.now();
