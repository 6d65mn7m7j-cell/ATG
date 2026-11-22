import pytest
from fastapi.testclient import TestClient

from valuebet.finder import FinderConfig, find_value_bets
from valuebet.providers import SampleProvider
from valuebet.server import app


def book(key, h2h=None, spread=None, total=None):
    markets = []
    if h2h:
        markets.append({"key": "h2h", "outcomes": [{"name": "Home", "price": h2h[0]}, {"name": "Away", "price": h2h[1]}]})
    if spread:
        pt, ph, pa = spread
        markets.append({"key": "spreads", "outcomes": [
            {"name": "Home", "price": ph, "point": pt}, {"name": "Away", "price": pa, "point": -pt}]})
    if total:
        pt, po, pu = total
        markets.append({"key": "totals", "outcomes": [
            {"name": "Over", "price": po, "point": pt}, {"name": "Under", "price": pu, "point": pt}]})
    return {"key": key, "title": key.title(), "markets": markets}


def event(*books):
    return {"id": "e1", "commence_time": "2026-11-23T00:30:00Z", "home_team": "Home", "away_team": "Away", "bookmakers": list(books)}


def test_finds_value_against_sharp():
    ev = event(book("pinnacle", h2h=(1.95, 1.95)), book("softbook", h2h=(2.10, 1.75)))
    bets = find_value_bets([ev], FinderConfig(min_edge=0.01, devig_method="multiplicative"))
    assert len(bets) == 1
    b = bets[0]
    assert (b.bookmaker, b.selection, b.reference) == ("softbook", "Home", "sharp")
    assert b.fair_probability == pytest.approx(0.5)
    assert b.edge == pytest.approx(0.05)
    assert b.stake > 0


def test_sharp_book_is_not_its_own_reference():
    ev = event(book("pinnacle", h2h=(2.20, 1.70)), book("a", h2h=(1.90, 1.90)))
    bets = find_value_bets([ev], FinderConfig(min_edge=0.01, min_books_for_consensus=1))
    # pinnacle 'a'ya karşı konsensüsle değerlendirilir
    refs = {(b.bookmaker, b.selection): b.reference for b in bets}
    assert refs[("pinnacle", "Home")] == "consensus"
    assert refs[("a", "Away")] == "sharp"


def test_consensus_requires_min_books():
    ev = event(book("a", h2h=(2.2, 1.7)), book("b", h2h=(1.9, 1.9)))
    assert find_value_bets([ev], FinderConfig(reference="consensus", min_books_for_consensus=3)) == []


def test_spread_lines_grouped_by_point():
    ev = event(
        book("pinnacle", spread=(-4.5, 1.95, 1.95)),
        book("x", spread=(-4.5, 2.10, 1.75)),
        book("y", spread=(-5.5, 2.30, 1.65)),  # farklı çizgi, pinnacle ile kıyaslanmamalı
    )
    bets = find_value_bets([ev], FinderConfig(min_edge=0.01, markets=("spreads",)))
    assert [(b.bookmaker, b.point) for b in bets] == [("x", -4.5)]
    assert bets[0].label == "Home -4.5"


def test_bookmaker_filter_and_edge_cap():
    ev = event(book("pinnacle", total=(220.5, 1.95, 1.95)), book("x", total=(220.5, 2.10, 1.75)), book("bad", total=(220.5, 3.5, 1.3)))
    cfg = FinderConfig(min_edge=0.01, markets=("totals",), bookmakers=("x",))
    assert [b.bookmaker for b in find_value_bets([ev], cfg)] == ["x"]
    cfg = FinderConfig(min_edge=0.01, markets=("totals",))
    assert "bad" not in {b.bookmaker for b in find_value_bets([ev], cfg)}  # EV > %25 -> şüpheli


def test_sample_data_produces_bets():
    bets = find_value_bets(SampleProvider().fetch())
    assert bets and all(b.edge >= 0.02 for b in bets)
    assert bets == sorted(bets, key=lambda b: b.edge, reverse=True)


def test_api_demo():
    c = TestClient(app)
    r = c.get("/api/value-bets", params={"demo": True, "min_edge": 0.03, "markets": "h2h,totals"})
    assert r.status_code == 200
    j = r.json()
    assert j["source"] == "demo"
    assert all(b["edge"] >= 0.03 and b["market"] in ("h2h", "totals") for b in j["bets"])
    assert c.get("/api/value-bets", params={"demo": True, "devig": "nope"}).status_code == 400
    assert c.get("/").status_code == 200


def test_exchange_commission_reduces_edge():
    ev = event(book("pinnacle", h2h=(1.95, 1.95)), book("betfair_ex_eu", h2h=(2.10, 1.75)))
    b = find_value_bets([ev], FinderConfig(min_edge=0.0, devig_method="multiplicative"))[0]
    assert b.net_price == pytest.approx(1 + 1.10 * 0.95)
    assert b.edge == pytest.approx(0.5 * b.net_price - 1, abs=1e-4)
