"""OddsPapi: iddaa oranlarını Pinnacle ile otomatik karşılaştırma (docs/valuebet.js evaluateOddspapi'nin karşılığı).

OddsPapi'de market kimlikleri tüm şirketlerde aynıdır; iddaa'nın her ana marketi Pinnacle'ın aynı kimlikli marketiyle
doğrudan karşılaştırılır. "result" = uzatmalar dahil, "fulltime" = normal süre. participant1 ev sahibidir.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import httpx

from . import odds as om

API = "https://api.oddspapi.io/v4"
META_PATH = Path(__file__).resolve().parent.parent / "docs" / "oddspapi_meta.json"
OP_MARKET = {"moneyline": "h2h", "1x2": "h2h", "spreads": "spreads", "totals": "totals"}
OP_SIDE = {"1": "home", "2": "away", "X": "draw", "Over": "over", "Under": "under"}


class OddsPapiError(RuntimeError):
    pass


def load_meta(path: Path = META_PATH) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def fetch(key: str, meta: dict[str, Any], timeout: float = 30) -> tuple[list, list]:
    """iddaa ve Pinnacle oranlarını tüm takip edilen ligler için çeker (2 istek). Hata mesajında anahtar yer almaz."""
    ids = ",".join(meta["tournaments"])
    out = []
    for i, bk in enumerate(("iddaa", "pinnacle")):
        if i:
            time.sleep(1.2)  # uç nokta hız sınırı: çağrılar arası en az 1 sn
        try:
            r = httpx.get(f"{API}/odds-by-tournaments", params={"tournamentIds": ids, "bookmaker": bk, "apiKey": key}, timeout=timeout)
        except httpx.HTTPError as exc:
            raise OddsPapiError(f"OddsPapi bağlantı hatası ({type(exc).__name__})") from None
        if r.status_code != 200:
            try:
                err = r.json().get("error", {})
            except ValueError:
                err = {}
            raise OddsPapiError(f"OddsPapi {bk}: HTTP {r.status_code} {err.get('code', '')}")
        out.append(r.json())
    return out[0], out[1]


def _price(mk: dict | None, oid: str) -> float | None:
    p = (((mk or {}).get("outcomes") or {}).get(oid) or {}).get("players", {}).get("0")
    if not p or p.get("active") is False:
        return None
    try:
        v = float(p.get("price"))
    except (TypeError, ValueError):
        return None
    return v if v > 1 else None


def _label(def_: dict) -> str:
    per = "normal süre" if def_["p"] == "fulltime" else "uzt. dahil"
    return {"h2h": f"Maç Sonucu ({per})", "spreads": f"Handikap ({per})", "totals": f"Alt/Üst ({per})"}[OP_MARKET[def_["t"]]]


def _fmt(x: float) -> str:
    return f"+{x:g}" if x > 0 else f"{x:g}"


def evaluate(iddaa: list, pinnacle: list, meta: dict[str, Any], devig_method: str = "power", mbs: int = 1) -> dict[str, Any]:
    pin = {f["fixtureId"]: (f.get("bookmakerOdds") or {}).get("pinnacle") for f in pinnacle or []}
    rows: list[dict[str, Any]] = []
    margins: list[float] = []
    for f in iddaa or []:
        sport = meta["tournaments"].get(str(f.get("tournamentId")))
        if not sport or f.get("statusId") not in (None, 0):
            continue
        ib, pb = (f.get("bookmakerOdds") or {}).get("iddaa"), pin.get(f["fixtureId"])
        if not ib or not pb or ib.get("suspended") or pb.get("suspended"):
            continue
        home = meta["participants"].get(str(f.get("participant1Id")), "Ev sahibi")
        away = meta["participants"].get(str(f.get("participant2Id")), "Deplasman")
        for mid, mk in (ib.get("markets") or {}).items():
            def_, pmk = meta["markets"].get(mid), (pb.get("markets") or {}).get(mid)
            if not def_ or not pmk or mk.get("marketActive") is False or pmk.get("marketActive") is False:
                continue
            oids = list(def_["o"])
            pp = [_price(pmk, o) for o in oids]
            if any(x is None for x in pp):
                continue
            fair = om.devig(pp, devig_method)
            ip = [_price(mk, o) for o in oids]
            if all(x is not None for x in ip):
                margins.append(sum(1 / x for x in ip) - 1)
            market, h = OP_MARKET[def_["t"]], float(def_.get("h") or 0)
            h = int(h) if h == int(h) else h
            for i, oid in enumerate(oids):
                odds, side = ip[i], OP_SIDE.get(def_["o"][oid])
                if odds is None or side is None:
                    continue
                if market == "h2h":
                    label = {"home": f"1 · {home}", "draw": "X · Beraberlik", "away": f"2 · {away}"}[side]
                elif market == "spreads":
                    label = f"{home} ({_fmt(h)})" if side == "home" else f"{away} ({_fmt(-h)})"
                else:
                    label = f"{'Üst' if side == 'over' else 'Alt'} {h:g}"
                rows.append({
                    "source": "oddspapi", "sport": sport, "event_id": f["fixtureId"], "home": home, "away": away,
                    "match": f"{home} – {away}", "commence_time": f.get("startTime"), "market": market,
                    "market_label": _label(def_), "market_id": mid, "outcome_id": oid, "side": side,
                    "line": None if market == "h2h" else h, "label": label, "odds": odds,
                    "fair_probability": round(fair[i], 4), "fair_odds": round(1 / fair[i], 3), "pinnacle_odds": pp[i],
                    "edge": round(fair[i] * odds - 1, 4), "regulation": def_["p"] == "fulltime", "mbs": mbs,
                })
    rows.sort(key=lambda x: x["edge"], reverse=True)
    return {
        "rows": rows,
        "markets": len(margins),
        "fixtures": len({x["event_id"] for x in rows}),
        "avg_margin": round(sum(margins) / len(margins), 4) if margins else None,
    }
