"""Web uygulamasındaki JavaScript motorunun Python motoruyla aynı sonucu verdiğini doğrular."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from valuebet.finder import FinderConfig, find_value_bets
from valuebet.providers import SAMPLE_PATH

RUNNER = Path(__file__).parent / "js" / "run_finder.mjs"

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node kurulu değil")


@pytest.mark.parametrize("reference", ["sharp", "consensus"])
@pytest.mark.parametrize("method", ["power", "shin", "multiplicative", "additive"])
def test_js_matches_python(reference, method):
    events = json.loads(SAMPLE_PATH.read_text(encoding="utf-8"))
    py = find_value_bets(events, FinderConfig(reference=reference, devig_method=method, min_edge=-0.02))
    out = subprocess.check_output(["node", str(RUNNER), str(SAMPLE_PATH), reference, method, "-0.02"])
    js = json.loads(out)
    assert sorted(tuple(x) for x in js) == sorted((b.bookmaker, b.label, b.price, b.edge, b.stake) for b in py)


def test_js_iddaa_unit_tests():
    tests = Path(__file__).parent / "js" / "iddaa.test.mjs"
    proc = subprocess.run(["node", "--test", str(tests)], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr
