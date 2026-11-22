import math

import pytest

from valuebet import odds as om


def test_conversions():
    assert om.american_to_decimal(150) == pytest.approx(2.5)
    assert om.american_to_decimal(-200) == pytest.approx(1.5)
    assert om.decimal_to_american(2.5) == 150
    assert om.decimal_to_american(1.5) == -200
    assert om.implied_probability(2.0) == 0.5
    with pytest.raises(ValueError):
        om.implied_probability(1.0)


def test_overround():
    assert om.overround([1.91, 1.91]) == pytest.approx(2 / 1.91 - 1)


@pytest.mark.parametrize("method", om.DEVIG_METHODS)
def test_devig_sums_to_one_and_keeps_order(method):
    probs = om.devig([1.40, 3.05], method)
    assert sum(probs) == pytest.approx(1.0)
    assert probs[0] > probs[1]


@pytest.mark.parametrize("method", om.DEVIG_METHODS)
def test_devig_symmetric_market(method):
    assert om.devig([1.91, 1.91], method) == pytest.approx([0.5, 0.5])


def test_power_and_shin_shift_margin_to_longshot():
    # favori/sürpriz yanlılığı: power ve shin, sürprize çarpımsaldan daha düşük olasılık verir
    mult = om.devig([1.25, 4.0], "multiplicative")
    for m in ("power", "shin"):
        assert om.devig([1.25, 4.0], m)[1] < mult[1]


def test_ev_and_kelly():
    assert om.expected_value(0.5, 2.1) == pytest.approx(0.05)
    # b=1.1, p=.5 -> (0.55-0.5)/1.1
    assert om.kelly_fraction(0.5, 2.1) == pytest.approx(0.05 / 1.1)
    assert om.kelly_fraction(0.4, 2.0) == 0.0
    assert om.fair_odds(0.25) == 4.0
    assert math.isinf(om.fair_odds(0))
