"""OddsPapi meta verisini (market tanımları + takım adları) bir kez çekip uygulamaya gömülecek dosyaya yazar.

Market kimlikleri hiç değişmez; takım adları sezon boyunca sabittir. Bu yüzden uygulama bunları her seferinde
istemez, docs/oddspapi_meta.json dosyasından okur. --sample ile geliştirme/test için gerçek iddaa ve Pinnacle
oranlarından bir örnek de tests/data/oddspapi_sample.json'a yazılır.

GitHub Actions'ta çalışır (ODDSPAPI_KEY gizli değeri). ~5 istek (+2 örnek).
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import httpx

API = "https://api.oddspapi.io/v4"
ROOT = Path(__file__).resolve().parent.parent
# Takip edilen ligler: OddsPapi turnuva kimliği -> uygulamadaki lig kimliği
TOURNAMENTS = {132: "nba", 138: "euroleague", 234: "nhl", 31: "nfl"}
SPORT_SLUGS = {"basketball": ("nba", "euroleague"), "ice-hockey": ("nhl",), "american-football": ("nfl",)}
# Ana marketler: uzatmalı (result) ve normal süre (fulltime) maç sonucu, handikap, alt/üst
MARKET_TYPES = {"moneyline", "1x2", "spreads", "totals"}
PERIODS = {"result", "fulltime"}
used = 0
_last: dict[str, float] = {}


def get(path: str, **params: Any) -> Any:
    global used
    wait = 1.2 - (time.time() - _last.get(path, 0))
    if wait > 0:
        time.sleep(wait)
    params["apiKey"] = KEY
    for attempt in range(3):
        try:
            r = httpx.get(f"{API}{path}", params=params, timeout=60)
        except httpx.HTTPError as exc:
            raise SystemExit(f"{path}: bağlantı hatası ({type(exc).__name__})") from None
        _last[path] = time.time()
        if r.status_code == 429 and "RATE_LIMITED" in r.text and attempt < 2:
            time.sleep(2)
            continue
        break
    used += 1
    if r.status_code != 200:
        err = r.json().get("error", {}) if r.headers.get("content-type", "").startswith("application/json") else {}
        raise SystemExit(f"{path}: HTTP {r.status_code} {err.get('code', '')} {err.get('message', '')}")
    return r.json()


def main() -> int:
    sports = {s["slug"]: s["sportId"] for s in get("/sports")}
    sport_ids = {}
    for slug in SPORT_SLUGS:
        sid = sports.get(slug) or next((v for k, v in sports.items() if slug.split("-")[-1] in k), None)
        if sid is None:
            raise SystemExit(f"Spor bulunamadı: {slug}")
        sport_ids[slug] = sid

    participants: dict[str, str] = {}
    for slug, sid in sport_ids.items():
        participants.update({str(k): v for k, v in get("/participants", sportId=sid).items()})

    wanted_sports = set(sport_ids.values())
    markets = {}
    for m in get("/markets"):
        if m.get("sportId") in wanted_sports and m.get("marketType") in MARKET_TYPES and m.get("period") in PERIODS and not m.get("playerProp"):
            markets[str(m["marketId"])] = {
                "s": m["sportId"], "t": m["marketType"], "p": m["period"], "h": m.get("handicap") or 0,
                "o": {str(o["outcomeId"]): o["outcomeName"] for o in m.get("outcomes", [])},
            }

    meta = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "tournaments": {str(k): v for k, v in TOURNAMENTS.items()},
        "sports": {v: k for k, v in sport_ids.items()},
        "participants": participants,
        "markets": markets,
    }
    out = ROOT / "docs" / "oddspapi_meta.json"
    out.write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Yazıldı: {out.name} · {len(participants)} takım · {len(markets)} market · {out.stat().st_size // 1024} KB")

    if "--sample" in sys.argv:
        ids = ",".join(str(k) for k in TOURNAMENTS)
        sample = {bk: get("/odds-by-tournaments", tournamentIds=ids, bookmaker=bk) for bk in ("iddaa", "pinnacle")}
        dst = ROOT / "tests" / "data" / "oddspapi_sample.json"
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_text(json.dumps(sample, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"Örnek oranlar yazıldı: {dst.name} · iddaa {len(sample['iddaa'])} maç, pinnacle {len(sample['pinnacle'])} maç")

    print(f"Harcanan OddsPapi isteği: {used}")
    return 0


if __name__ == "__main__":
    KEY = os.environ.get("ODDSPAPI_KEY", "").strip()
    if not KEY:
        print("ODDSPAPI_KEY tanımlı değil.")
        sys.exit(1)
    sys.exit(main())
