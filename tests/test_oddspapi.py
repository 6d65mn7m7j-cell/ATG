"""OddsPapi iddaa ↔ Pinnacle karşılaştırması: gerçek örnek veriyle Python ve JavaScript motorlarının uyumu."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from valuebet import oddspapi

ROOT = Path(__file__).parent.parent
SAMPLE = ROOT / "tests" / "data" / "oddspapi_sample.json"
META = ROOT / "docs" / "oddspapi_meta.json"


@pytest.fixture(scope="module")
def data():
    return oddspapi.load_meta(META), json.loads(SAMPLE.read_text(encoding="utf-8"))


def test_evaluate_real_sample(data):
    meta, s = data
    res = oddspapi.evaluate(s["iddaa"], s["pinnacle"], meta)
    assert res["fixtures"] > 10 and res["markets"] > 100
    assert 0.1 < res["avg_margin"] < 0.35  # iddaa marjı ~%21
    rows = res["rows"]
    assert rows == sorted(rows, key=lambda x: x["edge"], reverse=True)
    assert {x["sport"] for x in rows} >= {"nba", "nhl", "nfl"}
    # NHL normal süre 1-X-2: üç sonuç ve adil olasılıklar toplamı 1
    nhl = [x for x in rows if x["sport"] == "nhl" and x["market"] == "h2h" and x["regulation"]]
    by_market = {}
    for x in nhl:
        by_market.setdefault((x["event_id"], x["market_id"]), []).append(x)
    full = [v for v in by_market.values() if len(v) == 3]
    assert full and all(abs(sum(x["fair_probability"] for x in v) - 1) < 2e-3 for v in full)
    assert all(abs(x["edge"] - (x["fair_probability"] * x["odds"] - 1)) < 1e-3 for x in rows)


def test_started_fixtures_are_skipped(data):
    meta, s = data
    started = [dict(f, statusId=1) for f in s["iddaa"]]
    assert oddspapi.evaluate(started, s["pinnacle"], meta)["rows"] == []


@pytest.mark.skipif(shutil.which("node") is None, reason="node kurulu değil")
@pytest.mark.parametrize("method", ["power", "multiplicative"])
def test_js_matches_python(data, method):
    meta, s = data
    py = oddspapi.evaluate(s["iddaa"], s["pinnacle"], meta, devig_method=method)
    out = subprocess.check_output(["node", str(ROOT / "tests" / "js" / "run_oddspapi.mjs"), str(META), str(SAMPLE), method])
    js = json.loads(out)
    assert js["markets"] == py["markets"] and js["fixtures"] == py["fixtures"]
    assert abs(js["avgMargin"] - py["avg_margin"]) < 1e-4
    key = lambda r: (r[0], r[1], r[2])
    pyrows = sorted(([x["event_id"], x["market_id"], x["outcome_id"], x["label"], x["market_label"], x["odds"], x["fair_probability"], x["edge"]] for x in py["rows"]), key=key)
    assert sorted(js["rows"], key=key) == pyrows


def test_scan_notify_includes_iddaa(tmp_path, monkeypatch, capsys, data):
    import importlib.util
    from datetime import datetime, timedelta, timezone

    meta, s = data
    shift = lambda t: (datetime.fromisoformat(t.replace("Z", "+00:00")) + timedelta(days=400)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    s = json.loads(json.dumps(s))
    for bk in ("iddaa", "pinnacle"):
        for f in s[bk]:
            f["startTime"] = shift(f["startTime"])
    f0 = next(f for f in s["iddaa"] if f["tournamentId"] == 132 and "111" in f["bookmakerOdds"]["iddaa"]["markets"])
    f0["bookmakerOdds"]["iddaa"]["markets"]["111"]["outcomes"]["111"]["players"]["0"]["price"] = 2.4  # değerli yap

    spec = importlib.util.spec_from_file_location("scan_notify_op", ROOT / "scripts" / "scan_notify.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    class NoGames:
        def __init__(self, key):
            self.remaining, self.used_now = 300, 0

        def events(self, *a):
            return []

    calls = []
    monkeypatch.setattr(mod, "OddsClient", NoGames)
    monkeypatch.setattr(mod.oddspapi, "fetch", lambda key, meta: calls.append(1) or (s["iddaa"], s["pinnacle"]))
    sent = []
    monkeypatch.setattr(mod, "notify", lambda payload: sent.append(payload) or ["ntfy"])
    monkeypatch.setenv("ODDS_API_KEY", "x")
    monkeypatch.setenv("ODDSPAPI_KEY", "y")
    monkeypatch.setenv("IDDAA_FORCE", "1")
    state = tmp_path / "state.json"

    assert mod.main(["--state", str(state)]) == 0
    assert calls == [1] and sent, capsys.readouterr().out
    assert "iddaa · NBA" in sent[0]["message"] and "(iddaa " in sent[0]["title"]
    st = json.loads(state.read_text())
    assert st["oddspapi"]["used"] == 2 and any(k.startswith("op|") for k in st["seen"])
    # aynı oran ikinci kez bildirilmez
    sent.clear()
    mod.main(["--state", str(state)])
    assert not sent and json.loads(state.read_text())["oddspapi"]["used"] == 4
    # aylık bütçe
    monkeypatch.setattr(mod, "DEFAULT_CONFIG", {**mod.DEFAULT_CONFIG, "oddspapi_monthly_budget": 4})
    cfg = tmp_path / "cfg.json"
    cfg.write_text(json.dumps({"oddspapi_monthly_budget": 4}))
    calls.clear()
    mod.main(["--config", str(cfg), "--state", str(state)])
    assert calls == [] and "bütçesi doldu" in capsys.readouterr().out
