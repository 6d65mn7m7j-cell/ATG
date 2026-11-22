// Değerli bahis motoru (valuebet/odds.py + finder.py'nin JavaScript karşılığı).
// Tarayıcıda ve Node'da (testler) çalışır.

export const DEVIG_METHODS = ["power", "shin", "multiplicative", "additive"];
export const MARKET_LABELS = { h2h: "Maç Sonucu", spreads: "Handikap", totals: "Toplam Sayı" };
export const DEFAULT_SHARP_BOOKS = ["pinnacle", "betonlineag", "circasports", "lowvig"];
export const EXCHANGE_COMMISSION = {
  betfair_ex_eu: 0.05, betfair_ex_uk: 0.05, betfair_ex_au: 0.05, matchbook: 0.02, smarkets: 0.02,
};

export const DEFAULTS = {
  minEdge: 0.02, maxEdge: 0.25, devigMethod: "power", reference: "sharp",
  sharpBooks: DEFAULT_SHARP_BOOKS, minBooksForConsensus: 3,
  markets: ["h2h", "spreads", "totals"], bookmakers: null,
  minOdds: 1.2, maxOdds: 6.0, bankroll: 1000, kellyMultiplier: 0.25, maxStakePct: 0.03,
};

// ---------------------------------------------------------------- oran matematiği
export const impliedProbability = (o) => {
  if (!(o > 1)) throw new Error(`Ondalık oran 1'den büyük olmalı: ${o}`);
  return 1 / o;
};
export const decimalToAmerican = (o) => (o >= 2 ? Math.round((o - 1) * 100) : Math.round(-100 / (o - 1)));
export const expectedValue = (p, o) => p * o - 1;
export const kellyFraction = (p, o) => {
  const b = o - 1;
  if (b <= 0) return 0;
  return Math.max((b * p - (1 - p)) / b, 0);
};
export const netPrice = (book, price) => 1 + (price - 1) * (1 - (EXCHANGE_COMMISSION[book] || 0));

function bisect(f, lo, hi, tol = 1e-12, maxIter = 200) {
  let flo = f(lo);
  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2, fmid = f(mid);
    if (Math.abs(fmid) < tol || (hi - lo) / 2 < tol) return mid;
    if ((fmid > 0) === (flo > 0)) { lo = mid; flo = fmid; } else hi = mid;
  }
  return (lo + hi) / 2;
}
const normalize = (a) => { const s = a.reduce((x, y) => x + y, 0); return a.map((x) => x / s); };

export function devig(odds, method = "power") {
  if (odds.length < 2) throw new Error("Marj temizleme için en az iki sonuç gerekir");
  const q = odds.map(impliedProbability);
  const total = q.reduce((a, b) => a + b, 0);
  switch (method) {
    case "multiplicative": return normalize(q);
    case "additive": { const ex = (total - 1) / q.length; return normalize(q.map((p) => Math.max(p - ex, 1e-9))); }
    case "power": { const k = bisect((k) => q.reduce((s, x) => s + x ** k, 0) - 1, 1e-3, 100); return normalize(q.map((x) => x ** k)); }
    case "shin": {
      if (total <= 1) return normalize(q);
      const probs = (z) => q.map((x) => (Math.sqrt(z * z + 4 * (1 - z) * x * x / total) - z) / (2 * (1 - z)));
      const z = bisect((z) => probs(z).reduce((a, b) => a + b, 0) - 1, 0, 0.4999);
      return normalize(probs(z));
    }
    default: throw new Error(`Bilinmeyen yöntem: ${method}`);
  }
}

// ---------------------------------------------------------------- bulucu
function lineId(market, outcomes, home) {
  if (market === "h2h") return "-";
  if (market === "totals") return String(Number(outcomes[0].point));
  const h = outcomes.find((o) => o.name === home) || outcomes[0];
  return String(Number(h.point));
}

function collectLines(event, market) {
  const groups = new Map();
  for (const book of event.bookmakers || []) {
    for (const m of book.markets || []) {
      if (m.key !== market) continue;
      const outs = m.outcomes || [];
      if (outs.length !== 2) continue;
      if (market !== "h2h" && outs.some((o) => o.point == null || Number.isNaN(Number(o.point)))) continue;
      const prices = {}, points = {};
      for (const o of outs) { prices[o.name] = Number(o.price); points[o.name] = o.point ?? null; }
      if (Object.keys(prices).length !== 2 || Object.values(prices).some((p) => !(p > 1))) continue;
      const id = lineId(market, outs, event.home_team);
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push({ key: book.key, title: book.title || book.key, lastUpdate: m.last_update || book.last_update, prices, points });
    }
  }
  return groups;
}

