import {
  findValueBets, summarize, listBookmakers, DEFAULTS, evaluateIddaaAny, buildCoupons, SPORTS, sportOf,
  legFromBet, legFromIddaa, currentFairProb, settleLeg, betOutcome, ledgerStats, betClv,
} from "./valuebet.js?v=10";

const API = (sport) => `https://api.the-odds-api.com/v4/sports/${SPORTS[sport].key}/odds`;
const ALL_MARKETS = ["h2h", "spreads", "totals"];
const marketsOf = (sport) => SPORTS[sport].markets || ALL_MARKETS;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (x) => (x * 100).toFixed(1) + "%";
const money = (x) => x.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (iso) => new Date(iso).toLocaleString("tr-TR", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const ago = (ts) => {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "az önce";
  if (m < 60) return `${m} dk önce`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} sa önce` : `${Math.round(h / 24)} gün önce`;
};

// ------------------------------------------------------------ kalıcı durum
const store = {
  get(k, d) { try { const v = localStorage.getItem("nbav_" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("nbav_" + k, JSON.stringify(v)); } catch { /* özel mod */ } },
};

const settings = {
  apiKey: "", demo: false, regions: "us,eu",
  minEdge: DEFAULTS.minEdge * 100, reference: DEFAULTS.reference, devigMethod: DEFAULTS.devigMethod,
  minOdds: DEFAULTS.minOdds, maxOdds: DEFAULTS.maxOdds, bankroll: DEFAULTS.bankroll,
  kellyMultiplier: String(DEFAULTS.kellyMultiplier), maxStakePct: DEFAULTS.maxStakePct * 100,
  books: [], market: "all", sport: "nba",
  ...store.get("settings", {}),
};
// Kuralı doğrulanmamış ligler için iddaa uzatma tercihi (true = uzatmalar sayılmaz).
// NBA ve NFL'de iddaa uzatmaları sayar, NHL'de saymaz: bunlar sabittir (SPORTS[..].iddaaRule).
settings.iddaaRegBySport = { euroleague: false, ...(settings.iddaaRegBySport || {}) };
delete settings.iddaaRegulation; // önceki sürümün tek (yanlış varsayılanlı) ayarı
// Her spor için ayrı son tarama: { events, fetchedAt, source, quota }
const snapshots = Object.fromEntries(Object.keys(SPORTS).map((k) => [k, store.get("snapshot_" + k, k === "nba" ? store.get("snapshot", null) : null)]));
if (!SPORTS[settings.sport]) settings.sport = "nba";
let snapshot = snapshots[settings.sport] || null;
const setSnapshot = (sport, snap) => { snapshots[sport] = snap; store.set("snapshot_" + sport, snap); if (sport === settings.sport) snapshot = snap; };
let ledger = store.get("ledger", []); // kayıtlı bahisler
const saveLedger = () => store.set("ledger", ledger);
let iddaa = store.get("iddaa", {}); // { eventId: { h2h:{home,away}, spreads:{line,home,away}, totals:{line,over,under}, mbs } }
let error = "";
let loading = false;

const saveSettings = () => store.set("settings", settings);

// ------------------------------------------------------------ veri çekme
async function refresh() {
  if (loading) return;
  error = "";
  if (!settings.demo && !settings.apiKey) {
    error = "API anahtarı yok. Ayarlar'dan anahtarınızı girin ya da demo verisini açın.";
    render();
    return;
  }
  if (settings.demo && settings.sport !== "nba") {
    error = `Demo verisi yalnızca NBA için. ${SPORTS[settings.sport].name} oranları için Ayarlar'dan API anahtarınızı girin.`;
    render();
    return;
  }
  loading = true;
  $("#refresh").classList.add("spin");
  try {
    let events, quota = null;
    const sport = settings.sport;
    if (settings.demo) {
      events = await (await fetch("sample_odds.json", { cache: "no-store" })).json();
    } else {
      const url = `${API(sport)}?regions=${encodeURIComponent(settings.regions)}&markets=${marketsOf(sport).join(",")}&oddsFormat=decimal&dateFormat=iso`;
      const r = await fetch(url, { headers: { "x-api-key": settings.apiKey.trim() } });
      if (r.status === 401) throw new Error("API anahtarı geçersiz.");
      if (r.status === 429) throw new Error("İstek limitine ulaşıldı.");
      if (!r.ok) throw new Error(`Oran servisi hata verdi (${r.status}).`);
      quota = { remaining: r.headers.get("x-requests-remaining"), used: r.headers.get("x-requests-used") };
      events = await r.json();
    }
    setSnapshot(sport, { events, fetchedAt: Date.now(), source: settings.demo ? "demo" : "live", quota });
    if (!settings.demo) updateClosing(events);
  } catch (e) {
    error = e.message === "Failed to fetch" ? "Bağlantı kurulamadı. İnternet bağlantınızı kontrol edin." : e.message;
  } finally {
    loading = false;
    $("#refresh").classList.remove("spin");
    render();
    if ($("#v-iddaa").classList.contains("on")) renderGames();
    if ($("#v-log").classList.contains("on")) renderLog();
  }
}

