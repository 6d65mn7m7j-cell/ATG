import { findValueBets, summarize, listBookmakers, DEFAULTS } from "./valuebet.js";

const API = "https://api.the-odds-api.com/v4/sports/basketball_nba/odds";
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
  books: [], market: "all",
  ...store.get("settings", {}),
};
let snapshot = store.get("snapshot", null); // { events, fetchedAt, source, quota }
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
  loading = true;
  $("#refresh").classList.add("spin");
  try {
    let events, quota = null;
    if (settings.demo) {
      events = await (await fetch("sample_odds.json", { cache: "no-store" })).json();
    } else {
      const url = `${API}?regions=${encodeURIComponent(settings.regions)}&markets=h2h,spreads,totals&oddsFormat=decimal&dateFormat=iso`;
      const r = await fetch(url, { headers: { "x-api-key": settings.apiKey.trim() } });
      if (r.status === 401) throw new Error("API anahtarı geçersiz.");
      if (r.status === 429) throw new Error("İstek limitine ulaşıldı.");
      if (!r.ok) throw new Error(`Oran servisi hata verdi (${r.status}).`);
      quota = { remaining: r.headers.get("x-requests-remaining"), used: r.headers.get("x-requests-used") };
      events = await r.json();
    }
    snapshot = { events, fetchedAt: Date.now(), source: settings.demo ? "demo" : "live", quota };
    store.set("snapshot", snapshot);
  } catch (e) {
    error = e.message === "Failed to fetch" ? "Bağlantı kurulamadı. İnternet bağlantınızı kontrol edin." : e.message;
  } finally {
    loading = false;
    $("#refresh").classList.remove("spin");
    render();
  }
}

// ------------------------------------------------------------ çizim
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
    list.innerHTML = `<div class="empty"><b>Oranları taramak için yenileyin</b>Sağ üstteki düğmeye dokunun. Her tarama 6 API isteği harcar.<button class="btn" data-refresh>Şimdi tara</button></div>`;
    return;
  }
  list.innerHTML = res.bets.length
    ? renderBets(res.bets)
    : `<div class="empty"><b>Şu an değerli bahis yok</b>Maç günü NBA oranları genellikle verimlidir. Oranlar açıldığında veya sakatlık haberlerinden sonra tekrar tarayın ya da en düşük EV eşiğini düşürün.</div>`;
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

// ------------------------------------------------------------ olaylar
function bindSettings() {
  for (const k of ["apiKey", "regions", "minEdge", "reference", "devigMethod", "minOdds", "maxOdds", "bankroll", "kellyMultiplier", "maxStakePct"]) {
    const el = document.getElementById(k);
    el.value = settings[k];
    el.addEventListener("change", () => {
      settings[k] = el.value;
      saveSettings();
      if (k === "apiKey" && el.value) { settings.demo = false; $("#demo").checked = false; saveSettings(); }
      render();
    });
  }
  const demo = $("#demo");
  demo.checked = settings.demo;
  demo.addEventListener("change", () => { settings.demo = demo.checked; saveSettings(); snapshot = null; store.set("snapshot", null); refresh(); });
}

function show(view) {
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("on", v.id === view));
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
  if (view === "v-settings") renderBooks();
  window.scrollTo(0, 0);
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-m],[data-view],[data-go],[data-refresh],.card");
  if (!t) return;
  if (t.dataset.m) { settings.market = t.dataset.m; saveSettings(); render(); }
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

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

bindSettings();
render();
// Anahtar yoksa ve hiç veri yoksa ilk açılışta demo ile başlat
if (!snapshot && !settings.apiKey) { settings.demo = true; $("#demo").checked = true; saveSettings(); refresh(); }
