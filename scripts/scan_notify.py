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
from valuebet.providers import SPORT_MARKETS, SPORTS, SampleProvider  # noqa: E402

API = "https://api.the-odds-api.com/v4"
SPORT_NAMES = {"nba": "NBA", "nhl": "NHL", "euroleague": "EuroLeague", "nfl": "NFL", "ufc": "UFC/MMA"}
DEFAULT_CONFIG: dict[str, Any] = {
    "sports": ["nba", "nhl", "euroleague", "nfl", "ufc"],
    "regions": "eu",
    "hours_ahead": 14,
    "min_edge": 0.03,
    "max_edge": 0.25,
    "min_odds": 1.3,
    "max_odds": 5.0,
    "bookmakers": [],
    "bankroll": 1000,
    "kelly_multiplier": 0.25,
    "max_items": 8,
    "min_remaining_quota": 60,
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


def format_message(found: list[tuple[str, ValueBet]], cfg: dict[str, Any], remaining: int | None) -> dict[str, Any]:
    found = sorted(found, key=lambda x: x[1].edge, reverse=True)
    shown = found[: cfg["max_items"]]
    sports = sorted({SPORT_NAMES[s] for s, _ in found})
    lines = []
    for sport, b in shown:
        t = datetime.fromisoformat(b.commence_time.replace("Z", "+00:00")).astimezone(timezone(timedelta(hours=3)))
        lines.append(
            f"{SPORT_NAMES[sport]} {t:%d.%m %H:%M} · {b.home_team} – {b.away_team}\n"
            f"  {b.label} ({b.market_label}) @ {b.price:.2f} {b.bookmaker_title} · EV +{b.edge * 100:.1f}% · stake {b.stake:.0f}"
        )
    if len(found) > len(shown):
        lines.append(f"…ve {len(found) - len(shown)} bahis daha")
    if remaining is not None:
        lines.append(f"Kalan API isteği: {remaining}")
    return {
        "title": f"{len(found)} değerli bahis · {', '.join(sports)}",
        "message": "\n".join(lines),
        "tags": ["moneybag"],
        "priority": 4 if found and found[0][1].edge >= 0.05 else 3,
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
        seen: dict[str, str] = json.loads(state_path.read_text()) if state_path.exists() else {}
    except (json.JSONDecodeError, OSError):
        seen = {}

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
    else:
        key = os.environ.get("ODDS_API_KEY", "").strip()
        if not key:
            print("ODDS_API_KEY tanımlı değil; tarama atlandı.")
            return 0
        client = OddsClient(key)
        for sport in cfg["sports"]:
            events = client.events(sport, now, end)
            if not events:
                print(f"{SPORT_NAMES[sport]}: önümüzdeki {cfg['hours_ahead']} saatte maç yok, istek harcanmadı.")
                continue
            if client.remaining is not None and client.remaining < cfg["min_remaining_quota"]:
                print(f"Kota düşük ({client.remaining}); {SPORT_NAMES[sport]} atlandı.")
                continue
            odds = client.odds(sport, cfg["regions"], now, end)
            bets = find_value_bets(odds, finder)
            print(f"{SPORT_NAMES[sport]}: {len(odds)} maç, {len(bets)} değerli bahis")
            found += [(sport, b) for b in bets]

    new = [(s, b) for s, b in found if bet_key(b) not in seen]
    print(f"Toplam {len(found)} değerli bahis, {len(new)} yeni. Bu çalışmada harcanan istek: {client.used_now if client else 0}")

    remaining = client.remaining if client else None
    payload = None
    if new:
        payload = format_message(new, cfg, remaining)
    elif cfg["notify_when_empty"]:
        payload = {"title": "Değerli bahis yok", "message": f"Kalan API isteği: {remaining}", "tags": ["zzz"], "priority": 2, "click": cfg["app_url"]}
    if remaining is not None and remaining < cfg["min_remaining_quota"]:
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
        seen = {k: v for k, v in seen.items() if v > iso(now - timedelta(hours=6))}
        state_path.write_text(json.dumps(seen))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