// Bekleyen bahislerin "son adil olasılığını" günceller (maç başlamadıysa) -> kapanış değeri (CLV).
function updateClosing(events) {
  const byId = new Map(events.map((e) => [e.id, e]));
  let changed = false;
  for (const bet of ledger) {
    for (const leg of bet.legs) {
      const ev = byId.get(leg.event_id);
      if (!ev || leg.status !== "pending" || Date.parse(ev.commence_time) <= Date.now()) continue;
      const p = currentFairProb(ev, leg, engineOptions());
      if (p) { leg.close_prob = p; leg.close_at = Date.now(); changed = true; }
    }
  }
  if (changed) saveLedger();
}

// ------------------------------------------------------------ çizim
function engineOptions() {
  return {
    minEdge: (Number(settings.minEdge) || 0) / 100,
    reference: settings.reference,
    devigMethod: settings.devigMethod,
    bankroll: Number(settings.bankroll) || 0,
    kellyMultiplier: Number(settings.kellyMultiplier),
    maxStakePct: (Number(settings.maxStakePct) || 0) / 100,
    regulationBySport: settings.iddaaRegBySport,
  };
}

function compute() {
  if (!snapshot) return null;
  const avail = marketsOf(settings.sport);
  const markets = settings.market === "all" || !avail.includes(settings.market) ? avail : [settings.market];
  const bets = findValueBets(snapshot.events, {
    minEdge: (Number(settings.minEdge) || 0) / 100,
    reference: settings.reference,
    devigMethod: settings.devigMethod,
    minOdds: Number(settings.minOdds) || 1.01,
    maxOdds: Number(settings.maxOdds) || 100,
    bankroll: Number(settings.bankroll) || 0,
    kellyMultiplier: Number(settings.kellyMultiplier),
    maxStakePct: (Number(settings.maxStakePct) || 0) / 100,
    markets,
    labels: SPORTS[settings.sport].labels,
    bookmakers: settings.books.length ? settings.books : null,
  });
  return { bets, summary: summarize(snapshot.events, bets) };
}

function render() {
  const res = compute();
  const meta = [];
  if (snapshot) {
    meta.push(snapshot.source === "demo" ? "Demo verisi" : "Canlı oranlar");
    meta.push(ago(snapshot.fetchedAt));
    if (snapshot.quota?.remaining) meta.push(`kalan istek: ${snapshot.quota.remaining}`);
  }
  $("#meta").textContent = meta.join(" · ") || "Henüz tarama yapılmadı";
  $("#sportName").textContent = SPORTS[settings.sport].name;
  $("#sports").innerHTML = Object.values(SPORTS).map((x) => `<button class="chip ${x.id === settings.sport ? "on" : ""}" data-sport="${x.id}">${x.name}</button>`).join("");

  const avail = marketsOf(settings.sport);
  const chips = avail.length > 1 ? [["all", "Tümü"], ["h2h", "Maç Sonucu"], ["spreads", "Handikap"], ["totals", "Toplam"]] : [];
  $("#mchips").innerHTML = chips.map(([k, t]) => `<button class="chip ${settings.market === k ? "on" : ""}" data-m="${k}">${t}</button>`).join("");
  $("#mchips").hidden = !chips.length;

  const s = res?.summary;
  $("#stats").innerHTML = [
    ["Değerli bahis", s ? s.value_bets : "–", s ? `${s.events} maç` : ""],
    ["Ort. EV", s ? pct(s.avg_edge) : "–", s ? `en yüksek ${pct(s.max_edge)}` : ""],
    ["Beklenen kâr", s ? money(s.expected_profit) : "–", s ? `stake ${money(s.total_stake)}` : ""],
  ].map(([t, v, sub]) => `<div class="stat"><small>${t}</small><b>${v}</b><small>${sub}</small></div>`).join("");

  const list = $("#list");
  if (error) {
    list.innerHTML = `<div class="empty"><b class="err">${esc(error)}</b>${settings.apiKey || settings.demo ? "" : '<button class="btn" data-go="v-settings">Ayarlara git</button>'}</div>`;
    if (!res) return;
    list.innerHTML += renderBets(res.bets);
    return;
  }
  if (!res) {
    list.innerHTML = settings.demo && settings.sport !== "nba"
      ? `<div class="empty"><b>Demo verisi yalnızca NBA için</b>${SPORTS[settings.sport].name} oranları için Ayarlar'dan API anahtarınızı girin.</div>`
      : `<div class="empty"><b>Oranları taramak için yenileyin</b>Sağ üstteki düğmeye dokunun. Her tarama ${marketsOf(settings.sport).length * settings.regions.split(",").length} API isteği harcar.<button class="btn" data-refresh>Şimdi tara</button></div>`;
    return;
  }
  list.innerHTML = res.bets.length
    ? renderBets(res.bets)
    : `<div class="empty"><b>Şu an değerli bahis yok</b>Maç günü ${SPORTS[settings.sport].name} oranları genellikle verimlidir. Oranlar açıldığında veya sakatlık haberlerinden sonra tekrar tarayın ya da en düşük EV eşiğini düşürün.</div>`;
}

