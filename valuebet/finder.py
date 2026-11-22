"""Değerli bahis (value bet) bulucu.

Yaklaşım: Her market için "adil" olasılık, keskin (sharp) bir bahis şirketinin
(varsayılan Pinnacle) marjı temizlenmiş oranlarından ya da — o yoksa — diğer
şirketlerin marjı temizlenmiş olasılıklarının medyanından (konsensüs) elde edilir.
Bir şirketin sunduğu oran bu adil olasılığa göre pozitif beklenen değer (EV)
veriyorsa değerli bahis olarak işaretlenir.
"""

from __future__ import annotations

import statistics
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable

from . import odds as om

MARKET_LABELS = {"h2h": "Maç Sonucu", "spreads": "Handikap", "totals": "Toplam Sayı"}
DEFAULT_SHARP_BOOKS = ("pinnacle", "betonlineag", "circasports", "lowvig")

# Bahis borsaları net kazançtan komisyon keser; EV bu net orana göre hesaplanır.
EXCHANGE_COMMISSION = {
    "betfair_ex_eu": 0.05,
    "betfair_ex_uk": 0.05,
    "betfair_ex_au": 0.05,
    "matchbook": 0.02,
    "smarkets": 0.02,
}


def net_price(bookmaker: str, price: float) -> float:
    c = EXCHANGE_COMMISSION.get(bookmaker, 0.0)
    return 1.0 + (price - 1.0) * (1.0 - c)


@dataclass
class FinderConfig:
    min_edge: float = 0.02  # en az %2 EV
    max_edge: float = 0.25  # bunun üstü büyük ihtimalle hatalı/eski oran
    devig_method: str = "power"
    reference: str = "sharp"  # "sharp" | "consensus"
    sharp_books: tuple[str, ...] = DEFAULT_SHARP_BOOKS
    min_books_for_consensus: int = 3
    markets: tuple[str, ...] = ("h2h", "spreads", "totals")
    bookmakers: tuple[str, ...] | None = None  # sadece bu şirketlerdeki bahisleri göster
    min_odds: float = 1.2
    max_odds: float = 6.0
    bankroll: float = 1000.0
    kelly_multiplier: float = 0.25  # çeyrek Kelly
    max_stake_pct: float = 0.03  # tek bahiste kasanın en fazla %3'ü


@dataclass
class ValueBet:
    event_id: str
    commence_time: str
    home_team: str
    away_team: str
    market: str
    market_label: str
    selection: str
    point: float | None
    bookmaker: str
    bookmaker_title: str
    price: float
    net_price: float  # borsa komisyonu düşülmüş oran (diğer şirketlerde = price)
    american: int
    fair_probability: float
    fair_odds: float
    implied_probability: float
    edge: float
    kelly: float
    stake: float
    reference: str
    reference_books: list[str] = field(default_factory=list)
    best_price: bool = False
    last_update: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @property
    def label(self) -> str:
        if self.market == "spreads" and self.point is not None:
            return f"{self.selection} {self.point:+g}"
        if self.market == "totals" and self.point is not None:
            name = {"Over": "Üst", "Under": "Alt"}.get(self.selection, self.selection)
            return f"{name} {self.point:g}"
        return self.selection


# --------------------------------------------------------------------------- #
# Market normalizasyonu
# --------------------------------------------------------------------------- #

@dataclass
class _BookLine:
    key: str
    title: str
    last_update: str | None
    prices: dict[str, float]  # sonuç adı -> ondalık oran
    points: dict[str, float | None]


def _line_id(market: str, outcomes: list[dict[str, Any]], home_team: str) -> float | None:
    """Aynı çizgideki (aynı handikap/toplam) teklifleri gruplamak için kimlik."""
    if market == "h2h":
        return None
    if market == "totals":
        return float(outcomes[0].get("point"))
    if market == "spreads":
        for o in outcomes:
            if o.get("name") == home_team:
                return float(o.get("point"))
        return float(outcomes[0].get("point"))
    return None


def _collect_lines(event: dict[str, Any], market: str) -> dict[float | None, list[_BookLine]]:
    groups: dict[float | None, list[_BookLine]] = {}
    for book in event.get("bookmakers", []):
        for m in book.get("markets", []):
            if m.get("key") != market:
                continue
            outcomes = m.get("outcomes", [])
            if len(outcomes) != 2:  # NBA'de beraberlik yok; iki yollu marketler
                continue
            try:
                lid = _line_id(market, outcomes, event["home_team"])
                prices = {o["name"]: float(o["price"]) for o in outcomes}
            except (KeyError, TypeError, ValueError):
                continue
            if any(p <= 1.0 for p in prices.values()) or len(prices) != 2:
                continue
            groups.setdefault(lid, []).append(
                _BookLine(
                    key=book["key"],
                    title=book.get("title", book["key"]),
                    last_update=m.get("last_update") or book.get("last_update"),
                    prices=prices,
                    points={o["name"]: o.get("point") for o in outcomes},
                )
            )
    return groups


