"""FastAPI web sunucusu.

Çalıştırma:  uvicorn valuebet.server:app --reload
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse

from . import odds as om
from .finder import FinderConfig, find_value_bets, summarize
from .providers import ProviderError, SampleProvider, TheOddsAPIProvider

STATIC = Path(__file__).parent / "static"

app = FastAPI(title="NBA Değerli Bahis Bulucu", version="0.1.0")

_live: TheOddsAPIProvider | None = None


def _provider(demo: bool):
    global _live
    if demo or not os.environ.get("ODDS_API_KEY"):
        return SampleProvider()
    if _live is None:
        _live = TheOddsAPIProvider(cache_seconds=int(os.environ.get("CACHE_SECONDS", "120")))
    return _live


def _csv(value: str | None) -> tuple[str, ...]:
    return tuple(v.strip() for v in (value or "").split(",") if v.strip())


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC / "index.html")


@app.get("/api/status")
def status() -> dict:
    return {"live_available": bool(os.environ.get("ODDS_API_KEY")), "devig_methods": list(om.DEVIG_METHODS)}


@app.get("/api/value-bets")
def value_bets(
    min_edge: float = Query(0.02, ge=-1, le=1),
    max_edge: float = Query(0.25, gt=0, le=5),
    devig: str = Query("power"),
    reference: str = Query("sharp", pattern="^(sharp|consensus)$"),
    markets: str = Query("h2h,spreads,totals"),
    books: str | None = Query(None, description="Virgülle ayrılmış şirket anahtarları"),
    bankroll: float = Query(1000, gt=0),
    kelly: float = Query(0.25, ge=0, le=1),
    max_stake_pct: float = Query(0.03, ge=0, le=1),
    min_odds: float = Query(1.2, ge=1.01),
    max_odds: float = Query(6.0, ge=1.01),
    regions: str = Query("us,eu"),
    demo: bool = Query(False),
    sport: str = Query("nba", pattern="^(nba|nhl)$"),
) -> dict:
    if devig not in om.DEVIG_METHODS:
        raise HTTPException(400, f"devig şunlardan biri olmalı: {', '.join(om.DEVIG_METHODS)}")
    market_t = tuple(m for m in _csv(markets) if m in ("h2h", "spreads", "totals")) or ("h2h",)
    provider = _provider(demo)
    try:
        events = provider.fetch(markets=("h2h", "spreads", "totals"), regions=regions, sport=sport)
    except ProviderError as exc:
        raise HTTPException(502, str(exc)) from exc

    cfg = FinderConfig(
        min_edge=min_edge,
        max_edge=max_edge,
        devig_method=devig,
        reference=reference,
        markets=market_t,
        bookmakers=_csv(books) or None,
        bankroll=bankroll,
        kelly_multiplier=kelly,
        max_stake_pct=max_stake_pct,
        min_odds=min_odds,
        max_odds=max_odds,
    )
    bets = find_value_bets(events, cfg)
    all_books = sorted(
        {(b["key"], b.get("title", b["key"])) for e in events for b in e.get("bookmakers", [])}
    )
    return {
        "source": provider.name,
        "sport": sport,
        "quota": provider.quota,
        "summary": summarize(events, bets),
        "bookmakers": [{"key": k, "title": t} for k, t in all_books],
        "bets": [b.to_dict() | {"label": b.label} for b in bets],
    }