let shownBets = [];
function renderBets(bets) {
  shownBets = bets;
  return bets.map((b, i) => `
    <article class="card" data-i="${i}">
      <div class="top"><span>${esc(when(b.commence_time))}</span><span>${esc(b.market_label)}</span></div>
      <div class="match">${esc(b.away_team)} @ ${esc(b.home_team)}</div>
      <div class="row">
        <div class="pick"><b>${esc(b.label)}</b><small>${esc(b.bookmaker_title)} ${b.best_price ? '<span class="pill best">en iyi oran</span>' : ""}</small></div>
        <div class="price"><b>${b.price.toFixed(2)}</b><small>adil ${b.fair_odds.toFixed(2)}</small></div>
        <div class="ev">+${pct(b.edge)}</div>
      </div>
      <div class="details">
        <span>Önerilen stake</span><div><b>${money(b.stake)}</b></div>
        <span>Adil olasılık</span><div>${pct(b.fair_probability)}</div>
        <span>Oranın ima ettiği</span><div>${pct(b.implied_probability)}</div>
        <span>Tam Kelly</span><div>${pct(b.kelly)}</div>
        ${b.net_price < b.price ? `<span>Komisyon sonrası oran</span><div>${b.net_price.toFixed(2)}</div>` : ""}
        <span>Amerikan oran</span><div>${b.american > 0 ? "+" : ""}${b.american}</div>
        <span>Referans</span><div>${b.reference === "sharp" ? esc(b.reference_books[0]) : `<span class="pill cons">konsensüs · ${b.reference_books.length} şirket</span>`}</div>
        ${b.last_update ? `<span>Oran güncelleme</span><div>${esc(ago(Date.parse(b.last_update)))}</div>` : ""}
        <button class="btn small" data-save-bet="${i}">Kayda ekle · ${money(b.stake)}</button>
      </div>
    </article>`).join("");
}

function renderBooks() {
  const g = $("#booksGroup");
  g.querySelectorAll(".field.book").forEach((n) => n.remove());
  if (!snapshot) return;
  for (const b of listBookmakers(snapshot.events)) {
    const f = document.createElement("div");
    f.className = "field book";
    const id = "bk_" + b.key;
    f.innerHTML = `<label for="${id}">${esc(b.title)}</label><input id="${id}" class="switch" type="checkbox" ${settings.books.includes(b.key) ? "checked" : ""}>`;
    f.querySelector("input").addEventListener("change", (e) => {
      settings.books = e.target.checked ? [...new Set([...settings.books, b.key])] : settings.books.filter((k) => k !== b.key);
      saveSettings();
      render();
    });
    g.appendChild(f);
  }
}

// ------------------------------------------------------------ iddaa
const short = (team) => team.split(" ").slice(-1)[0];
const upcoming = () => (snapshot?.events || [])
  .filter((e) => Date.parse(e.commence_time) > Date.now() - 5 * 60000)
  .sort((a, b) => a.commence_time.localeCompare(b.commence_time));
const get = (o, path) => path.split(".").reduce((x, k) => x?.[k], o);

