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

import { fitHockey, hockeyMatrix, hockeyModel, evaluateIddaaHockey, evaluateIddaaAny, HOCKEY } from "../../docs/valuebet.js";

const sum = (M, f) => M.reduce((s, row, i) => s + row.reduce((t, v, j) => t + (f(i, j) ? v : 0), 0), 0);

test("hokey: matris normalize, beraberlik ~%20-23", () => {
  const M = hockeyMatrix(3.1, 2.9);
  assert.ok(Math.abs(sum(M, () => true) - 1) < 1e-9);
  const d = sum(M, (i, j) => i === j);
  assert.ok(d > 0.19 && d < 0.24, String(d));
});

test("hokey: model referans olasılıkları geri üretir", () => {
  const { lh, la } = fitHockey(0.6, 6.5, 0.45);
  const M = hockeyMatrix(lh, la);
  const full = sum(M, (i, j) => i > j) + HOCKEY.otHomeShare * sum(M, (i, j) => i === j);
  assert.ok(Math.abs(full - 0.6) < 1e-4);
  const over = sum(M, (i, j) => i + j + (i === j ? 1 : 0) > 6.5);
  assert.ok(Math.abs(over - 0.45) < 1e-4);
  assert.ok(lh > la);
});

const nhl = {
  id: "h1", sport_key: "icehockey_nhl", commence_time: "2026-11-23T00:00:00Z", home_team: "Home", away_team: "Away",
  bookmakers: [{ key: "pinnacle", title: "Pinnacle", markets: [
    { key: "h2h", outcomes: [{ name: "Home", price: 1.95 }, { name: "Away", price: 1.95 }] },
    { key: "totals", outcomes: [{ name: "Over", price: 1.95, point: 6 }, { name: "Under", price: 1.95, point: 6 }] },
  ] }],
};

test("hokey iddaa: 1X2 toplamı 1, simetrik maçta 1 = 2, handikap ve alt/üst", () => {
  const rows = evaluateIddaaHockey(nhl, {
    h2h: { home: "2,6", draw: "4,2", away: "2,6" },
    spreads: { line: "-1", home: "5", draw: "4", away: "1,4" },
    totals: { line: "5,5", over: "1,8", under: "2" }, mbs: 2,
  }, { devigMethod: "multiplicative" });
  const ms = rows.filter((r) => r.market === "h2h");
  assert.equal(ms.length, 3);
  const total = ms.reduce((s, r) => s + r.fair_probability, 0);
  assert.ok(Math.abs(total - 1) < 1e-3);
  assert.ok(Math.abs(ms[0].fair_probability - ms[2].fair_probability) < 1e-3);
  const hc = rows.filter((r) => r.market === "spreads");
  assert.equal(hc.length, 3);
  assert.ok(Math.abs(hc.reduce((s, r) => s + r.fair_probability, 0) - 1) < 1e-3);
  assert.equal(hc[0].label, "Home (-1)");
  const tot = rows.filter((r) => r.market === "totals");
  assert.ok(Math.abs(tot[0].fair_probability + tot[1].fair_probability - 1) < 1e-3);
  assert.ok(rows.every((r) => r.mbs === 2 && r.model));
  // yarım çizgide X seçeneği yok
  const half = evaluateIddaaHockey(nhl, { spreads: { line: "-1,5", home: "3", draw: "4", away: "1,4" } });
  assert.equal(half.length, 2);
});

test("evaluateIddaaAny spora göre yönlendirir", () => {
  assert.ok(evaluateIddaaAny(nhl, { h2h: { home: "2,5", draw: "4", away: "2,5" } }).every((r) => r.model));
  assert.equal(hockeyModel({ ...nhl, bookmakers: [] }), null);
});

import { legFromBet, legFromIddaa, settleLeg, betOutcome, ledgerStats, betClv, currentFairProb, sportOf, evaluateIddaa as evalB } from "../../docs/valuebet.js";

const game = (hs, as) => ({ completed: true, home_team: "Home", away_team: "Away", scores: [{ name: "Home", score: String(hs) }, { name: "Away", score: String(as) }] });
const L = (o) => ({ home: "Home", away: "Away", regulation: false, status: "pending", odds: 2, ...o });

