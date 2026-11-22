const keys = ['input', 'cacheRead', 'cacheWrite', 'output'] as const;
export type TokenCounts = Record<typeof keys[number], number | null>;
export interface ThreadUsage { calls: number; total: TokenCounts; last: TokenCounts }

export function recordUsage(previous: ThreadUsage | undefined, raw: unknown): ThreadUsage {
  const last = {} as TokenCounts, total = {} as TokenCounts;
  for (const key of keys) {
    const n = (raw as Partial<TokenCounts> | null)?.[key];
    last[key] = typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
    const prior = previous ? previous.total[key] : 0;
    total[key] = prior !== null && last[key] !== null ? prior + last[key] : null;
  }
  return { calls: (previous?.calls ?? 0) + 1, last, total };
}

export function cachedShare({ input, cacheRead, cacheWrite }: TokenCounts) {
  if (input === null || cacheRead === null || cacheWrite === null) return 'Not reported';
  const denominator = input + cacheRead + cacheWrite;
  return denominator ? `${(100 * cacheRead / denominator).toFixed(1)}%` : 'No input';
}