function renderGames() {
  const box = $("#games");
  const hockeySport = SPORTS[settings.sport].model === "hockey";
  const rule = SPORTS[settings.sport].iddaaRule;
  const reg = rule ? rule === "regulation" : !!settings.iddaaRegBySport[settings.sport];
  $("#regToggle").hidden = !!rule;
  $("#iddaaReg").checked = reg;
  $("#regSport").textContent = SPORTS[settings.sport].name;
  $("#iddaaIntro").textContent = marketsOf(settings.sport).length === 1
    ? "iddaa'da gördüğünüz dövüş kazananı oranlarını girin; Pinnacle'ın (yoksa piyasa ortalamasının) marjsız oranıyla karşılaştırılır. Beraberlik çok nadir olduğu için hesaba katılmaz. Ondalık için virgül kullanabilirsiniz."
    : hockeySport
    ? "iddaa'da buz hokeyi bahisleri normal süre (60 dk) sonucuna göredir: MS ve handikap 1-X-2, alt/üst normal süre golleri. Adil oranlar Pinnacle'ın uzatmalar dahil oranlarından Poisson gol modeliyle türetilir. Handikapta ev sahibinin gol handikabını girin (ör. -1 ya da -1,5). Ondalık için virgül kullanabilirsiniz."
    : reg
      ? `Uzatmalar sayılmaz: MS 1-X-2 (X = normal sürede beraberlik), handikap ve alt/üst normal süre skoruna göre. Adil oranlar Pinnacle'ın uzatmalar dahil oranlarından normal süre modeliyle türetilir (${SPORTS[settings.sport].name}'de maçların ~%${Math.round(SPORTS[settings.sport].reg.tieRate * 100)}'ı uzatmaya gider). Handikapta ev sahibinin çizgisini girin; tam sayı çizgide X de girilebilir. Ondalık için virgül kullanabilirsiniz.`
      : `Uzatmalar dahil${rule ? ` (iddaa ${SPORTS[settings.sport].name} kuralı)` : ""}: MS iki yönlü, handikap ve alt/üst uzatmalar dahil. Oranlar Pinnacle'ın marjsız oranıyla karşılaştırılır; çizgi farklıysa (ör. iddaa -2.5, referans -3.5) adil olasılık istatistiksel olarak düzeltilir. Ondalık için virgül kullanabilirsiniz.`;
  if (!snapshot) {
    box.innerHTML = `<div class="empty"><b>Önce oranları tarayın</b>Karşılaştırma için Pinnacle oranları gerekir.<button class="btn" data-refresh>Şimdi tara</button></div>`;
    renderCoupons([]);
    return;
  }
  const games = upcoming();
  if (!games.length) {
    box.innerHTML = `<div class="empty"><b>Başlamamış maç yok</b>Yeni maçları görmek için oranları yenileyin.</div>`;
    renderCoupons([]);
    return;
  }
  // hiçbir taramada olmayan (biten) maçların girişlerini temizle
  const ids = new Set(Object.values(snapshots).flatMap((sn) => (sn?.events || []).map((e) => e.id)));
  for (const k of Object.keys(iddaa)) if (!ids.has(k)) delete iddaa[k];
  store.set("iddaa", iddaa);

  const inp = (id, path, ph, mode = "decimal") =>
    `<input data-ev="${esc(id)}" data-path="${path}" inputmode="${mode}" placeholder="${esc(ph)}" value="${esc(get(iddaa[id], path) ?? "")}" autocomplete="off">`;
  box.innerHTML = games.map((g) => {
    const H = short(g.home_team), A = short(g.away_team), id = g.id;
    const mbs = iddaa[id]?.mbs ?? "1";
    const onlyH2h = marketsOf(settings.sport).length === 1;
    const rows = onlyH2h ? `
      <div class="mk"><span>Kazanan</span><i></i>${inp(id, "h2h.home", "1 · " + H)}${inp(id, "h2h.away", "2 · " + A)}</div>` : reg ? `
      <div class="mk mk5"><span>MS</span><i></i>${inp(id, "h2h.home", "1")}${inp(id, "h2h.draw", "X")}${inp(id, "h2h.away", "2")}</div>
      <div class="mk mk5"><span>Handikap</span>${inp(id, "spreads.line", H + " hnd", "text")}${inp(id, "spreads.home", "1")}${inp(id, "spreads.draw", "X")}${inp(id, "spreads.away", "2")}</div>
      <div class="mk mk5"><span>Alt / Üst</span>${inp(id, "totals.line", "Çizgi")}${inp(id, "totals.under", "Alt")}${inp(id, "totals.over", "Üst")}<i></i></div>` : `
      <div class="mk"><span>Maç Sonucu</span><i></i>${inp(id, "h2h.home", "1 · " + H)}${inp(id, "h2h.away", "2 · " + A)}</div>
      <div class="mk"><span>Handikap</span>${inp(id, "spreads.line", H + " hnd", "text")}${inp(id, "spreads.home", H)}${inp(id, "spreads.away", A)}</div>
      <div class="mk"><span>Alt / Üst</span>${inp(id, "totals.line", "Çizgi")}${inp(id, "totals.under", "Alt")}${inp(id, "totals.over", "Üst")}</div>`;
    return `
    <article class="card game" data-game="${esc(id)}">
      <div class="top"><span>${esc(when(g.commence_time))}</span><button class="linkbtn" data-clear="${esc(id)}">Temizle</button></div>
      <h4>${esc(g.home_team)} – ${esc(g.away_team)}</h4>
      ${rows}
      <div class="mbs"><span>MBS (en az kaç maçlı kupon)</span>
        <select data-ev="${esc(id)}" data-path="mbs">${[1, 2, 3, 4].map((n) => `<option ${String(mbs) === String(n) ? "selected" : ""}>${n}</option>`).join("")}</select>
      </div>
      <div class="evals" id="evals-${esc(id)}"></div>
    </article>`;
  }).join("");
  updateIddaa();
}

