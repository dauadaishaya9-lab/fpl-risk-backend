// Sampling logic adapted from FPL Risk Calculator 2.
// Sampling is deterministic for a season/gameweek/tier/seed so a collection
// run can be retried without silently changing the cohort.

function hashSeed(seed) {
  let state = 2166136261;
  for (const char of String(seed)) state = Math.imul(state ^ char.charCodeAt(0), 16777619);
  return state >>> 0;
}

function nextRandom(state) {
  state.value = Math.imul(state.value ^ (state.value >>> 13), 1274126177) >>> 0;
  return state.value / 4294967296;
}

export function deterministicRanks(seed, minRank, maxRank, sampleSize) {
  if (!Number.isSafeInteger(minRank) || !Number.isSafeInteger(maxRank) || minRank < 1 || maxRank < minRank) return [];
  const size = Math.min(Math.max(0, Number(sampleSize) || 0), maxRank - minRank + 1);
  const state = { value: hashSeed(seed) };
  const selected = new Set();
  while (selected.size < size) selected.add(minRank + Math.floor(nextRandom(state) * (maxRank - minRank + 1)));
  return [...selected].sort((a, b) => a - b);
}

export function standingsPageForRank(rank, pageSize = 50) {
  return Math.floor((rank - 1) / pageSize) + 1;
}

export function uniqueStandingPages(ranks, pageSize = 50) {
  return [...new Set(ranks.map(rank => standingsPageForRank(rank, pageSize)))].sort((a, b) => a - b);
}
