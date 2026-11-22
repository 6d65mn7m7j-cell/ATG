"""OddsPapi'yi bu uygulamanın ihtiyaçlarına göre bir kez dener (GitHub Actions'ta elle çalıştırılır).

Kontrol edilenler: hesap/kota, şirket listesi (Pinnacle ve Türk iddaa bayileri var mı), NBA/EuroLeague/NFL/NHL/UFC
turnuva kimlikleri, Pinnacle'ın bu liglerde verdiği marketler (normal süre 1X2 dahil) ve bir maçtaki şirket sayısı.

Yaklaşık 10 istek harcar. Anahtar URL parametresinde gider; günlüklere asla URL ya da anahtar yazdırılmaz.
"""

from __future__ import annotations

import json
import os
import sys
import time
from collections import Counter
from typing import Any

import httpx

API = "https://api.oddspapi.io/v4"
TURKISH = ("iddaa", "nesine", "bilyoner", "misli", "oley", "tuttur", "birebin", "sportoto", "hipodrom", "ekuri")
WANTED = {
    "basketball": [("NBA", ("nba",)), ("EuroLeague", ("euroleague",))],
    "ice-hockey": [("NHL", ("nhl",))],
    "american-football": [("NFL", ("nfl",))],
    "mma": [("UFC", ("ufc",))],
}
used = 0
last_call: dict[str, float] = {}


def get(path: str, **params: Any) -> Any:
    """Uç nokta başına hız sınırına uyar; hata mesajında URL/anahtar göstermez."""
    global used
    wait = 2.2 - (time.time() - last_call.get(path, 0))
    if wait > 0:
        time.sleep(wait)
    params["apiKey"] = KEY
    for attempt in range(3):
        try:
            r = httpx.get(f"{API}{path}", params=params, timeout=30)
        except httpx.HTTPError as exc:
            raise SystemExit(f"{path}: bağlantı hatası ({type(exc).__name__})") from None
        last_call[path] = time.time()
        if r.status_code == 429 and "RATE_LIMITED" in r.text and attempt < 2:
            time.sleep(3)
            continue
        break
    if path != "/account":
        used += 1
    if r.status_code != 200:
        try:
            err = r.json().get("error", {})
        except ValueError:
            err = {}
        raise SystemExit(f"{path}: HTTP {r.status_code} {err.get('code', '')} {err.get('message', '')}")
    return r.json()


def norm(s: Any) -> str:
    return str(s or "").lower()


def main() -> int:
    print("== Hesap (ücretsiz uç nokta)")
    acc = get("/account")
    safe = {k: v for k, v in acc.items() if not any(x in k.lower() for x in ("key", "email", "token", "id"))} if isinstance(acc, dict) else acc
    print(json.dumps(safe, ensure_ascii=False)[:600])

    print("\n== Şirketler")
    books = get("/bookmakers")
    slugs = [b.get("slug") for b in books]
    print(f"Toplam şirket: {len(books)}")
    pin = [s for s in slugs if "pinnacle" in norm(s)]
    print(f"Pinnacle slug(lar): {pin}")
    tr = [f"{b.get('bookmakerName')} ({b.get('slug')})" for b in books
          if any(t in norm(b.get("slug")) or t in norm(b.get("bookmakerName")) for t in TURKISH)]
    print(f"Türk iddaa bayileri: {tr or 'YOK'}")
    known = ["bet365", "1xbet", "marathonbet", "betfair-ex", "unibet", "williamhill", "sbobet", "betsson", "tipico", "draftkings", "fanduel"]
    print("Bilinen şirketler:", {k: any(norm(s).startswith(k) for s in slugs) for k in known})

    print("\n== Sporlar ve turnuvalar")
    sports = {norm(s.get("slug")): s.get("sportId") for s in get("/sports")}
    tournaments: dict[str, int] = {}
    for sport_slug, wanted in WANTED.items():
        sid = sports.get(sport_slug) or next((v for k, v in sports.items() if sport_slug.split("-")[-1] in k), None)
        if sid is None:
            print(f"{sport_slug}: spor bulunamadı (mevcut: {sorted(sports)[:40]})")
            continue
        tours = get("/tournaments", sportId=sid)
        for name, keys in wanted:
            cands = [t for t in tours if any(k == norm(t.get("tournamentSlug")) or k in norm(t.get("tournamentName")).split() for k in keys)]
            cands.sort(key=lambda t: -(t.get("futureFixtures") or 0) - (t.get("upcomingFixtures") or 0))
            if cands:
                t = cands[0]
                tournaments[name] = t["tournamentId"]
                print(f"{name}: id={t['tournamentId']} '{t.get('tournamentName')}' ({t.get('categoryName')}) "
                      f"yaklaşan={t.get('upcomingFixtures')} gelecek={t.get('futureFixtures')}")
            else:
                print(f"{name}: bulunamadı (sportId={sid}, {len(tours)} turnuva)")

    print("\n== Market tanımları")
    markets = get("/markets")
    mdef = {m.get("marketId"): m for m in markets} if isinstance(markets, list) else {}
    print(f"Toplam market tanımı: {len(mdef)}")

    if pin and tournaments:
        slug = pin[0]
        print(f"\n== Pinnacle oranları ({slug}) — 5 lig tek istekte")
        data = get("/odds-by-tournaments", tournamentIds=",".join(str(v) for v in tournaments.values()), bookmaker=slug)
        fixtures = data if isinstance(data, list) else data.get("data", [data]) if isinstance(data, dict) else []
        by_t = Counter()
        kinds: dict[int, Counter] = {}
        sample_fid = None
        for f in fixtures:
            tid = f.get("tournamentId")
            bo = (f.get("bookmakerOdds") or {}).get(slug) or {}
            mk = bo.get("markets") or {}
            if mk:
                by_t[tid] += 1
                sample_fid = sample_fid or (f.get("fixtureId") if tid == tournaments.get("NBA") else None)
            c = kinds.setdefault(tid, Counter())
            for mid in mk:
                d = mdef.get(int(mid)) if str(mid).isdigit() else None
                if d:
                    c[f"{d.get('marketType')}|{d.get('period')}"] += 1
        inv = {v: k for k, v in tournaments.items()}
        print(f"Dönen maç: {len(fixtures)}")
        for tid, n in by_t.items():
            top = ", ".join(f"{k}×{v}" for k, v in kinds.get(tid, Counter()).most_common(8))
            print(f"{inv.get(tid, tid)}: Pinnacle oranlı maç {n} | marketler: {top}")
        for name, tid in tournaments.items():
            if tid not in by_t:
                print(f"{name}: Pinnacle oranı YOK")

        if sample_fid:
            print("\n== Bir NBA maçında tüm şirketler (/v4/odds)")
            one = get("/odds", fixtureId=sample_fid, oddsFormat="decimal")
            bos = one.get("bookmakerOdds") or {}
            print(f"{one.get('participant1Name')} – {one.get('participant2Name')}: {len(bos)} şirket")
            print("Şirketler:", ", ".join(sorted(bos))[:1500])
            trb = [b for b in bos if any(t in norm(b) for t in TURKISH)]
            print("Bu maçta Türk bayisi:", trb or "YOK")

    print(f"\nBu çalışmada harcanan OddsPapi isteği: {used}")
    return 0


if __name__ == "__main__":
    KEY = os.environ.get("ODDSPAPI_KEY", "").strip()
    if not KEY:
        print("ODDSPAPI_KEY tanımlı değil.")
        sys.exit(1)
    sys.exit(main())