function updateIddaa() {
  const opts = engineOptions();
  const all = [];
  // Kuponlar tüm sporlardaki girişlerden kurulur (iddaa'da NBA ve NHL aynı kupona eklenebilir).
  for (const [sport, sn] of Object.entries(snapshots)) {
    if (sport === settings.sport || !sn) continue;
    for (const g of sn.events) {
      if (iddaa[g.id] && Date.parse(g.commence_time) > Date.now() - 5 * 60000) all.push(...evaluateIddaaAny(g, iddaa[g.id], opts));
    }
  }
  for (const g of upcoming()) {
    const el = document.getElementById("evals-" + g.id);
    if (!el) continue;
    const entry = iddaa[g.id];
    if (!entry) { el.innerHTML = ""; continue; }
    const rows = evaluateIddaaAny(g, entry, opts);
    all.push(...rows);
    const typed = ["h2h.home", "h2h.draw", "h2h.away", "spreads.home", "spreads.draw", "spreads.away", "totals.over", "totals.under"].some((p) => get(entry, p));
    if (!rows.length) {
      el.innerHTML = typed ? `<div class="ev-row"><div class="nm">Bu market için referans oran bulunamadı ya da çizgi eksik.</div></div>` : "";
      continue;
    }
    el.innerHTML = rows.map((x) => {
      const val = x.edge >= opts.minEdge;
      const note = x.model ? `model · ${x.reference === "sharp" ? x.reference_books[0] : "konsensüs"}` : x.adjusted ? `çizgi düzeltildi · ref. ${x.market === "spreads" ? (x.reference_line > 0 ? "+" : "") : ""}${x.reference_line}` : (x.reference === "sharp" ? x.reference_books[0] : "konsensüs");
      return `<div class="ev-row ${val ? "value" : ""}">
        <div class="nm">${esc(x.label)}<small>${esc(x.market_label)} · ${esc(note)}</small></div>
        <div class="od"><b>${x.odds.toFixed(2)}</b><br><small>adil ${x.fair_odds.toFixed(2)}</small></div>
        <div class="tag ${x.edge > 0 ? "pos" : "neg"}">${x.edge > 0 ? "+" : ""}${pct(x.edge)}</div>
      </div>`;
    }).join("");
  }
  renderCoupons(all);
}

let shownCoupons = [];
function renderCoupons(selections) {
  const box = $("#coupons");
  if (!selections.length) {
    box.innerHTML = `<p class="intro">Oran girdikçe MBS kuralına uygun, pozitif beklenen değerli kuponlar burada listelenir.</p>`;
    return;
  }
  const coupons = buildCoupons(selections, engineOptions());
  shownCoupons = coupons;
  if (!coupons.length) {
    box.innerHTML = `<p class="intro">Girilen oranlarla MBS kuralına uyan ve eşiği (%${esc(settings.minEdge)}) geçen kupon yok. iddaa marjı yüksek olduğundan bu sık görülür.</p>`;
    return;
  }
  box.innerHTML = coupons.map((c, i) => `
    <article class="card coupon">
      <div class="top"><span>${i === 0 ? "En iyi öneri" : `Seçenek ${i + 1}`}</span><span>${c.legs.length === 1 ? "Tekli" : c.legs.length + "'li kupon"}</span></div>
      <div class="legs">${c.legs.map((l) => `<div><span>${esc(l.label)}<br><small>${esc(l.match)} · ${esc(l.market_label)} · MBS ${l.mbs}</small></span><b>${l.odds.toFixed(2)}</b></div>`).join("")}</div>
      <div class="sum">
        <div>Toplam oran<b>${c.odds.toFixed(2)}</b></div>
        <div>Kazanma ihtimali<b>${pct(c.probability)}</b></div>
        <div>EV<b style="color:var(--good)">+${pct(c.edge)}</b></div>
        <div>Stake<b>${money(c.stake)}</b></div>
      </div>
      <button class="btn small" data-save-coupon="${i}">Kayda ekle · ${money(c.stake)}</button>
    </article>`).join("") + `<p class="intro">Kupon olasılığı maçların bağımsız olduğu varsayımıyla hesaplanır. Bahisten önce oranların değişmediğini iddaa'da kontrol edin.</p>`;
}

document.addEventListener("input", (e) => {
  const t = e.target;
  if (!t.dataset?.ev) return;
  const id = t.dataset.ev, [a, b] = t.dataset.path.split(".");
  iddaa[id] ||= {};
  if (b) { iddaa[id][a] ||= {}; iddaa[id][a][b] = t.value; } else iddaa[id][a] = t.value;
  store.set("iddaa", iddaa);
  updateIddaa();
});

// ------------------------------------------------------------ bahis kaydı
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg; el.classList.add("on");
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove("on"), 2200);
}
const findEvent = (id) => { for (const sn of Object.values(snapshots)) { const e = sn?.events.find((x) => x.id === id); if (e) return e; } return null; };

