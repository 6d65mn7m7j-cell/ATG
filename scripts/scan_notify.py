"""Zamanlanmış tarama: değerli bahis bulursa ntfy ile telefona bildirim gönderir.

GitHub Actions'ta (.github/workflows/scan.yml) çalışır; yerelde de denenebilir:

    python scripts/scan_notify.py --demo --dry-run        # örnek veriyle, göndermeden
    ODDS_API_KEY=... NTFY_TOPIC=... python scripts/scan_notify.py

Ayarlar notify.json dosyasındadır. Gizli değerler ortam değişkenlerinden okunur:
    ODDS_API_KEY  The Odds API anahtarı
    NTFY_TOPIC    ntfy konu adı (şifre gibi davranır; kimseyle paylaşmayın)
    NTFY_SERVER   isteğe bağlı, varsayılan https://ntfy.sh

Kota koruması: maç listesi ücretsiz /events uç noktasından alınır; önümüzdeki saatlerde maçı
olmayan lig için oran isteği yapılmaz.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from valuebet.finder import FinderConfig, ValueBet, find_value_bets  # noqa: E402
from valuebet import oddspapi  # noqa: E402
from valuebet.providers import SPORT_MARKETS, SPORTS, SampleProvider  # noqa: E402

API = "https://api.the-odds-api.com/v4"
TR = timezone(timedelta(hours=3))  # günlük bütçe Türkiye gününe göre sıfırlanır
SPORT_NAMES = {"nba": "NBA", "nhl": "NHL", "euroleague": "EuroLeague", "nfl": "NFL", "ufc": "UFC/MMA"}
DEFAULT_CONFIG: dict[str, Any] = {
    "sports": ["nba", "nhl", "euroleague", "nfl", "ufc"],
    "regions": "eu",
    "hours_ahead": 8,
    "min_edge": 0.03,
    "max_edge": 0.25,
    "min_odds": 1.3,
    "max_odds": 5.0,
    "bookmakers": [],
    "bankroll": 1000,
    "kelly_multiplier": 0.25,
    "max_items": 8,
    "min_remaining_quota": 100,
    "daily_budget": 10,
    "iddaa_hours": [19, 1],
    "oddspapi_monthly_budget": 130,
    "book_alerts": True,  # False: yalnızca iddaa (The Odds API ile yabancı şirket taraması yapılmaz)
    "notify_when_empty": False,
    "app_url": "https://6d65mn7m7j-cell.github.io/ATG/",
}


def load_config(path: Path) -> dict[str, Any]:
    cfg = dict(DEFAULT_CONFIG)
    if path.exists():
        cfg.update(json.loads(path.read_text(encoding="utf-8")))
    unknown = [s for s in cfg["sports"] if s not in SPORTS]
    if unknown:
        raise SystemExit(f"notify.json: bilinmeyen lig(ler): {unknown}. Seçenekler: {list(SPORTS)}")
    return cfg


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


class OddsClient:
    def __init__(self, key: str):
        self.client = httpx.Client(timeout=20, headers={"x-api-key": key})
        self.remaining: int | None = None
        self.used_now = 0

    def _get(self, path: str, params: dict[str, Any]) -> Any:
        r = self.client.get(f"{API}{path}", params=params)
        if r.status_code == 401:
            raise SystemExit("API anahtarı geçersiz (401)")
        r.raise_for_status()
        if r.headers.get("x-requests-remaining") is not None:
            self.remaining = int(float(r.headers["x-requests-remaining"]))
            self.used_now += int(float(r.headers.get("x-requests-last", 0)))
        return r.json()

    def events(self, sport: str, start: datetime, end: datetime) -> list[dict[str, Any]]:
        # Bu uç nokta kotadan düşmez.
        return self._get(f"/sports/{SPORTS[sport]}/events", {"commenceTimeFrom": iso(start), "commenceTimeTo": iso(end)})

    def odds(self, sport: str, regions: str, start: datetime, end: datetime) -> list[dict[str, Any]]:
        return self._get(
            f"/sports/{SPORTS[sport]}/odds",
            {
                "regions": regions, "markets": ",".join(SPORT_MARKETS.get(sport, ("h2h", "spreads", "totals"))), "oddsFormat": "decimal",
                "dateFormat": "iso", "commenceTimeFrom": iso(start), "commenceTimeTo": iso(end),
            },
        )


def bet_key(b: ValueBet) -> str:
    return f"{b.event_id}|{b.market}|{b.selection}|{b.point}|{b.bookmaker}|{b.price}"


def iddaa_key(x: dict[str, Any]) -> str:
    return f"op|{x['event_id']}|{x['market_id']}|{x['outcome_id']}|{x['odds']}"


def format_message(found: list[tuple[str, ValueBet]], cfg: dict[str, Any], remaining: int | None,
                   iddaa_rows: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    found = sorted(found, key=lambda x: x[1].edge, reverse=True)
    iddaa_rows = sorted(iddaa_rows or [], key=lambda x: x["edge"], reverse=True)
    shown_i = iddaa_rows[: cfg["max_items"]]
    shown = found[: max(cfg["max_items"] - len(shown_i), 0)]
    sports = sorted({SPORT_NAMES[s] for s, _ in found} | {SPORT_NAMES[x["sport"]] for x in iddaa_rows})
    lines = []
    for x in shown_i:
        t = datetime.fromisoformat(x["commence_time"].replace("Z", "+00:00")).astimezone(TR)
        warn = " ⚠️ kontrol edin" if x["edge"] > cfg["max_edge"] else ""
        lines.append(
            f"iddaa · {SPORT_NAMES[x['sport']]} {t:%d.%m %H:%M} · {x['match']}\n"
            f"  {x['label']} ({x['market_label']}) @ {x['odds']:.2f} · Pinnacle {x['pinnacle_odds']:.2f} · EV +{x['edge'] * 100:.1f}%{warn}"
        )
    for sport, b in shown:
        t = datetime.fromisoformat(b.commence_time.replace("Z", "+00:00")).astimezone(timezone(timedelta(hours=3)))
        lines.append(
            f"{SPORT_NAMES[sport]} {t:%d.%m %H:%M} · {b.home_team} – {b.away_team}\n"
            f"  {b.label} ({b.market_label}) @ {b.price:.2f} {b.bookmaker_title} · EV +{b.edge * 100:.1f}% · stake {b.stake:.0f}"
        )
    hidden = len(found) - len(shown) + len(iddaa_rows) - len(shown_i)
    if hidden > 0:
        lines.append(f"…ve {hidden} bahis daha")
    if remaining is not None:
        lines.append(f"Kalan API isteği: {remaining}")
    total = len(found) + len(iddaa_rows)
    best = max([b.edge for _, b in found] + [x["edge"] for x in iddaa_rows], default=0)
    return {
        "title": f"{total} değerli bahis{f' (iddaa {len(iddaa_rows)})' if iddaa_rows else ''} · {', '.join(sports)}",
        "message": "\n".join(lines),
        "tags": ["moneybag"],
        "priority": 4 if best >= 0.05 else 3,
        "click": cfg["app_url"],
    }


def send_ntfy(payload: dict[str, Any], topic: str, server: str) -> None:
    r = httpx.post(server.rstrip("/"), json={"topic": topic, **payload}, timeout=15)
    r.raise_for_status()


def send_telegram(payload: dict[str, Any], token: str, chat_id: str) -> None:
    text = f"<b>{_html(payload['title'])}</b>\n{_html(payload['message'])}\n\n<a href=\"{payload['click']}\">Uygulamayı aç</a>"
    r = httpx.post(
        f"https://api.telegram.org/bot{token}/sendMessage",
        json={"chat_id": chat_id, "text": text[:4000], "parse_mode": "HTML", "disable_web_page_preview": True},
        timeout=15,
    )
    if r.status_code != 200:
        # Yanıtta anahtar yer almaz; yalnızca Telegram'ın hata açıklaması yazdırılır.
        raise SystemExit(f"Telegram hata verdi ({r.status_code}): {r.json().get('description', '')}")


def _html(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def notify(payload: dict[str, Any]) -> list[str]:
    """Tanımlı tüm kanallara gönderir (ntfy ve/veya Telegram); gönderilen kanalların adlarını döndürür."""
    sent = []
    topic = os.environ.get("NTFY_TOPIC", "").strip()
    if topic:
        send_ntfy(payload, topic, os.environ.get("NTFY_SERVER", "https://ntfy.sh"))
        sent.append("ntfy")
    token, chat = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip(), os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    if token and chat:
        send_telegram(payload, token, chat)
        sent.append("Telegram")
    return sent


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Değerli bahis taraması + ntfy bildirimi")
    ap.add_argument("--config", default=str(ROOT / "notify.json"))
    ap.add_argument("--state", default=str(ROOT / ".notify_state.json"), help="Bildirilen bahislerin listesi")
    ap.add_argument("--demo", action="store_true", help="API yerine örnek NBA verisi")
    ap.add_argument("--dry-run", action="store_true", help="Bildirim göndermeden mesajı yazdır")
    ap.add_argument("--test-notify", action="store_true", help="API'ye istek atmadan yalnızca deneme bildirimi gönder")
    args = ap.parse_args(argv)

    if args.test_notify:
        cfg = load_config(Path(args.config))
        sent = notify(
            {"title": "Deneme bildirimi ✅", "message": "Bağlantı çalışıyor. Değerli bahis bulunduğunda bildirimler buraya gelecek.",
             "tags": ["white_check_mark"], "priority": 4, "click": cfg["app_url"]},
        )
        if not sent:
            print("Bildirim kanalı tanımlı değil (NTFY_TOPIC ya da TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID).")
            return 1
        print(f"Deneme bildirimi gönderildi: {', '.join(sent)}")
        return 0

    cfg = load_config(Path(args.config))
    state_path = Path(args.state)
    try:
        raw = json.loads(state_path.read_text()) if state_path.exists() else {}
    except (json.JSONDecodeError, OSError):
        raw = {}
    # Durum: {"seen": {bahis: başlama}, "usage": {"date": "YYYY-MM-DD", "used": n, "warned": bool}}
    # (eski sürüm yalnızca seen sözlüğünü düz olarak tutuyordu)
    seen: dict[str, str] = raw.get("seen", {}) if "seen" in raw or "usage" in raw else raw
    today = datetime.now(TR).strftime("%Y-%m-%d")
    usage = raw.get("usage") if isinstance(raw.get("usage"), dict) and raw["usage"].get("date") == today else {"date": today, "used": 0}

    finder = FinderConfig(
        min_edge=cfg["min_edge"], max_edge=cfg["max_edge"], min_odds=cfg["min_odds"], max_odds=cfg["max_odds"],
        bookmakers=tuple(cfg["bookmakers"]) or None, bankroll=cfg["bankroll"], kelly_multiplier=cfg["kelly_multiplier"],
    )
    now = datetime.now(timezone.utc)
    end = now + timedelta(hours=cfg["hours_ahead"])
    found: list[tuple[str, ValueBet]] = []
    client: OddsClient | None = None

    if args.demo:
        found = [("nba", b) for b in find_value_bets(SampleProvider().fetch(), finder)]
    elif not cfg["book_alerts"]:
        print("Şirket taraması kapalı (book_alerts: false); yalnızca iddaa.")
    elif not os.environ.get("ODDS_API_KEY", "").strip():
        print("ODDS_API_KEY tanımlı değil; şirket taraması atlandı.")
    else:
        client = OddsClient(os.environ["ODDS_API_KEY"].strip())
        # Maçı olan ligleri ücretsiz /events ile bul; en yakın maçı olan lig önce taranır.
        queue = []
        for sport in cfg["sports"]:
            events = client.events(sport, now, end)
            if not events:
                print(f"{SPORT_NAMES[sport]}: önümüzdeki {cfg['hours_ahead']} saatte maç yok, istek harcanmadı.")
            else:
                queue.append((min(e["commence_time"] for e in events), sport))
        for _, sport in sorted(queue):
            cost = len(SPORT_MARKETS.get(sport, ("h2h", "spreads", "totals"))) * len(cfg["regions"].split(","))
            if usage["used"] + cost > cfg["daily_budget"]:
                print(f"{SPORT_NAMES[sport]}: günlük bütçe doldu ({usage['used']}/{cfg['daily_budget']} istek), atlandı.")
                continue
            if client.remaining is not None and client.remaining < cfg["min_remaining_quota"]:
                print(f"Kota düşük ({client.remaining}); {SPORT_NAMES[sport]} atlandı.")
                continue
            before = client.used_now
            odds = client.odds(sport, cfg["regions"], now, end)
            usage["used"] += client.used_now - before
            bets = find_value_bets(odds, finder)
            print(f"{SPORT_NAMES[sport]}: {len(odds)} maç, {len(bets)} değerli bahis")
            found += [(sport, b) for b in bets]

    # iddaa (OddsPapi): belirli saatlerde, aylık bütçe içinde, 2 istek
    iddaa_found: list[dict[str, Any]] = []
    op_key = os.environ.get("ODDSPAPI_KEY", "").strip()
    month = datetime.now(TR).strftime("%Y-%m")
    op_usage = raw.get("oddspapi") if isinstance(raw.get("oddspapi"), dict) and raw["oddspapi"].get("month") == month else {"month": month, "used": 0}
    if args.demo:
        pass
    elif not op_key:
        print("iddaa: ODDSPAPI_KEY tanımlı değil, atlandı.")
    elif datetime.now(TR).hour not in cfg["iddaa_hours"] and not os.environ.get("IDDAA_FORCE"):
        print(f"iddaa: bu saat ({datetime.now(TR):%H}:xx) iddaa tarama saati değil ({cfg['iddaa_hours']}).")
    elif op_usage["used"] + 2 > cfg["oddspapi_monthly_budget"]:
        print(f"iddaa: aylık OddsPapi bütçesi doldu ({op_usage['used']}/{cfg['oddspapi_monthly_budget']}).")
    else:
        try:
            meta = oddspapi.load_meta()
            idd, pin = oddspapi.fetch(op_key, meta)
            op_usage["used"] += 2
            res = oddspapi.evaluate(idd, pin, meta, mbs=1)
            iddaa_found = [x for x in res["rows"] if x["edge"] >= cfg["min_edge"] and cfg["min_odds"] <= x["odds"] <= cfg["max_odds"]]
            print(f"iddaa: {res['fixtures']} maç, {res['markets']} market, ort. marj %{(res['avg_margin'] or 0) * 100:.1f}, "
                  f"{len(iddaa_found)} değerli oran · bu ay {op_usage['used']}/{cfg['oddspapi_monthly_budget']} OddsPapi isteği")
        except oddspapi.OddsPapiError as exc:
            print(f"iddaa: {exc}")
    new_iddaa = [x for x in iddaa_found if iddaa_key(x) not in seen]

    new = [(s, b) for s, b in found if bet_key(b) not in seen]
    print(f"Toplam {len(found)} değerli bahis, {len(new)} yeni. Bu çalışmada harcanan istek: {client.used_now if client else 0}"
          f" · bugün toplam {usage['used']}/{cfg['daily_budget']}")

    remaining = client.remaining if client else None
    payload = None
    if new or new_iddaa:
        payload = format_message(new, cfg, remaining, new_iddaa)
    elif cfg["notify_when_empty"]:
        payload = {"title": "Değerli bahis yok", "message": f"Kalan API isteği: {remaining}", "tags": ["zzz"], "priority": 2, "click": cfg["app_url"]}
    if remaining is not None and remaining < cfg["min_remaining_quota"] and not usage.get("warned"):
        usage["warned"] = True  # günde en fazla bir uyarı
        warn = f"\n⚠️ API kotası azaldı: {remaining} istek kaldı."
        payload = payload or {"title": "API kotası azaldı", "message": "", "tags": ["warning"], "priority": 3, "click": cfg["app_url"]}
        payload["message"] += warn

    if payload:
        if args.dry_run:
            print("---- bildirim (gönderilmedi) ----")
            print(payload["title"])
            print(payload["message"])
        else:
            sent = notify(payload)
            print(f"Bildirim gönderildi: {', '.join(sent)}" if sent else "Bildirim kanalı tanımlı değil; gönderilmedi.")

    if not args.dry_run:
        # Başlamış maçların kayıtlarını at, yenileri ekle.
        for s, b in new:
            seen[bet_key(b)] = b.commence_time
        for x in new_iddaa:
            seen[iddaa_key(x)] = x["commence_time"].replace(".000Z", "Z")
        seen = {k: v for k, v in seen.items() if v > iso(now - timedelta(hours=6))}
        state_path.write_text(json.dumps({"seen": seen, "usage": usage, "oddspapi": op_usage}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
