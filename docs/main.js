import { findValueBets, summarize, listBookmakers, DEFAULTS, evaluateIddaaAny, buildCoupons, SPORTS } from "./valuebet.js?v=4";

const API = (sport) => `https://api.the-odds-api.com/v4/sports/${SPORTS[sport].key}/odds`;
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
// Her spor için ayrı son tarama: { events, fetchedAt, source, quota }
const snapshots = { nba: store.get("snapshot_nba", store.get("snapshot", null)), nhl: store.get("snapshot_nhl", null) };
let snapshot = snapshots[settings.sport] || null;
const setSnapshot = (sport, snap) => { snapshots[sport] = snap; store.set("snapshot_" + sport, snap); if (sport === settings.sport) snapshot = snap; };
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
      const url = `${API(sport)}?regions=${encodeURIComponent(settings.regions)}&markets=h2h,spreads,totals&oddsFormat=decimal&dateFormat=iso`;
      const r = await fetch(url, { headers: { "x-api-key": settings.apiKey.trim() } });
      if (r.status === 401) throw new Error("API anahtarı geçersiz.");
      if (r.status === 429) throw new Error("İstek limitine ulaşıldı.");
      if (!r.ok) throw new Error(`Oran servisi hata verdi (${r.status}).`);
      quota = { remaining: r.headers.get("x-requests-remaining"), used: r.headers.get("x-requests-used") };
      events = await r.json();
    }
    setSnapshot(sport, { events, fetchedAt: Date.now(), source: settings.demo ? "demo" : "live", quota });
  } catch (e) {
    error = e.message === "Failed to fetch" ? "Bağlantı kurulamadı. İnternet bağlantınızı kontrol edin." : e.message;
  } finally {
    loading = false;
    $("#refresh").classList.remove("spin");
    render();
    if ($("#v-iddaa").classList.contains("on")) renderGames();
  }
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
  };
}

function compute() {
  if (!snapshot) return null;
  const markets = settings.market === "all" ? ["h2h", "spreads", "totals"] : [settings.market];
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
  document.querySelectorAll("[data-sport]").forEach((b) => b.classList.toggle("on", b.dataset.sport === settings.sport));

  const chips = [["all", "Tümü"], ["h2h", "Maç Sonucu"], ["spreads", "Handikap"], ["totals", "Toplam"]];
  $("#mchips").innerHTML = chips.map(([k, t]) => `<button class="chip ${settings.market === k ? "on" : ""}" data-m="${k}">${t}</button>`).join("");

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
      : `<div class="empty"><b>Oranları taramak için yenileyin</b>Sağ üstteki düğmeye dokunun. Her tarama 6 API isteği harcar.<button class="btn" data-refresh>Şimdi tara</button></div>`;
    return;
  }
  list.innerHTML = res.bets.length
    ? renderBets(res.bets)
    : `<div class="empty"><b>Şu an değerli bahis yok</b>Maç günü ${SPORTS[settings.sport].name} oranları genellikle verimlidir. Oranlar açıldığında veya sakatlık haberlerinden sonra tekrar tarayın ya da en düşük EV eşiğini düşürün.</div>`;
}

function renderBets(bets) {
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
  $("#iddaaIntro").textContent = settings.sport === "nhl"
    ? "iddaa'da buz hokeyi bahisleri normal süre (60 dk) sonucuna göredir: MS ve handikap 1-X-2, alt/üst normal süre golleri. Adil oranlar Pinnacle'ın uzatmalar dahil oranlarından Poisson gol modeliyle türetilir. Handikapta ev sahibinin gol handikabını girin (ör. -1 ya da -1,5). Ondalık için virgül kullanabilirsiniz."
    : "iddaa'da gördüğünüz oranları girin; Pinnacle'ın marjsız oranıyla karşılaştırılır. Ondalık için virgül kullanabilirsiniz. Basketbolda iddaa oranları uzatmalar dahildir. Çizgi farklıysa (ör. iddaa -2.5, Pinnacle -3.5) adil olasılık istatistiksel olarak düzeltilir.";
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
    const hockey = settings.sport === "nhl";
    const rows = hockey ? `
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

function renderCoupons(selections) {
  const box = $("#coupons");
  if (!selections.length) {
    box.innerHTML = `<p class="intro">Oran girdikçe MBS kuralına uygun, pozitif beklenen değerli kuponlar burada listelenir.</p>`;
    return;
  }
  const coupons = buildCoupons(selections, engineOptions());
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
  demo.addEventListener("change", () => { settings.demo = demo.checked; saveSettings(); setSnapshot("nba", null); setSnapshot("nhl", null); refresh(); });
}

function show(view) {
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("on", v.id === view));
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
  if (view === "v-settings") renderBooks();
  if (view === "v-iddaa") renderGames();
  window.scrollTo(0, 0);
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-sport],[data-m],[data-view],[data-go],[data-refresh],[data-clear],.card");
  if (!t || t.classList.contains("game") || t.classList.contains("coupon")) return;
  if (t.dataset.sport) {
    settings.sport = t.dataset.sport; saveSettings();
    snapshot = snapshots[settings.sport] || null; error = "";
    render();
    if ($("#v-iddaa").classList.contains("on")) renderGames();
    if ($("#v-settings").classList.contains("on")) renderBooks();
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
