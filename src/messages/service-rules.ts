// Pure (no Obsidian imports) so the rules can be tested.

/** Has enough time passed since the last attempt? Pure, so the polling rules can be tested. */
export function shouldFetch(lastAttemptAt: string | undefined, now: number, minGapMs: number): boolean {
  if (!lastAttemptAt) return true;
  const t = Date.parse(lastAttemptAt);
  return Number.isNaN(t) || now - t >= minGapMs;
}