function addBet(legs, stake, ev, source) {
  const key = legs.map((l) => `${l.event_id}|${l.market}|${l.side}|${l.line}|${l.odds}`).sort().join(";");
  if (ledger.some((b) => b.key === key && b.status === "pending")) { toast("Bu bahis zaten kayıtlı"); return; }
  ledger.unshift({
    id: uid(), key, created_at: Date.now(), source, legs, stake: Number(stake) || 0,
    odds: Math.round(legs.reduce((x, l) => x * l.odds, 1) * 100) / 100, ev, status: "pending", profit: 0,
  });
  saveLedger();
  toast("Kayda eklendi");
}
function saveValueBet(b) {
  if (!b) return;
  if (snapshot?.source === "demo") { toast("Demo bahisleri kaydedilmez"); return; }
  addBet([legFromBet(b, settings.sport)], b.stake, b.edge, "book");
}
function saveCoupon(c) {
  if (!c) return;
  const legs = c.legs.map((x) => { const ev = findEvent(x.event_id); return ev ? legFromIddaa(x, ev) : null; });
  if (legs.some((l) => !l)) { toast("Maç verisi bulunamadı"); return; }
  addBet(legs, c.stake, c.edge, "iddaa");
}

let logFilter = "all";
function renderLog() {
  const st = ledgerStats(ledger);
  const sign = (x) => (x > 0 ? "+" : "") + money(x);
  $("#logstats").innerHTML = [
    ["Kâr / zarar", `<span class="${st.profit > 0 ? "posv" : st.profit < 0 ? "negv" : ""}">${sign(st.profit)}</span>`, `${st.settled} sonuçlanan · ${st.pending} bekleyen`],
    ["ROI", pct(st.roi), `stake ${money(st.staked)}`],
    ["Kazanma", pct(st.win_rate), `beklenen kâr ${sign(st.expected_profit)}`],
    ["Ort. EV", pct(st.avg_ev), "bahis anında"],
    ["Ort. CLV", st.avg_clv == null ? "–" : pct(st.avg_clv), st.clv_count ? `${st.clv_count} bahiste` : "tarama gerekir"],
    ["Bekleyen", money(st.pending_stake), "açık stake"],
  ].map(([t, v, sub]) => `<div class="stat"><small>${t}</small><b>${v}</b><small>${sub}</small></div>`).join("");
  $("#logchart").innerHTML = profitChart(ledger);

  const filters = [["all", "Tümü"], ["pending", "Bekleyen"], ["settled", "Sonuçlanan"]];
  $("#logchips").innerHTML = filters.map(([k, t]) => `<button class="chip ${logFilter === k ? "on" : ""}" data-log="filter" data-id="${k}">${t}</button>`).join("");
  const rows = ledger.filter((b) => logFilter === "all" || (logFilter === "pending" ? b.status === "pending" : b.status !== "pending"));
  const label = { pending: "Bekliyor", won: "Kazandı", lost: "Kaybetti", push: "İade" };
  const icon = { pending: "•", won: "✓", lost: "✕", push: "↺" };
  $("#loglist").innerHTML = rows.length ? rows.map((b) => {
    const clv = betClv(b);
    const single = b.legs.length === 1;
    return `<article class="card logcard st-${b.status}">
      <div class="top"><span>${esc(new Date(b.created_at).toLocaleString("tr-TR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }))} · ${b.source === "iddaa" ? "iddaa" : esc(b.legs[0].bookmaker)}</span><span class="pill status">${label[b.status]}</span></div>
      <div class="legs">${b.legs.map((l) => `<div><span><i class="li li-${l.status}">${icon[l.status]}</i> ${esc(l.label)}<br><small>${esc(SPORTS[l.sport]?.name || "")} · ${esc(l.home)} – ${esc(l.away)} · ${esc(l.market_label)}</small></span><b>${l.odds.toFixed(2)}</b></div>`).join("")}</div>
      <div class="sum">
        <div>Stake<b>${money(b.stake)}</b></div>
        <div>Oran<b>${b.odds.toFixed(2)}</b></div>
        <div>EV<b>${b.ev == null ? "–" : pct(b.ev)}</b></div>
        <div>CLV<b class="${clv > 0 ? "posv" : clv < 0 ? "negv" : ""}">${clv == null ? "–" : (clv > 0 ? "+" : "") + pct(clv)}</b></div>
        ${b.status !== "pending" ? `<div>Sonuç<b class="${b.profit > 0 ? "posv" : b.profit < 0 ? "negv" : ""}">${sign(b.profit)}</b></div>` : ""}
      </div>
      ${b.status === "pending" ? `
      <div class="edit">
        <label>Stake<input data-log-edit="stake" data-id="${b.id}" inputmode="decimal" value="${b.stake}"></label>
        ${single ? `<label>Oran<input data-log-edit="odds" data-id="${b.id}" inputmode="decimal" value="${b.legs[0].odds}"></label>` : ""}
      </div>
      <div class="actions">
        <button data-log="won" data-id="${b.id}">Kazandı</button><button data-log="lost" data-id="${b.id}">Kaybetti</button><button data-log="push" data-id="${b.id}">İade</button><button data-log="del" data-id="${b.id}" class="del">Sil</button>
      </div>` : `<div class="actions"><button data-log="reopen" data-id="${b.id}">Geri al</button><button data-log="del" data-id="${b.id}" class="del">Sil</button></div>`}
    </article>`;
  }).join("") : `<div class="empty"><b>Henüz kayıt yok</b>Bahisler sekmesinde bir bahsin ayrıntısını açıp ya da iddaa kupon önerilerinde "Kayda ekle"ye dokunun.</div>`;
}