function fairProbs(line, method) {
  const names = Object.keys(line.prices);
  const p = devig(names.map((n) => line.prices[n]), method);
  return Object.fromEntries(names.map((n, i) => [n, p[i]]));
}

const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function referenceProbs(lines, exclude, cfg) {
  const others = lines.filter((l) => l.key !== exclude);
  if (cfg.reference === "sharp") {
    for (const sharp of cfg.sharpBooks) {
      const l = others.find((x) => x.key === sharp);
      if (l) return { probs: fairProbs(l, cfg.devigMethod), kind: "sharp", books: [l.key] };
    }
  }
  if (others.length < cfg.minBooksForConsensus) return null;
  const per = others.map((l) => fairProbs(l, cfg.devigMethod));
  const names = Object.keys(per[0]);
  const med = Object.fromEntries(names.map((n) => [n, median(per.map((p) => p[n]))]));
  const tot = Object.values(med).reduce((a, b) => a + b, 0);
  for (const n of names) med[n] /= tot;
  return { probs: med, kind: "consensus", books: others.map((l) => l.key) };
}

export function betLabel(b) {
  if (b.market === "spreads" && b.point != null) return `${b.selection} ${b.point > 0 ? "+" : ""}${b.point}`;
  if (b.market === "totals" && b.point != null) return `${{ Over: "Üst", Under: "Alt" }[b.selection] || b.selection} ${b.point}`;
  return b.selection;
}

const r = (x, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

export function findValueBets(events, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const allowed = cfg.bookmakers && cfg.bookmakers.length ? new Set(cfg.bookmakers) : null;
  const out = [];
  for (const ev of events) {
    for (const market of cfg.markets) {
      for (const lines of collectLines(ev, market).values()) {
        if (lines.length < 2) continue;
        const best = {};
        for (const l of lines) for (const [n, p] of Object.entries(l.prices)) best[n] = Math.max(best[n] || 0, p);
        for (const line of lines) {
          if (allowed && !allowed.has(line.key)) continue;
          const ref = referenceProbs(lines, line.key, cfg);
          if (!ref) continue;
          for (const [name, price] of Object.entries(line.prices)) {
            if (!(name in ref.probs) || price < cfg.minOdds || price > cfg.maxOdds) continue;
            const p = ref.probs[name];
            const net = netPrice(line.key, price);
            const edge = expectedValue(p, net);
            if (edge < cfg.minEdge || edge > cfg.maxEdge) continue;
            const k = kellyFraction(p, net);
            const bet = {
              event_id: ev.id, commence_time: ev.commence_time, home_team: ev.home_team, away_team: ev.away_team,
              market, market_label: MARKET_LABELS[market] || market, selection: name, point: line.points[name],
              bookmaker: line.key, bookmaker_title: line.title, price, net_price: r(net, 3),
              american: decimalToAmerican(price), fair_probability: r(p), fair_odds: r(1 / p, 3),
              implied_probability: r(1 / price), edge: r(edge), kelly: r(k),
              stake: r(cfg.bankroll * Math.min(k * cfg.kellyMultiplier, cfg.maxStakePct), 2),
              reference: ref.kind, reference_books: ref.books, best_price: price >= best[name], last_update: line.lastUpdate,
            };
            bet.label = betLabel(bet);
            out.push(bet);
          }
        }
      }
    }
  }
  out.sort((a, b) => b.edge - a.edge);
  return out;
}

export function summarize(events, bets) {
  const books = new Set(events.flatMap((e) => (e.bookmakers || []).map((b) => b.key)));
  return {
    events: events.length, bookmakers: books.size, value_bets: bets.length,
    avg_edge: bets.length ? r(bets.reduce((s, b) => s + b.edge, 0) / bets.length) : 0,
    max_edge: bets.reduce((m, b) => Math.max(m, b.edge), 0),
    total_stake: r(bets.reduce((s, b) => s + b.stake, 0), 2),
    expected_profit: r(bets.reduce((s, b) => s + b.stake * b.edge, 0), 2),
  };
}

export function listBookmakers(events) {
  const m = new Map();
  for (const e of events) for (const b of e.bookmakers || []) m.set(b.key, b.title || b.key);
  return [...m].map(([key, title]) => ({ key, title })).sort((a, b) => a.title.localeCompare(b.title));
}
