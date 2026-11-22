import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateIddaa, buildCoupons, parseOdds, parseLine, normCdf, normInv } from "../../docs/valuebet.js";

const ev = {
  id: "g1", commence_time: "2026-11-23T00:30:00Z", home_team: "Home", away_team: "Away",
  bookmakers: [{
    key: "pinnacle", title: "Pinnacle", markets: [
      { key: "h2h", outcomes: [{ name: "Home", price: 1.95 }, { name: "Away", price: 1.95 }] },
      { key: "spreads", outcomes: [{ name: "Home", price: 1.95, point: -3.5 }, { name: "Away", price: 1.95, point: 3.5 }] },
      { key: "totals", outcomes: [{ name: "Over", price: 1.95, point: 220.5 }, { name: "Under", price: 1.95, point: 220.5 }] },
    ],
  }],
};

test("parse", () => {
  assert.equal(parseOdds("1,85"), 1.85);
  assert.equal(parseOdds("1"), null);
  assert.equal(parseOdds(""), null);
  assert.equal(parseLine("-4,5"), -4.5);
  assert.equal(parseLine(""), null);
});

test("normal", () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-4);
  assert.ok(Math.abs(normInv(0.975) - 1.96) < 1e-3);
});

test("maç sonucu: adil olasılık ve EV", () => {
  const r = evaluateIddaa(ev, { h2h: { home: "2,10", away: "1,60" }, mbs: 1 }, { devigMethod: "multiplicative" });
  const home = r.find((x) => x.side === "home");
  assert.equal(home.fair_probability, 0.5);
  assert.ok(Math.abs(home.edge - 0.05) < 1e-9);
  assert.equal(home.adjusted, false);
});

test("handikap: aynı çizgi düzeltme yapmaz, farklı çizgi doğru yöne kayar", () => {
  const same = evaluateIddaa(ev, { spreads: { line: "-3.5", home: "2", away: "2" } }, { devigMethod: "multiplicative" });
  assert.equal(same[0].fair_probability, 0.5);
  assert.equal(same[0].adjusted, false);
  // ev sahibine -1.5 vermek -3.5'ten kolay -> olasılık > 0.5
  const easier = evaluateIddaa(ev, { spreads: { line: "-1.5", home: "2", away: "2" } }, { devigMethod: "multiplicative" });
  const h = easier.find((x) => x.side === "home");
  assert.ok(h.fair_probability > 0.5 && h.fair_probability < 0.6);
  assert.equal(h.adjusted, true);
  assert.equal(h.label, "Home -1.5");
  assert.equal(easier.find((x) => x.side === "away").label, "Away +1.5");
});

test("alt/üst: yüksek çizgide üst olasılığı düşer", () => {
  const r = evaluateIddaa(ev, { totals: { line: "224.5", over: "2", under: "2" } }, { devigMethod: "multiplicative" });
  const over = r.find((x) => x.side === "over");
  assert.ok(over.fair_probability < 0.5 && over.fair_probability > 0.35);
  assert.equal(over.label, "Üst 224.5");
});

test("kupon: MBS kuralı ve maç başına tek seçim", () => {
  const s = (id, edge, mbs, p = 0.5) => ({ event_id: id, edge, mbs, fair_probability: p, odds: (1 + edge) / p });
  const sels = [s("a", 0.06, 2), s("a", 0.03, 2), s("b", 0.05, 2), s("c", 0.04, 3), s("d", -0.02, 1)];
  const coupons = buildCoupons(sels, { minEdge: 0, maxLegs: 3, limit: 50 });
  for (const c of coupons) {
    assert.ok(c.legs.length >= Math.max(...c.legs.map((l) => l.mbs)));
    assert.equal(new Set(c.legs.map((l) => l.event_id)).size, c.legs.length);
    assert.ok(!c.legs.some((l) => l.event_id === "d"));
  }
  assert.ok(!coupons.some((c) => c.legs.length === 1)); // hepsi MBS >= 2
  const ab = coupons.find((c) => c.legs.length === 2 && c.legs.every((l) => "ab".includes(l.event_id)));
  assert.ok(Math.abs(ab.edge - (1.06 * 1.05 - 1)) < 1e-4);
});
