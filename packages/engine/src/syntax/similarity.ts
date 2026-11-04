/**
 * How alike two token sequences are, from 0 (nothing shared) to 1 (the same).
 *
 * This is the Dice coefficient over adjacent token pairs. Pairs keep some of the order:
 * two functions that use the same keywords and names in a different arrangement score
 * lower than a function and its edited copy. Counting pairs as a multiset rather than
 * a set keeps a repeated line from looking as alike as the whole body.
 */
export function tokenSimilarity(a: readonly string[], b: readonly string[]): number {
  const pairsOfA = pairCounts(a)
  const pairsOfB = pairCounts(b)
  const total = a.length - 1 + (b.length - 1)
  if (total <= 0) return a.join("") === b.join("") ? 1 : 0
  let shared = 0
  for (const [pair, count] of pairsOfA) {
    shared += Math.min(count, pairsOfB.get(pair) ?? 0)
  }
  return (2 * shared) / total
}

function pairCounts(tokens: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (let index = 1; index < tokens.length; index++) {
    // The NUL separator can't occur in source tokens, so `a` + `bc` and `ab` + `c` stay distinct.
    const pair = `${tokens[index - 1]}\0${tokens[index]}`
    counts.set(pair, (counts.get(pair) ?? 0) + 1)
  }
  return counts
}