def _fair_probs(line: _BookLine, method: str) -> dict[str, float]:
    names = list(line.prices)
    probs = om.devig([line.prices[n] for n in names], method)
    return dict(zip(names, probs))


def _reference_probs(
    lines: list[_BookLine], exclude: str, cfg: FinderConfig
) -> tuple[dict[str, float], str, list[str]] | None:
    """Değerlendirilen şirket hariç tutularak referans adil olasılıkları döndürür."""
    others = [l for l in lines if l.key != exclude]
    if cfg.reference == "sharp":
        for sharp in cfg.sharp_books:
            for l in others:
                if l.key == sharp:
                    return _fair_probs(l, cfg.devig_method), "sharp", [l.key]

    if len(others) < cfg.min_books_for_consensus:
        return None
    per_book = [_fair_probs(l, cfg.devig_method) for l in others]
    names = list(per_book[0])
    med = {n: statistics.median(pb[n] for pb in per_book) for n in names}
    total = sum(med.values())
    return {n: v / total for n, v in med.items()}, "consensus", [l.key for l in others]


# --------------------------------------------------------------------------- #
# Ana fonksiyon
# --------------------------------------------------------------------------- #

def find_value_bets(events: Iterable[dict[str, Any]], cfg: FinderConfig | None = None) -> list[ValueBet]:
    cfg = cfg or FinderConfig()
    if cfg.devig_method not in om.DEVIG_METHODS:
        raise ValueError(f"Bilinmeyen marj temizleme yöntemi: {cfg.devig_method}")
    allowed = set(cfg.bookmakers) if cfg.bookmakers else None
    results: list[ValueBet] = []

    for event in events:
        for market in cfg.markets:
            for lid, lines in _collect_lines(event, market).items():
                if len(lines) < 2:
                    continue
                best = {}
                for l in lines:
                    for name, price in l.prices.items():
                        best[name] = max(best.get(name, 0.0), price)

                for line in lines:
                    if allowed is not None and line.key not in allowed:
                        continue
                    ref = _reference_probs(lines, line.key, cfg)
                    if ref is None:
                        continue
                    probs, ref_kind, ref_books = ref
                    for name, price in line.prices.items():
                        if name not in probs:
                            continue
                        if not (cfg.min_odds <= price <= cfg.max_odds):
                            continue
                        p = probs[name]
                        net = net_price(line.key, price)
                        edge = om.expected_value(p, net)
                        if edge < cfg.min_edge or edge > cfg.max_edge:
                            continue
                        k = om.kelly_fraction(p, net)
                        stake_pct = min(k * cfg.kelly_multiplier, cfg.max_stake_pct)
                        results.append(
                            ValueBet(
                                event_id=event.get("id", ""),
                                commence_time=event.get("commence_time", ""),
                                home_team=event["home_team"],
                                away_team=event["away_team"],
                                market=market,
                                market_label=MARKET_LABELS.get(market, market),
                                selection=name,
                                point=line.points.get(name),
                                bookmaker=line.key,
                                bookmaker_title=line.title,
                                price=price,
                                net_price=round(net, 3),
                                american=om.decimal_to_american(price),
                                fair_probability=round(p, 4),
                                fair_odds=round(om.fair_odds(p), 3),
                                implied_probability=round(om.implied_probability(price), 4),
                                edge=round(edge, 4),
                                kelly=round(k, 4),
                                stake=round(cfg.bankroll * stake_pct, 2),
                                reference=ref_kind,
                                reference_books=ref_books,
                                best_price=price >= best[name],
                                last_update=line.last_update,
                            )
                        )

    results.sort(key=lambda b: b.edge, reverse=True)
    return results


def summarize(events: list[dict[str, Any]], bets: list[ValueBet]) -> dict[str, Any]:
    books = {b["key"] for e in events for b in e.get("bookmakers", [])}
    return {
        "events": len(events),
        "bookmakers": len(books),
        "value_bets": len(bets),
        "avg_edge": round(statistics.mean(b.edge for b in bets), 4) if bets else 0.0,
        "max_edge": max((b.edge for b in bets), default=0.0),
        "total_stake": round(sum(b.stake for b in bets), 2),
        "expected_profit": round(sum(b.stake * b.edge for b in bets), 2),
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