function profitChart(bets) {
  const settled = bets.filter((b) => b.status !== "pending").sort((a, b) => (a.settled_at || 0) - (b.settled_at || 0));
  if (settled.length < 2) return "";
  let c = 0;
  const pts = [0, ...settled.map((b) => (c += b.profit || 0))];
  const W = 320, H = 70, min = Math.min(...pts), max = Math.max(...pts), span = max - min || 1;
  const xy = pts.map((v, i) => `${(i / (pts.length - 1)) * W},${H - ((v - min) / span) * (H - 8) - 4}`).join(" ");
  const zero = H - ((0 - min) / span) * (H - 8) - 4;
  const col = c >= 0 ? "var(--good)" : "var(--bad)";
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Kümülatif kâr"><line x1="0" x2="${W}" y1="${zero}" y2="${zero}" stroke="var(--line)" stroke-dasharray="3 3"/><polyline points="${xy}" fill="none" stroke="${col}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg><small>Kümülatif kâr · ${settled.length} bahis</small>`;
}

function logAction(action, id) {
  if (action === "filter") { logFilter = id; renderLog(); return; }
  if (action === "settle") { settleFromScores(); return; }
  if (action === "csv") { exportCsv(); return; }
  if (action === "backup") { download(`bahis-yedek-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(ledger, null, 1), "application/json"); return; }
  if (action === "restore") { $("#restoreFile").click(); return; }
  const bet = ledger.find((b) => b.id === id);
  if (!bet) return;
  if (action === "del") { if (!confirm("Bu kayıt silinsin mi?")) return; ledger = ledger.filter((b) => b.id !== id); }
  else if (action === "reopen") { bet.status = "pending"; bet.profit = 0; bet.settled_at = null; bet.legs.forEach((l) => (l.status = "pending")); }
  else {
    // Elle sonuç: bekleyen ayaklar (tekli bahiste tek ayak) seçilen sonuca çekilir.
    bet.legs.forEach((l) => { if (l.status === "pending" || bet.legs.length === 1) l.status = action; });
    Object.assign(bet, betOutcome(bet), { settled_at: Date.now() });
  }
  saveLedger(); renderLog();
}

document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.dataset?.logEdit) {
    const bet = ledger.find((b) => b.id === t.dataset.id);
    const v = Number(String(t.value).replace(",", "."));
    if (!bet || !(v > 0)) return;
    if (t.dataset.logEdit === "stake") bet.stake = v;
    else if (v > 1) { bet.legs[0].odds = v; bet.odds = v; }
    saveLedger(); renderLog();
  }
});

async function settleFromScores() {
  const pend = ledger.filter((b) => b.status === "pending");
  const legs = pend.flatMap((b) => b.legs).filter((l) => l.status === "pending" && !l.regulation && Date.parse(l.commence_time) < Date.now() - 2.5 * 3600e3);
  const sports = [...new Set(legs.map((l) => l.sport))];
  const manual = pend.flatMap((b) => b.legs).filter((l) => l.status === "pending" && l.regulation).length;
  if (!sports.length) { toast(manual ? "Hokey (normal süre) bahislerini elle sonuçlandırın" : "Sonuçlanacak bitmiş maç yok"); return; }
  if (!settings.apiKey) { toast("API anahtarı gerekli"); return; }
  const btn = $("#settleBtn"); btn.disabled = true;
  let done = 0;
  try {
    for (const sp of sports) {
      const r = await fetch(`https://api.the-odds-api.com/v4/sports/${SPORTS[sp].key}/scores?daysFrom=3&dateFormat=iso`, { headers: { "x-api-key": settings.apiKey.trim() } });
      if (!r.ok) throw new Error(`Skor servisi hata verdi (${r.status})`);
      const games = new Map((await r.json()).map((g) => [g.id, g]));
      for (const l of legs.filter((x) => x.sport === sp)) {
        const res = settleLeg(l, games.get(l.event_id));
        if (res) { l.status = res; done++; }
      }
    }
    for (const b of pend) {
      const o = betOutcome(b);
      if (o.status !== "pending") Object.assign(b, o, { settled_at: Date.now() });
    }
    saveLedger(); renderLog();
    toast(done ? `${done} seçim sonuçlandı` : "Henüz biten maç sonucu yok");
  } catch (err) { toast(err.message); }
  finally { btn.disabled = false; }
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function exportCsv() {
  const head = ["tarih", "kaynak", "spor", "mac", "secim", "market", "oran", "stake", "ev", "clv", "durum", "kar"];
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = ledger.map((b) => [
    new Date(b.created_at).toISOString(), b.source === "iddaa" ? "iddaa" : b.legs[0].bookmaker,
    [...new Set(b.legs.map((l) => SPORTS[l.sport]?.name))].join("+"), b.legs.map((l) => `${l.home} - ${l.away}`).join(" | "),
    b.legs.map((l) => l.label).join(" | "), b.legs.map((l) => l.market_label).join(" | "),
    b.odds, b.stake, b.ev ?? "", betClv(b) ?? "", b.status, b.profit ?? 0,
  ].map(q).join(","));
  download(`bahisler-${new Date().toISOString().slice(0, 10)}.csv`, "\ufeff" + [head.join(","), ...rows].join("\n"), "text/csv");
}
$("#restoreFile").addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!Array.isArray(data) || data.some((b) => !b.id || !Array.isArray(b.legs))) throw new Error();
    const ids = new Set(ledger.map((b) => b.id));
    ledger = [...data.filter((b) => !ids.has(b.id)), ...ledger].sort((a, b) => b.created_at - a.created_at);
    saveLedger(); renderLog(); toast(`${data.length} kayıt yüklendi`);
  } catch { toast("Yedek dosyası okunamadı"); }
  e.target.value = "";
});