test("sonuçlandırma: maç sonucu, handikap, toplam, iade", () => {
  assert.equal(settleLeg(L({ market: "h2h", side: "home" }), game(100, 90)), "won");
  assert.equal(settleLeg(L({ market: "h2h", side: "away" }), game(100, 90)), "lost");
  assert.equal(settleLeg(L({ market: "spreads", side: "home", line: -4.5 }), game(100, 96)), "lost");
  assert.equal(settleLeg(L({ market: "spreads", side: "away", line: -4.5 }), game(100, 96)), "won");
  assert.equal(settleLeg(L({ market: "spreads", side: "home", line: -4 }), game(100, 96)), "push");
  assert.equal(settleLeg(L({ market: "totals", side: "over", line: 195.5 }), game(100, 96)), "won");
  assert.equal(settleLeg(L({ market: "totals", side: "under", line: 196 }), game(100, 96)), "push");
  assert.equal(settleLeg(L({ market: "h2h", side: "home", regulation: true }), game(3, 2)), null);
  assert.equal(settleLeg(L({ market: "h2h", side: "home" }), { ...game(1, 0), completed: false }), null);
});

test("şirket satırından ayak: deplasman handikabı ev sahibi çizgisine çevrilir", () => {
  const leg = legFromBet({ event_id: "e", commence_time: "", home_team: "Home", away_team: "Away", market: "spreads", market_label: "Handikap", selection: "Away", point: 4.5, label: "Away +4.5", price: 1.9, bookmaker_title: "X", fair_probability: 0.55 }, "nba");
  assert.equal(leg.side, "away");
  assert.equal(leg.line, -4.5);
  assert.equal(settleLeg(leg, game(100, 97)), "won");
});

test("kupon sonucu ve istatistik", () => {
  const bet = { stake: 10, ev: 0.1, legs: [L({ odds: 2, status: "won", close_prob: 0.55 }), L({ odds: 1.5, status: "push", close_prob: 0.7 })] };
  assert.deepEqual(betOutcome(bet), { status: "won", profit: 10 });
  assert.equal(betOutcome({ stake: 10, legs: [L({ status: "lost" }), L({ status: "pending" })] }).status, "lost");
  assert.equal(betOutcome({ stake: 10, legs: [L({ status: "won" }), L({ status: "pending" })] }).status, "pending");
  assert.ok(Math.abs(betClv(bet) - (2 * 0.55 * 1.5 * 0.7 - 1)) < 1e-4);
  const s = ledgerStats([{ ...bet, status: "won", profit: 10 }, { stake: 10, ev: 0.02, status: "lost", profit: -10, legs: [L({})] }, { stake: 5, ev: 0, status: "pending", legs: [L({})] }]);
  assert.equal(s.settled, 2); assert.equal(s.pending, 1); assert.equal(s.profit, 0); assert.equal(s.staked, 20);
  assert.equal(s.win_rate, 0.5); assert.equal(s.clv_count, 1);
});

test("güncel adil olasılık: şirket ve iddaa ayakları", () => {
  const bLeg = { source: "book", market: "spreads", side: "home", line: -3.5, odds: 2 };
  assert.ok(Math.abs(currentFairProb(ev, bLeg, { devigMethod: "multiplicative" }) - 0.5) < 1e-9);
  const row = evalB(ev, { totals: { line: "224.5", over: "2", under: "2" } }).find((x) => x.side === "over");
  const iLeg = legFromIddaa(row, ev);
  assert.equal(iLeg.line, 224.5);
  assert.equal(currentFairProb(ev, iLeg), row.fair_probability);
  assert.equal(sportOf({ sport_key: "basketball_euroleague" }).name, "EuroLeague");
  assert.equal(sportOf({ sport_key: "americanfootball_nfl" }).spreadSd, 13.5);
});

import { regulationModel, evaluateIddaaRegulation, SPORTS as SP } from "../../docs/valuebet.js";

const bball = (sport_key, ml, tot) => ({
  id: "r1", sport_key, commence_time: "2026-11-23T00:30:00Z", home_team: "Home", away_team: "Away",
  bookmakers: [{ key: "pinnacle", title: "Pinnacle", markets: [
    { key: "h2h", outcomes: [{ name: "Home", price: ml[0] }, { name: "Away", price: ml[1] }] },
    { key: "totals", outcomes: [{ name: "Over", price: 1.95, point: tot }, { name: "Under", price: 1.95, point: tot }] },
  ] }],
});

