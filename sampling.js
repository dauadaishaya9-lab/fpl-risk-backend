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

const FIXED_BANDS = [
  { name:"1-10000", min:1, max:10000, sampleSize:10 },
  { name:"10001-50000", min:10001, max:50000, sampleSize:15 },
  { name:"50001-100000", min:50001, max:100000, sampleSize:20 },
  { name:"100001-250000", min:100001, max:250000, sampleSize:25 },
  { name:"250001-500000", min:250001, max:500000, sampleSize:30 },
  { name:"500001-1000000", min:500001, max:1000000, sampleSize:35 }
];

const MILLION_BAND_START = 1000001;
const MILLION_BAND_SIZE = 1000000;
const MILLION_BAND_SAMPLE_SIZE = 60;

export function samplingBands(totalManagers) {
  const total = Math.max(0, Math.floor(Number(totalManagers)||0));
  const bands = FIXED_BANDS.map(b => ({...b}));

  if (total >= MILLION_BAND_START) {
    for (let min=MILLION_BAND_START; min<=total; min+=MILLION_BAND_SIZE) {
      const max=Math.min(min+MILLION_BAND_SIZE-1,total);
      bands.push({
        name:`${min}-${max}`,
        min,
        max,
        sampleSize:Math.min(MILLION_BAND_SAMPLE_SIZE,max-min+1)
      });
    }
  }

  return bands;
}

export function tierForRank(rank,totalManagers) {
  return samplingBands(totalManagers).find(
    tier => rank>=tier.min && rank<=tier.max
  ) || null;
}