$("#iddaaReg").addEventListener("change", (e) => {
  settings.iddaaRegBySport[settings.sport] = e.target.checked; saveSettings(); renderGames();
});

// ------------------------------------------------------------ olaylar
function bindSettings() {
  for (const k of ["apiKey", "regions", "minEdge", "reference", "devigMethod", "minOdds", "maxOdds", "bankroll", "kellyMultiplier", "maxStakePct"]) {
    const el = document.getElementById(k);
    el.value = settings[k];
    el.addEventListener("change", () => {
      settings[k] = el.value;
      saveSettings();
      if ($("#v-iddaa").classList.contains("on")) updateIddaa();
      if (k === "apiKey" && el.value) { settings.demo = false; $("#demo").checked = false; saveSettings(); }
      render();
    });
  }
  const demo = $("#demo");
  demo.checked = settings.demo;
  demo.addEventListener("change", () => { settings.demo = demo.checked; saveSettings(); for (const k of Object.keys(SPORTS)) setSnapshot(k, null); refresh(); });
}

function show(view) {
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("on", v.id === view));
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
  if (view === "v-settings") renderBooks();
  if (view === "v-iddaa") renderGames();
  if (view === "v-log") renderLog();
  window.scrollTo(0, 0);
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-sport],[data-m],[data-view],[data-go],[data-refresh],[data-clear],[data-save-bet],[data-save-coupon],[data-log],.card");
  if (!t || t.classList.contains("game") || t.classList.contains("coupon") || t.classList.contains("logcard")) return;
  if (t.dataset.saveBet != null) { saveValueBet(shownBets[Number(t.dataset.saveBet)]); return; }
  if (t.dataset.saveCoupon != null) { saveCoupon(shownCoupons[Number(t.dataset.saveCoupon)]); return; }
  if (t.dataset.log) { logAction(t.dataset.log, t.dataset.id); return; }
  if (t.dataset.sport) {
    settings.sport = t.dataset.sport; saveSettings();
    snapshot = snapshots[settings.sport] || null; error = "";
    render();
    if ($("#v-iddaa").classList.contains("on")) renderGames();
    if ($("#v-settings").classList.contains("on")) renderBooks();
    window.scrollTo(0, 0);
    if (!snapshot && (settings.apiKey || settings.demo)) refresh();
  } else if (t.dataset.clear) { delete iddaa[t.dataset.clear]; store.set("iddaa", iddaa); renderGames(); }
  else if (t.dataset.m) { settings.market = t.dataset.m; saveSettings(); render(); }
  else if (t.dataset.view) show(t.dataset.view);
  else if (t.dataset.go) show(t.dataset.go);
  else if ("refresh" in t.dataset) refresh();
  else t.classList.toggle("open");
});
$("#refresh").addEventListener("click", refresh);

// iPhone'da Safari'den açılmışsa ana ekrana ekleme ipucu göster
const standalone = window.navigator.standalone || matchMedia("(display-mode: standalone)").matches;
if (/iPhone|iPad|iPod/.test(navigator.userAgent) && !standalone && !store.get("hideInstall", false)) {
  $("#install").hidden = false;
  $("#install").addEventListener("click", () => { $("#install").hidden = true; store.set("hideInstall", true); });
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(() => {});

bindSettings();
render();
// Anahtar yoksa ve hiç veri yoksa ilk açılışta demo ile başlat
if (!snapshot && !settings.apiKey) { settings.demo = true; $("#demo").checked = true; saveSettings(); refresh(); }
