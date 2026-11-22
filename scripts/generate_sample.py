"""Demo için gerçekçi NBA oran verisi üretir (The Odds API v4 formatında).

Kullanım: python scripts/generate_sample.py
"""

from __future__ import annotations

import json
import math
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "valuebet" / "data" / "sample_odds.json"

BOOKS = [
    # key, title, marj, gürültü (olasılık std), keskin mi
    ("pinnacle", "Pinnacle", 0.022, 0.004),
    ("draftkings", "DraftKings", 0.045, 0.015),
    ("fanduel", "FanDuel", 0.045, 0.015),
    ("betmgm", "BetMGM", 0.050, 0.020),
    ("caesars", "Caesars", 0.050, 0.020),
    ("betrivers", "BetRivers", 0.055, 0.022),
    ("bet365", "Bet365", 0.045, 0.018),
    ("unibet_eu", "Unibet", 0.050, 0.022),
]

GAMES = [
    # deplasman, ev sahibi, ev sahibi kazanma olasılığı, beklenen toplam
    ("Boston Celtics", "New York Knicks", 0.48, 224.5),
    ("Denver Nuggets", "Los Angeles Lakers", 0.44, 229.5),
    ("Oklahoma City Thunder", "Dallas Mavericks", 0.33, 221.5),
    ("Milwaukee Bucks", "Cleveland Cavaliers", 0.66, 226.5),
    ("Golden State Warriors", "Phoenix Suns", 0.53, 231.5),
    ("Miami Heat", "Orlando Magic", 0.61, 208.5),
    ("San Antonio Spurs", "Houston Rockets", 0.58, 223.5),
    ("Minnesota Timberwolves", "Sacramento Kings", 0.45, 218.5),
]

SPREAD_SD = 12.5  # NBA marj standart sapması (yaklaşık)
TOTAL_SD = 18.0


def norm_cdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def price_pair(p: float, margin: float, noise: float, rng: random.Random) -> tuple[float, float]:
    p = min(max(p + rng.gauss(0, noise), 0.03), 0.97)
    # oransal marj ekle
    a, b = p * (1 + margin), (1 - p) * (1 + margin)
    return round(1 / a, 2), round(1 / b, 2)


def main() -> None:
    rng = random.Random(42)
    start = datetime(2026, 11, 23, 0, 30, tzinfo=timezone.utc)
    events = []
    for i, (away, home, p_home, total) in enumerate(GAMES):
        commence = start + timedelta(minutes=30 * (i % 4)) + timedelta(days=i // 4)
        # beklenen ev sahibi farkı (olasılıktan türet)
        mu = SPREAD_SD * _inv_norm(p_home)
        spread_home = -round(mu * 2) / 2  # ev sahibi handikabı (favori negatif)
        p_home_cover = norm_cdf((mu + spread_home) / SPREAD_SD)
        true_total = total + rng.uniform(-1.5, 1.5)
        p_over = 1 - norm_cdf((total - true_total) / TOTAL_SD)

        bookmakers = []
        for key, title, margin, noise in BOOKS:
            upd = (commence - timedelta(hours=3, minutes=rng.randint(0, 50))).isoformat().replace("+00:00", "Z")
            h_home, h_away = price_pair(p_home, margin, noise, rng)
            s_home, s_away = price_pair(p_home_cover, margin, noise, rng)
            o, u = price_pair(p_over, margin, noise, rng)
            spread = spread_home
            tot = total
            # bazı şirketler yarım sayı farklı çizgi verir
            if key in ("betrivers", "unibet_eu") and rng.random() < 0.5:
                spread += 0.5
            if key == "caesars" and rng.random() < 0.5:
                tot += 1.0
            bookmakers.append(
                {
                    "key": key,
                    "title": title,
                    "last_update": upd,
                    "markets": [
                        {"key": "h2h", "last_update": upd, "outcomes": [
                            {"name": home, "price": h_home}, {"name": away, "price": h_away}]},
                        {"key": "spreads", "last_update": upd, "outcomes": [
                            {"name": home, "price": s_home, "point": spread},
                            {"name": away, "price": s_away, "point": -spread}]},
                        {"key": "totals", "last_update": upd, "outcomes": [
                            {"name": "Over", "price": o, "point": tot},
                            {"name": "Under", "price": u, "point": tot}]},
                    ],
                }
            )
        events.append(
            {
                "id": f"demo{i:03d}",
                "sport_key": "basketball_nba",
                "sport_title": "NBA",
                "commence_time": commence.isoformat().replace("+00:00", "Z"),
                "home_team": home,
                "away_team": away,
                "bookmakers": bookmakers,
            }
        )
    OUT.write_text(json.dumps(events, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"{len(events)} maç yazıldı -> {OUT}")


def _inv_norm(p: float) -> float:
    lo, hi = -10.0, 10.0
    for _ in range(100):
        mid = (lo + hi) / 2
        if norm_cdf(mid) < p:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


if __name__ == "__main__":
    main()
