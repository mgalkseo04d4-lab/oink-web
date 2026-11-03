// node webapp/selfcheck.mjs — logic.mjs 판정 확인
import assert from "node:assert/strict";
import { co2Slope, mood, decompProgress, addFeed, odorWord, STALE_MS } from "./logic.mjs";

const now = 1_000_000_000;
const rising = [0, 1, 2, 3, 4].map((m) => ({ t: now - (4 - m) * 60000, ppm: 600 + m * 20 }));
const falling = rising.map((p, i) => ({ t: p.t, ppm: 700 - i * 20 }));
assert.ok(co2Slope(rising, now) > 19 && co2Slope(rising, now) < 21);
assert.ok(co2Slope(falling, now) < 0);
assert.equal(co2Slope(rising.slice(0, 2), now), null);

const live = { online: true, lastSeen: now - 1000, now };
assert.equal(mood({ ...live, online: false, b1: { co2_status: 1 }, slope: 5 }), "sleep");
assert.equal(mood({ ...live, lastSeen: now - STALE_MS - 1, b1: { co2_status: 1 }, slope: 5 }), "sleep");
assert.equal(mood({ ...live, b1: null, slope: 5 }), "sleep");
assert.equal(mood({ ...live, b1: { co2_status: 1, odor_index: 2.3 }, slope: 5 }), "smelly");
assert.equal(mood({ ...live, b1: { co2_status: 1, odor_index: 1.1 }, slope: 5 }), "busy");
assert.equal(mood({ ...live, b1: { co2_status: 0, odor_index: 1.1 }, slope: 5 }), "calm");
assert.equal(mood({ ...live, b1: { co2_status: 1, odor_index: 1.1 }, slope: -3 }), "calm");

const feed = now - 3600 * 1000;
const hist = [{ t: feed - 1000, ppm: 500 }, { t: feed + 1000, ppm: 900 }, { t: now, ppm: 700 }];
assert.ok(Math.abs(decompProgress(feed, now, hist) - 0.5) < 1e-9); // (900-700)/(900-500)
assert.equal(decompProgress(null, now, hist), null);
assert.ok(decompProgress(feed, feed + 24 * 3600 * 1000, []) === 0.5); // 시간만 → 24h/48h

const many = Array.from({ length: 20 }, (_, i) => ({ ts: i }));
assert.equal(addFeed(many, { ts: 99 }).length, 20);
assert.equal(addFeed(null, { ts: 1 }).length, 1);
assert.equal(odorWord({ odor_index: 2.5 }), "냄새 심해요");
console.log("selfcheck ok");