test("normal süre: eşit maçta 1 = 2, X ≈ uzatma oranı, uzatmalar dahil olasılığı korunur", () => {
  for (const [key, id] of [["basketball_nba", "nba"], ["basketball_euroleague", "euroleague"], ["americanfootball_nfl", "nfl"]]) {
    const m = regulationModel(bball(key, [1.95, 1.95], 220.5), { devigMethod: "multiplicative" });
    const sum = (f) => m.pmf.reduce((s, v, i) => s + (f(i - 80) ? v : 0), 0);
    assert.ok(Math.abs(sum(() => true) - 1) < 1e-9);
    assert.ok(Math.abs(sum((k) => k > 0) - sum((k) => k < 0)) < 1e-6, id);
    assert.ok(Math.abs(m.pTie - SP[id].reg.tieRate) < 1e-3, `${id} X ${m.pTie}`);
  }
  const fav = regulationModel(bball("basketball_nba", [1.4, 3.2], 225.5), { devigMethod: "multiplicative" });
  const s = (f) => fav.pmf.reduce((a, v, i) => a + (f(i - 80) ? v : 0), 0);
  const pFull = (1 / 1.4) / (1 / 1.4 + 1 / 3.2);
  assert.ok(Math.abs(s((k) => k > 0) + fav.pTie / 2 - pFull) < 1e-6);
  assert.ok(fav.pTie < 0.06); // favori varken beraberlik daha az olası
});

test("normal süre: toplam, uzatma payı kadar düşük; 1-X-2 ve alt/üst satırları", () => {
  const ev = bball("basketball_nba", [1.95, 1.95], 220.5);
  const m = regulationModel(ev, { devigMethod: "multiplicative" });
  assert.ok(m.total.mu < 220.5 && m.total.mu > 218, String(m.total.mu));
  const rows = evaluateIddaaRegulation(ev, {
    h2h: { home: "1,95", draw: "15", away: "1,95" }, spreads: { line: "-2", home: "2,1", draw: "14", away: "1,8" },
    totals: { line: "220,5", over: "1,9", under: "1,9" }, mbs: 1,
  }, { devigMethod: "multiplicative" });
  const ms = rows.filter((r) => r.market === "h2h");
  assert.deepEqual(ms.map((r) => r.side), ["home", "draw", "away"]);
  assert.ok(Math.abs(ms.reduce((a, r) => a + r.fair_probability, 0) - 1) < 1e-3);
  assert.ok(rows.every((r) => r.regulation && r.model));
  assert.equal(rows.filter((r) => r.market === "spreads").length, 3);
  const over = rows.find((r) => r.side === "over"), under = rows.find((r) => r.side === "under");
  assert.ok(over.fair_probability < 0.5 && under.fair_probability > 0.5); // uzatma sayılmayınca üst zorlaşır
  // basketbol varsayılanı uzatmalar dahil (iddaa NBA kuralı); lig bazında normal süre seçilebilir
  assert.ok(evaluateIddaaAny(ev, { h2h: { home: "2", away: "2" } }).every((r) => !r.regulation));
  // NBA ve NFL'de iddaa uzatmaları sayar: lig tercihi bunu değiştirmez
  assert.ok(evaluateIddaaAny(ev, { h2h: { home: "2", away: "2" } }, { regulationBySport: { nba: true } }).every((r) => !r.regulation));
  const nflEv = { ...ev, sport_key: "americanfootball_nfl" };
  assert.ok(evaluateIddaaAny(nflEv, { h2h: { home: "2", away: "2" } }, { regulationBySport: { nfl: true } }).every((r) => !r.regulation));
  // doğrulanmamış ligde (EuroLeague) tercih geçerli
  const elEv = { ...ev, sport_key: "basketball_euroleague" };
  assert.ok(evaluateIddaaAny(elEv, { h2h: { home: "2", away: "2" } }).every((r) => !r.regulation));
  assert.ok(evaluateIddaaAny(elEv, { h2h: { home: "2", away: "2" } }, { regulationBySport: { euroleague: true } }).every((r) => r.regulation));
  assert.ok(evaluateIddaaAny(ev, { h2h: { home: "2", away: "2" } }, { regulation: true }).every((r) => r.regulation));
  // hokey her zaman normal süre
  assert.ok(evaluateIddaaAny(nhl, { h2h: { home: "2,5", draw: "4", away: "2,5" } }, { regulationBySport: { nhl: false } }).every((r) => r.model));
  // kayıt: normal süre ayağı elle sonuçlanır
  assert.equal(legFromIddaa(over, ev).regulation, true);
});
