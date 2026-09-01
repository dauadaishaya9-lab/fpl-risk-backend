import test from "node:test";
import assert from "node:assert/strict";
import { decisionExposure, exposureDistribution, exposurePercentile, relativeExpectedSwing } from "../exposure-model.js";
import { deterministicRanks, standingsPageForRank, uniqueStandingPages } from "../sampling.js";

test("decision exposure enforces valid FPL captain choices", () => {
  assert.equal(decisionExposure({ owns: false, captain: false, tripleCaptain: false }), 0);
  assert.equal(decisionExposure({ owns: true, captain: false, tripleCaptain: false }), 1);
  assert.equal(decisionExposure({ owns: true, captain: true, tripleCaptain: false }), 2);
  assert.equal(decisionExposure({ owns: true, captain: true, tripleCaptain: true }), 3);
  assert.throws(() => decisionExposure({ owns: false, captain: true, tripleCaptain: false }));
});

test("exposure distribution and swing preserve multipliers", () => {
  const distribution = exposureDistribution([
    { picks: [] },
    { picks: [{ element: 12, multiplier: 1 }] },
    { picks: [{ element: 12, multiplier: 2 }] },
    { picks: [{ element: 12, multiplier: 3 }] }
  ], 12);
  assert.deepEqual(distribution.counts, [1, 1, 1, 1]);
  assert.equal(distribution.mean, 1.5);
  assert.equal(exposurePercentile(distribution, 2), 75);
  assert.equal(relativeExpectedSwing(3, distribution.mean, 6.5), 9.75);
});

test("sampling is deterministic, bounded, and maps ranks to standings pages", () => {
  const first = deterministicRanks("2026/27+1+1-10000", 1, 100, 10);
  assert.deepEqual(deterministicRanks("2026/27+1+1-10000", 1, 100, 10), first);
  assert.equal(first.length, 10);
  assert.ok(first.every(rank => rank >= 1 && rank <= 100));
  assert.equal(standingsPageForRank(51), 2);
  assert.deepEqual(uniqueStandingPages([1, 50, 51, 100]), [1, 2]);
});
