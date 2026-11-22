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

// NHL'de bazı Avrupa şirketleri alt/üst ve handikabı uzatmasız fiyatlar (Pinnacle uzatmayı sayar) -> sahte değer.
// Hokeyde handikap/toplam yalnızca uzatmayı saydığı bilinen şirketler arasında karşılaştırılır.
export const HOCKEY_OT_BOOKS = new Set([
  "pinnacle", "betonlineag", "lowvig", "bovada", "betus", "mybookieag", "gtbets", "everygame", "betanysports",
  "draftkings", "fanduel", "betmgm", "betrivers", "williamhill_us", "espnbet", "fanatics", "ballybet", "betparx",
  "hardrockbet", "fliff", "circasports", "superbook", "unibet_us", "windcreek", "betfair_ex_eu", "betfair_ex_uk",
  "matchbook", "smarkets", "sport888", "williamhill",
]);
const bookAllowed = (event, market, key) =>
  market === "h2h" || !String(event.sport_key || "").startsWith("icehockey") || HOCKEY_OT_BOOKS.has(key);

function collectLines(event, market) {
  const groups = new Map();
  for (const book of event.bookmakers || []) {
    if (!bookAllowed(event, market, book.key)) continue;
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
              market, market_label: (cfg.labels || MARKET_LABELS)[market] || market, selection: name, point: line.points[name],
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

// ================================================================ iddaa (elle giriş)
// NBA sonuç dağılımı için yaklaşık standart sapmalar (uzatmalar dahil).
export const SPREAD_SD = 12.5;
export const TOTAL_SD = 18.5;

function erf(x) {
  // Abramowitz & Stegun 7.1.26 (hata < 1.5e-7)
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
export const normCdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
export function normInv(p) {
  let lo = -10, hi = 10;
  for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (normCdf(m) < p) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

/** Ondalık oran girdisini ayrıştırır ("1,85" ve "1.85" kabul edilir). Geçersizse null. */
export function parseOdds(v) {
  if (v == null) return null;
  const n = Number(String(v).trim().replace(",", "."));
  return Number.isFinite(n) && n > 1 ? n : null;
}
export function parseLine(v) {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(String(v).trim().replace(",", ".").replace("−", "-"));
  return Number.isFinite(n) ? n : null;
}

/** Bir maç/market için referans adil olasılıkları her çizgi için döndürür. */
export function referenceLines(event, market, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const out = [];
  for (const [id, lines] of collectLines(event, market)) {
    const ref = referenceProbs(lines, null, cfg);
    if (ref) out.push({ line: id === "-" ? null : Number(id), ...ref });
  }
  return out;
}

function pickReference(refs, line) {
  if (!refs.length) return null;
  const pool = refs.some((r) => r.kind === "sharp") ? refs.filter((r) => r.kind === "sharp") : refs;
  if (line == null) return pool[0];
  return pool.reduce((best, r) => (Math.abs(r.line - line) < Math.abs(best.line - line) ? r : best));
}

/**
 * iddaa'ya girilen oranları adil olasılıklarla karşılaştırır.
 * entry = { h2h: {home, away}, spreads: {line, home, away}, totals: {line, over, under}, mbs }
 * spreads.line ev sahibinin handikabıdır (ör. -4.5).
 */
export function evaluateIddaa(event, entry, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const H = event.home_team, A = event.away_team;
  const res = [];
  const push = (market, side, label, odds, p, ref, adjusted) => {
    if (odds == null || p == null) return;
    res.push({
      event_id: event.id, match: `${H} – ${A}`, commence_time: event.commence_time, market,
      market_label: MARKET_LABELS[market], side, line: market === "h2h" ? null : parseLine(e[market]?.line), label, odds, fair_probability: r(p), fair_odds: r(1 / p, 3),
      edge: r(p * odds - 1), reference: ref.kind, reference_books: ref.books, reference_line: ref.line, adjusted,
      mbs: Number(entry.mbs) || 1,
    });
  };

  const e = entry || {};
  if (e.h2h) {
    const ref = pickReference(referenceLines(event, "h2h", cfg), null);
    if (ref) {
      push("h2h", "home", H, parseOdds(e.h2h.home), ref.probs[H], ref, false);
      push("h2h", "away", A, parseOdds(e.h2h.away), ref.probs[A], ref, false);
    }
  }
  if (e.spreads) {
    const line = parseLine(e.spreads.line);
    const ref = line == null ? null : pickReference(referenceLines(event, "spreads", cfg), line);
    if (ref) {
      // Ev sahibi farkı M ~ N(mu, SD). Ev sahibi h handikabıyla kazanır: M + h > 0.
      const sd = sportOf(event).spreadSd || SPREAD_SD;
      const mu = sd * normInv(ref.probs[H]) - ref.line;
      const pHome = normCdf((mu + line) / sd);
      const adj = ref.line !== line;
      const fmt = (x) => (x > 0 ? "+" : "") + x;
      push("spreads", "home", `${H} ${fmt(line)}`, parseOdds(e.spreads.home), pHome, ref, adj);
      push("spreads", "away", `${A} ${fmt(-line)}`, parseOdds(e.spreads.away), 1 - pHome, ref, adj);
    }
  }
  if (e.totals) {
    const line = parseLine(e.totals.line);
    const ref = line == null ? null : pickReference(referenceLines(event, "totals", cfg), line);
    if (ref) {
      const sd = sportOf(event).totalSd || TOTAL_SD;
      const mu = ref.line + sd * normInv(ref.probs.Over);
      const pOver = normCdf((mu - line) / sd);
      const adj = ref.line !== line;
      push("totals", "over", `Üst ${line}`, parseOdds(e.totals.over), pOver, ref, adj);
      push("totals", "under", `Alt ${line}`, parseOdds(e.totals.under), 1 - pOver, ref, adj);
    }
  }
  return res;
}

/**
 * MBS kuralına uyan kuponları üretir. Her maçtan en fazla bir seçim alınır (aynı maç kombine edilemez).
 * Kupon geçerli: seçim sayısı >= kupondaki en yüksek MBS. Maçların bağımsız olduğu varsayılır.
 */
export function buildCoupons(selections, options = {}) {
  const cfg = { ...DEFAULTS, maxLegs: 4, limit: 5, ...options };
  const byEvent = new Map();
  for (const s of selections) {
    if (s.edge <= 0) continue;
    const cur = byEvent.get(s.event_id);
    if (!cur || s.edge > cur.edge) byEvent.set(s.event_id, s);
  }
  const cands = [...byEvent.values()].sort((a, b) => b.edge - a.edge).slice(0, 14);
  const coupons = [];
  const walk = (start, legs) => {
    if (legs.length) {
      const need = Math.max(...legs.map((l) => l.mbs));
      if (legs.length >= need) {
        const P = legs.reduce((x, l) => x * l.fair_probability, 1);
        const O = legs.reduce((x, l) => x * l.odds, 1);
        const edge = P * O - 1;
        if (edge >= cfg.minEdge) {
          const k = kellyFraction(P, O);
          coupons.push({
            legs: [...legs], probability: r(P), odds: r(O, 2), edge: r(edge), kelly: r(k),
            stake: r(cfg.bankroll * Math.min(k * cfg.kellyMultiplier, cfg.maxStakePct), 2),
          });
        }
      }
    }
    if (legs.length === cfg.maxLegs) return;
    for (let i = start; i < cands.length; i++) { legs.push(cands[i]); walk(i + 1, legs); legs.pop(); }
  };
  walk(0, []);
  // Beklenen log büyümesine göre sırala: yüksek EV ama düşük olasılıklı uzun kuponları cezalandırır.
  const growth = (c) => {
    const f = Math.min(c.kelly * cfg.kellyMultiplier, cfg.maxStakePct);
    return c.probability * Math.log(1 + f * (c.odds - 1)) + (1 - c.probability) * Math.log(1 - f);
  };
  coupons.sort((a, b) => growth(b) - growth(a) || b.edge - a.edge);
  return coupons.slice(0, cfg.limit);
}

// ================================================================ sporlar
// spreadSd / totalSd: iddaa çizgisi referanstan farklıysa kullanılan normal dağılım sapmaları (yaklaşık).
const BASKET = { h2h: "Maç Sonucu", spreads: "Handikap", totals: "Toplam Sayı" };
export const SPORTS = {
  // reg: normal süre modeli. sd: normal süre fark sapması, tieRate: uzatmaya gitme oranı (μ=0 iken),
  // totalSd: normal süre toplam sapması, otPoints: uzatmada eklenen ortalama toplam sayı.
  nba: {
    id: "nba", key: "basketball_nba", name: "NBA", labels: BASKET, spreadSd: 12.5, totalSd: 18.5, model: "normal",
    reg: { sd: 12, tieRate: 0.06, totalSd: 17.5, otPoints: 21 },
  },
  euroleague: {
    id: "euroleague", key: "basketball_euroleague", name: "EuroLeague", labels: BASKET, spreadSd: 11.5, totalSd: 15.5, model: "normal",
    reg: { sd: 11, tieRate: 0.05, totalSd: 15, otPoints: 19 },
  },
  nfl: {
    id: "nfl", key: "americanfootball_nfl", name: "NFL", spreadSd: 13.5, totalSd: 13.5, model: "normal",
    reg: { sd: 13.5, tieRate: 0.055, totalSd: 13, otPoints: 5 },
    labels: { h2h: "Maç Sonucu (uzt. dahil)", spreads: "Handikap", totals: "Toplam Sayı" },
  },
  nhl: {
    id: "nhl", key: "icehockey_nhl", name: "NHL", model: "hockey",
    labels: { h2h: "Maç Sonucu (uzt. dahil)", spreads: "Handikap (uzt. dahil)", totals: "Toplam Gol (uzt. dahil)" },
  },
};
const BY_KEY = Object.fromEntries(Object.values(SPORTS).map((x) => [x.key, x]));
export const sportOf = (event) => BY_KEY[event.sport_key] || SPORTS.nba;

// ================================================================ hokey modeli (Poisson)
// Normal süre golleri bağımsız Poisson; beraberlik olasılığı NHL gerçeğine (~%22-23) göre şişirilir.
// Uzatma/penaltılarda: kazanan yaklaşık yazı-tura, toplam gole +1 eklenir (ABD şirketleri penaltı galibiyetini gol sayar).
export const HOCKEY = { maxGoals: 15, drawInflation: 0.4, otHomeShare: 0.5 };

function poissonPmf(l, n) {
  const out = [Math.exp(-l)];
  for (let k = 1; k <= n; k++) out.push(out[k - 1] * l / k);
  return out;
}

/** Normal süre skor olasılık matrisi M[i][j] (i: ev sahibi golü, j: deplasman golü). */
export function hockeyMatrix(lh, la) {
  const n = HOCKEY.maxGoals, a = poissonPmf(lh, n), b = poissonPmf(la, n);
  const M = a.map((pa, i) => b.map((pb, j) => pa * pb * (i === j ? 1 + HOCKEY.drawInflation : 1)));
  const s = M.flat().reduce((x, y) => x + y, 0);
  return M.map((row) => row.map((v) => v / s));
}

function sumWhere(M, f) {
  let s = 0;
  for (let i = 0; i < M.length; i++) for (let j = 0; j < M.length; j++) if (f(i, j)) s += M[i][j];
  return s;
}
const fullHomeWin = (M) => sumWhere(M, (i, j) => i > j) + HOCKEY.otHomeShare * sumWhere(M, (i, j) => i === j);
const fullTotal = (i, j) => i + j + (i === j ? 1 : 0);
function overNoPush(M, line, total) {
  const win = sumWhere(M, (i, j) => total(i, j) > line), push = sumWhere(M, (i, j) => total(i, j) === line);
  return win / (1 - push);
}

/** Uzatmalar dahil ev sahibi kazanma olasılığı ve toplam çizgisi/üst olasılığından gol beklentilerini çözer. */
export function fitHockey(pHomeFull, totalLine, pOver) {
  const solveShare = (mu) => bisect((s) => fullHomeWin(hockeyMatrix(mu * s, mu * (1 - s))) - pHomeFull, 0.05, 0.95, 1e-7, 60);
  const mu = bisect((mu) => {
    const s = solveShare(mu);
    return overNoPush(hockeyMatrix(mu * s, mu * (1 - s)), totalLine, fullTotal) - pOver;
  }, 2, 11, 1e-7, 60);
  const s = solveShare(mu);
  return { lh: mu * s, la: mu * (1 - s) };
}

/** Bir NHL maçı için referans oranlardan normal süre modeli kurar. */
export function hockeyModel(event, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const ml = pickReference(referenceLines(event, "h2h", cfg), null);
  const tots = referenceLines(event, "totals", cfg);
  if (!ml || !tots.length) return null;
  const pool = tots.some((r) => r.kind === "sharp") ? tots.filter((r) => r.kind === "sharp") : tots;
  const main = pool.reduce((b, r) => (Math.abs(r.probs.Over - 0.5) < Math.abs(b.probs.Over - 0.5) ? r : b));
  const { lh, la } = fitHockey(ml.probs[event.home_team], main.line, main.probs.Over);
  return { lh, la, M: hockeyMatrix(lh, la), reference: ml.kind, books: [...new Set([...ml.books, ...main.books])], totalLine: main.line };
}

/**
 * iddaa hokey oranları (normal süre). entry = { h2h:{home,draw,away}, spreads:{line,home,draw,away}, totals:{line,over,under}, mbs }
 * spreads.line ev sahibinin gol handikabı (ör. -1 ya da -1.5); tam sayı çizgide X (beraberlik) seçeneği vardır.
 */
export function evaluateIddaaHockey(event, entry, options = {}) {
  const model = hockeyModel(event, options);
  if (!model) return [];
  const { M } = model, H = event.home_team, A = event.away_team, e = entry || {};
  const h = e.spreads ? parseLine(e.spreads.line) : null;
  const L = e.totals ? parseLine(e.totals.line) : null;
  const res = [];
  const push = (market, side, label, odds, win, pushP = 0) => {
    if (odds == null) return;
    const p = win + pushP / odds; // iade olasılığını içeren etkin olasılık: EV = p*o - 1
    res.push({
      event_id: event.id, match: `${H} – ${A}`, commence_time: event.commence_time, market,
      market_label: { h2h: "Maç Sonucu (normal süre)", spreads: "Handikap (normal süre)", totals: "Alt/Üst (normal süre)" }[market],
      side, line: market === "h2h" ? null : market === "spreads" ? h : L, label, odds, fair_probability: r(p), fair_odds: r((1 - pushP) / win, 3), edge: r(p * odds - 1),
      reference: model.reference, reference_books: model.books, reference_line: null, adjusted: true, model: true,
      mbs: Number(e.mbs) || 1,
    });
  };
  if (e.h2h) {
    push("h2h", "home", `1 · ${H}`, parseOdds(e.h2h.home), sumWhere(M, (i, j) => i > j));
    push("h2h", "draw", "X · Beraberlik", parseOdds(e.h2h.draw), sumWhere(M, (i, j) => i === j));
    push("h2h", "away", `2 · ${A}`, parseOdds(e.h2h.away), sumWhere(M, (i, j) => i < j));
  }
  if (h != null) {
    const d = (i, j) => i - j + h;
    const f = (x) => (x > 0 ? "+" : "") + x;
    push("spreads", "home", `${H} (${f(h)})`, parseOdds(e.spreads.home), sumWhere(M, (i, j) => d(i, j) > 0));
    if (Number.isInteger(h)) push("spreads", "draw", `X (${f(h)})`, parseOdds(e.spreads.draw), sumWhere(M, (i, j) => d(i, j) === 0));
    push("spreads", "away", `${A} (${f(-h)})`, parseOdds(e.spreads.away), sumWhere(M, (i, j) => d(i, j) < 0));
  }
  if (L != null) {
    const pushP = sumWhere(M, (i, j) => i + j === L);
    push("totals", "over", `Üst ${L}`, parseOdds(e.totals.over), sumWhere(M, (i, j) => i + j > L), pushP);
    push("totals", "under", `Alt ${L}`, parseOdds(e.totals.under), sumWhere(M, (i, j) => i + j < L), pushP);
  }
  return res;
}

// ================================================================ normal süre modeli (basketbol, NFL)
// iddaa uzatmaları saymıyorsa: normal süre farkı ayrık normal dağılım; fark=0 (uzatmaya gitme) olasılığı
// lige özgü gerçek orana göre şişirilir. Uzatmada kazanan yazı-tura. Model Pinnacle'ın uzatmalar dahil
// maç sonucu (ve varsa toplam) oranlarına uydurulur.
const GRID = 80;
function marginPmf(mu, sd, kappa) {
  const pmf = [];
  for (let k = -GRID; k <= GRID; k++) pmf.push(normCdf((k + 0.5 - mu) / sd) - normCdf((k - 0.5 - mu) / sd));
  pmf[GRID] *= kappa;
  const s = pmf.reduce((a, b) => a + b, 0);
  return pmf.map((v) => v / s);
}
const tieKappa = (reg) => {
  const p0 = normCdf(0.5 / reg.sd) - normCdf(-0.5 / reg.sd);
  return (reg.tieRate * (1 - p0)) / (p0 * (1 - reg.tieRate));
};
const pmfSum = (pmf, f) => pmf.reduce((s, v, i) => s + (f(i - GRID) ? v : 0), 0);

/** Normal süre modeli: { pmf (ev sahibi farkı), total (normal süre toplamı: {mu, sd}) , ... } */
export function regulationModel(event, options = {}) {
  const sp = sportOf(event);
  if (!sp.reg) return null;
  const cfg = { ...DEFAULTS, ...options };
  const ml = pickReference(referenceLines(event, "h2h", cfg), null);
  if (!ml) return null;
  const kappa = tieKappa(sp.reg);
  const pFull = ml.probs[event.home_team];
  const homeFull = (mu) => { const pmf = marginPmf(mu, sp.reg.sd, kappa); return pmfSum(pmf, (k) => k > 0) + 0.5 * pmf[GRID]; };
  const mu = bisect((m) => homeFull(m) - pFull, -45, 45, 1e-9, 80);
  const pmf = marginPmf(mu, sp.reg.sd, kappa);
  const pTie = pmf[GRID];

  let total = null;
  const tots = referenceLines(event, "totals", cfg);
  if (tots.length) {
    const pool = tots.some((r) => r.kind === "sharp") ? tots.filter((r) => r.kind === "sharp") : tots;
    const main = pool.reduce((b, r) => (Math.abs(r.probs.Over - 0.5) < Math.abs(b.probs.Over - 0.5) ? r : b));
    const sd = sp.reg.totalSd, ot = sp.reg.otPoints, L0 = main.line;
    // Uzatmalar dahil üst = normal sürede üst + (berabere ve normal süre toplamı L0-ot ile L0 arasında)
    const fullOver = (tau) => (1 - normCdf((L0 - tau) / sd)) + pTie * (normCdf((L0 - tau) / sd) - normCdf((L0 - ot - tau) / sd));
    const tau = bisect((t) => fullOver(t) - main.probs.Over, L0 - 80, L0 + 80, 1e-9, 80);
    total = { mu: tau, sd, refLine: L0 };
  }
  return { mu, pmf, pTie, total, reference: ml.kind, books: [...new Set([...ml.books, ...(tots[0]?.books || [])])] };
}

// Normal süre toplamının ayrık olasılıkları
const totalProb = (t, f) => {
  let s = 0;
  const lo = Math.floor(t.mu - 8 * t.sd), hi = Math.ceil(t.mu + 8 * t.sd);
  for (let k = lo; k <= hi; k++) if (f(k)) s += normCdf((k + 0.5 - t.mu) / t.sd) - normCdf((k - 0.5 - t.mu) / t.sd);
  return s;
};

/** iddaa normal süre değerlendirmesi (basketbol/NFL). entry hokey ile aynı biçimde: MS 1-X-2, handikapta tam sayı çizgide X. */
export function evaluateIddaaRegulation(event, entry, options = {}) {
  const model = regulationModel(event, options);
  if (!model) return [];
  const { pmf } = model, H = event.home_team, A = event.away_team, e = entry || {};
  const h = e.spreads ? parseLine(e.spreads.line) : null;
  const L = e.totals ? parseLine(e.totals.line) : null;
  const res = [];
  const push = (market, side, label, odds, win, pushP = 0) => {
    if (odds == null || !(win > 0)) return;
    const p = win + pushP / odds;
    res.push({
      event_id: event.id, match: `${H} – ${A}`, commence_time: event.commence_time, market,
      market_label: { h2h: "Maç Sonucu (normal süre)", spreads: "Handikap (normal süre)", totals: "Alt/Üst (normal süre)" }[market],
      side, line: market === "h2h" ? null : market === "spreads" ? h : L, label, odds, fair_probability: r(p),
      fair_odds: r((1 - pushP) / win, 3), edge: r(p * odds - 1), reference: model.reference, reference_books: model.books,
      reference_line: null, adjusted: true, model: true, regulation: true, mbs: Number(e.mbs) || 1,
    });
  };
  if (e.h2h) {
    push("h2h", "home", `1 · ${H}`, parseOdds(e.h2h.home), pmfSum(pmf, (k) => k > 0));
    push("h2h", "draw", "X · Beraberlik", parseOdds(e.h2h.draw), model.pTie);
    push("h2h", "away", `2 · ${A}`, parseOdds(e.h2h.away), pmfSum(pmf, (k) => k < 0));
  }
  if (h != null) {
    const f = (x) => (x > 0 ? "+" : "") + x;
    const pushP = Number.isInteger(h) && parseOdds(e.spreads.draw) == null ? pmfSum(pmf, (k) => k + h === 0) : 0;
    push("spreads", "home", `${H} (${f(h)})`, parseOdds(e.spreads.home), pmfSum(pmf, (k) => k + h > 0), pushP);
    if (Number.isInteger(h)) push("spreads", "draw", `X (${f(h)})`, parseOdds(e.spreads.draw), pmfSum(pmf, (k) => k + h === 0));
    push("spreads", "away", `${A} (${f(-h)})`, parseOdds(e.spreads.away), pmfSum(pmf, (k) => k + h < 0), pushP);
  }
  if (L != null && model.total) {
    const pushP = totalProb(model.total, (k) => k === L);
    push("totals", "over", `Üst ${L}`, parseOdds(e.totals.over), totalProb(model.total, (k) => k > L), pushP);
    push("totals", "under", `Alt ${L}`, parseOdds(e.totals.under), totalProb(model.total, (k) => k < L), pushP);
  }
  return res;
}

/**
 * Spora ve kurala göre doğru iddaa değerlendiricisini seçer.
 * Hokey her zaman normal süredir (iddaa'da uzatma sayılmaz).
 * Basketbol/NFL varsayılan: uzatmalar dahil (iddaa NBA'de uzatmalar sayılır). Normal süre için
 * options.regulation = true ya da lig bazında options.regulationBySport = { nfl: true, ... }.
 */
export function evaluateIddaaAny(event, entry, options = {}) {
  const sp = sportOf(event);
  if (sp.model === "hockey") return evaluateIddaaHockey(event, entry, options);
  const reg = options.regulation ?? !!options.regulationBySport?.[sp.id];
  return reg ? evaluateIddaaRegulation(event, entry, options) : evaluateIddaa(event, entry, options);
}

// ================================================================ bahis kaydı
// Ortak "ayak" (leg) biçimi: { sport, event_id, commence_time, home, away, market, side, line, label, odds,
//   source: "book"|"iddaa", bookmaker, regulation, fair_prob, close_prob, status }
// side: home | away | draw | over | under; line: handikapta EV SAHİBİ çizgisi, toplamda toplam çizgisi.

/** Değerli bahis (şirket) satırını ayağa çevirir. */
export function legFromBet(b, sportId) {
  const side = b.selection === b.home_team ? "home" : b.selection === b.away_team ? "away" : b.selection === "Over" ? "over" : "under";
  const line = b.market === "h2h" ? null : b.market === "totals" ? b.point : side === "home" ? b.point : -b.point;
  return {
    sport: sportId, event_id: b.event_id, commence_time: b.commence_time, home: b.home_team, away: b.away_team,
    market: b.market, market_label: b.market_label, side, line, label: b.label, odds: b.price, source: "book",
    bookmaker: b.bookmaker_title, regulation: false, fair_prob: b.fair_probability, close_prob: null, status: "pending",
  };
}

/** iddaa değerlendirme satırını ayağa çevirir. */
export function legFromIddaa(x, event) {
  const sp = sportOf(event);
  return {
    sport: sp.id, event_id: x.event_id, commence_time: x.commence_time, home: event.home_team, away: event.away_team,
    market: x.market, market_label: x.market_label, side: x.side, line: x.line ?? null, label: x.label, odds: x.odds,
    source: "iddaa", bookmaker: "iddaa", regulation: sp.model === "hockey" || !!x.regulation, fair_prob: x.fair_probability, close_prob: null,
    status: "pending",
  };
}

/** Bir ayağın güncel adil olasılığı (maç başlamadan son görülen = kapanış değeri takibi için). */
export function currentFairProb(event, leg, options = {}) {
  if (leg.source === "iddaa") {
    const slot = { line: leg.line == null ? "" : String(leg.line), [leg.side]: String(leg.odds) };
    const rows = evaluateIddaaAny(event, { [leg.market]: slot }, { ...options, regulation: !!leg.regulation });
    return rows.find((r) => r.market === leg.market && r.side === leg.side)?.fair_probability ?? null;
  }
  const lineId = leg.market === "h2h" ? null : leg.line;
  const ref = referenceLines(event, leg.market, options).find((x) => (x.line ?? null) === lineId);
  if (!ref) return null;
  const name = { home: event.home_team, away: event.away_team, over: "Over", under: "Under" }[leg.side];
  return ref.probs[name] ?? null;
}

/** Skor verisinden ayağı sonuçlandırır: "won" | "lost" | "push" | null (bitmemiş ya da elle sonuçlanmalı). */
export function settleLeg(leg, game) {
  if (!game || !game.completed || !Array.isArray(game.scores) || leg.regulation) return null;
  const score = (team) => Number(game.scores.find((s) => s.name === team)?.score);
  const hs = score(leg.home), as = score(leg.away);
  if (!Number.isFinite(hs) || !Number.isFinite(as)) return null;
  const cmp = (x) => (x > 0 ? "won" : x < 0 ? "lost" : "push");
  if (leg.market === "h2h") {
    if (leg.side === "draw") return hs === as ? "won" : "lost";
    return cmp(leg.side === "home" ? hs - as : as - hs);
  }
  if (leg.market === "spreads") {
    const d = hs - as + leg.line;
    return leg.side === "home" ? cmp(d) : leg.side === "away" ? cmp(-d) : d === 0 ? "won" : "lost";
  }
  if (leg.market === "totals") {
    const t = hs + as - leg.line;
    return cmp(leg.side === "over" ? t : -t);
  }
  return null;
}

/** Ayak durumlarından kuponun durumunu ve kârını hesaplar. */
export function betOutcome(bet) {
  const st = bet.legs.map((l) => l.status);
  if (st.includes("lost")) return { status: "lost", profit: -bet.stake };
  if (st.includes("pending")) return { status: "pending", profit: 0 };
  if (st.every((s) => s === "push")) return { status: "push", profit: 0 };
  const odds = bet.legs.reduce((x, l) => x * (l.status === "push" ? 1 : l.odds), 1);
  return { status: "won", profit: r(bet.stake * (odds - 1), 2) };
}

/** Kayıt istatistikleri. */
export function ledgerStats(bets) {
  const settled = bets.filter((b) => ["won", "lost", "push"].includes(b.status));
  const pending = bets.filter((b) => b.status === "pending");
  const staked = settled.reduce((s, b) => s + b.stake, 0);
  const profit = settled.reduce((s, b) => s + (b.profit || 0), 0);
  const clv = bets.map(betClv).filter((x) => x != null);
  const decided = settled.filter((b) => b.status !== "push");
  return {
    count: bets.length, settled: settled.length, pending: pending.length,
    pending_stake: r(pending.reduce((s, b) => s + b.stake, 0), 2),
    staked: r(staked, 2), profit: r(profit, 2), roi: staked ? r(profit / staked) : 0,
    win_rate: decided.length ? r(decided.filter((b) => b.status === "won").length / decided.length) : 0,
    avg_ev: bets.length ? r(bets.reduce((s, b) => s + (b.ev || 0), 0) / bets.length) : 0,
    avg_clv: clv.length ? r(clv.reduce((a, b) => a + b, 0) / clv.length) : null, clv_count: clv.length,
    expected_profit: r(settled.reduce((s, b) => s + b.stake * (b.ev || 0), 0), 2),
  };
}

/** Kapanış oranına göre değer: alınan oran × son adil olasılık − 1 (tüm ayaklarda biliniyorsa). */
export function betClv(bet) {
  if (!bet.legs.every((l) => l.close_prob)) return null;
  return r(bet.legs.reduce((x, l) => x * l.odds * l.close_prob, 1) - 1);
}
