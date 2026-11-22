"""Komut satırı arayüzü.

Örnek:  python -m valuebet --min-edge 0.03 --books draftkings,fanduel
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime

from . import odds as om
from .finder import FinderConfig, find_value_bets, summarize
from .providers import ProviderError, get_provider


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="NBA ve NHL maçları için değerli bahis bulucu")
    ap.add_argument("--sport", choices=("nba", "nhl"), default="nba")
    ap.add_argument("--demo", action="store_true", help="API yerine örnek veriyi kullan")
    ap.add_argument("--min-edge", type=float, default=0.02, help="En düşük EV (0.02 = %%2)")
    ap.add_argument("--devig", choices=om.DEVIG_METHODS, default="power")
    ap.add_argument("--reference", choices=("sharp", "consensus"), default="sharp")
    ap.add_argument("--markets", default="h2h,spreads,totals")
    ap.add_argument("--books", default="", help="Sadece bu şirketler (virgülle)")
    ap.add_argument("--regions", default="us,eu")
    ap.add_argument("--bankroll", type=float, default=1000.0)
    ap.add_argument("--kelly", type=float, default=0.25, help="Kelly çarpanı (0.25 = çeyrek Kelly)")
    ap.add_argument("--json", action="store_true", help="JSON çıktı ver")
    args = ap.parse_args(argv)

    provider = get_provider(demo=True if args.demo else None)
    try:
        events = provider.fetch(regions=args.regions, sport=args.sport)
    except ProviderError as exc:
        print(f"Hata: {exc}", file=sys.stderr)
        return 1

    cfg = FinderConfig(
        min_edge=args.min_edge,
        devig_method=args.devig,
        reference=args.reference,
        markets=tuple(m.strip() for m in args.markets.split(",") if m.strip()),
        bookmakers=tuple(b.strip() for b in args.books.split(",") if b.strip()) or None,
        bankroll=args.bankroll,
        kelly_multiplier=args.kelly,
    )
    bets = find_value_bets(events, cfg)

    if args.json:
        print(json.dumps({"summary": summarize(events, bets), "bets": [b.to_dict() for b in bets]}, ensure_ascii=False, indent=2))
        return 0

    print(f"Kaynak: {provider.name} | {len(events)} maç | {len(bets)} değerli bahis\n")
    if not bets:
        print("Bu kriterlere uyan değerli bahis bulunamadı.")
        return 0
    header = f"{'Tarih':<12}{'Maç':<44}{'Market':<25}{'Seçim':<28}{'Şirket':<13}{'Oran':>6}{'Adil':>7}{'EV':>8}{'Stake':>9}"
    print(header)
    print("-" * len(header))
    for b in bets:
        when = datetime.fromisoformat(b.commence_time.replace("Z", "+00:00")).strftime("%d.%m %H:%M")
        match = f"{b.away_team} @ {b.home_team}"
        print(
            f"{when:<12}{match[:43]:<44}{b.market_label[:24]:<25}{b.label[:27]:<28}{b.bookmaker_title[:12]:<13}"
            f"{b.price:>6.2f}{b.fair_odds:>7.2f}{b.edge * 100:>7.1f}%{b.stake:>9.2f}"
        )
    s = summarize(events, bets)
    print(f"\nToplam önerilen stake: {s['total_stake']:.2f} | Beklenen kâr: {s['expected_profit']:.2f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
