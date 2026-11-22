"""Oran matematiği: dönüşümler, marj (vig) temizleme, beklenen değer ve Kelly."""

from __future__ import annotations

import math
from typing import Callable, Sequence

DEVIG_METHODS = ("multiplicative", "power", "shin", "additive")


def implied_probability(decimal_odds: float) -> float:
    """Ondalık orandan ima edilen olasılık (marj dahil)."""
    if decimal_odds <= 1.0:
        raise ValueError(f"Ondalık oran 1'den büyük olmalı: {decimal_odds}")
    return 1.0 / decimal_odds


def american_to_decimal(american: float) -> float:
    if american == 0:
        raise ValueError("Amerikan oran 0 olamaz")
    if american > 0:
        return 1.0 + american / 100.0
    return 1.0 + 100.0 / abs(american)


def decimal_to_american(decimal_odds: float) -> int:
    if decimal_odds <= 1.0:
        raise ValueError(f"Ondalık oran 1'den büyük olmalı: {decimal_odds}")
    if decimal_odds >= 2.0:
        return round((decimal_odds - 1.0) * 100)
    return round(-100.0 / (decimal_odds - 1.0))


def overround(decimal_odds: Sequence[float]) -> float:
    """Toplam ima edilen olasılık - 1 (bahis şirketinin marjı)."""
    return sum(implied_probability(o) for o in decimal_odds) - 1.0


def _bisect(f: Callable[[float], float], lo: float, hi: float, tol: float = 1e-12, max_iter: int = 200) -> float:
    """f(lo) ve f(hi) zıt işaretli olacak şekilde kök bulur."""
    flo = f(lo)
    for _ in range(max_iter):
        mid = (lo + hi) / 2.0
        fmid = f(mid)
        if abs(fmid) < tol or (hi - lo) / 2.0 < tol:
            return mid
        if (fmid > 0) == (flo > 0):
            lo, flo = mid, fmid
        else:
            hi = mid
    return (lo + hi) / 2.0


def _devig_multiplicative(implied: list[float]) -> list[float]:
    total = sum(implied)
    return [p / total for p in implied]


def _devig_additive(implied: list[float]) -> list[float]:
    n = len(implied)
    excess = (sum(implied) - 1.0) / n
    probs = [max(p - excess, 1e-9) for p in implied]
    total = sum(probs)
    return [p / total for p in probs]


def _devig_power(implied: list[float]) -> list[float]:
    # p_i = q_i^k, sum(p_i) = 1. q_i < 1 olduğundan toplam k ile azalır.
    def f(k: float) -> float:
        return sum(q**k for q in implied) - 1.0

    k = _bisect(f, 1e-3, 100.0)
    probs = [q**k for q in implied]
    total = sum(probs)
    return [p / total for p in probs]


def _devig_shin(implied: list[float]) -> list[float]:
    """Shin (1993) yöntemi: içeriden bilgili bahisçi payı z'yi çözer.

    Favori / sürpriz (favourite-longshot) yanlılığını hesaba katar.
    """
    total = sum(implied)
    if total <= 1.0:
        return _devig_multiplicative(implied)

    def probs_for(z: float) -> list[float]:
        return [
            (math.sqrt(z * z + 4.0 * (1.0 - z) * q * q / total) - z) / (2.0 * (1.0 - z))
            for q in implied
        ]

    z = _bisect(lambda z: sum(probs_for(z)) - 1.0, 0.0, 0.4999)
    probs = probs_for(z)
    s = sum(probs)
    return [p / s for p in probs]


def devig(decimal_odds: Sequence[float], method: str = "power") -> list[float]:
    """Bir marketteki tüm sonuçların oranlarından adil olasılıkları çıkarır."""
    if len(decimal_odds) < 2:
        raise ValueError("Marj temizleme için en az iki sonuç gerekir")
    implied = [implied_probability(o) for o in decimal_odds]
    if method == "multiplicative":
        return _devig_multiplicative(implied)
    if method == "additive":
        return _devig_additive(implied)
    if method == "power":
        return _devig_power(implied)
    if method == "shin":
        return _devig_shin(implied)
    raise ValueError(f"Bilinmeyen yöntem: {method}. Seçenekler: {', '.join(DEVIG_METHODS)}")


def expected_value(fair_probability: float, decimal_odds: float) -> float:
    """Birim bahis başına beklenen getiri (0.05 = %5 avantaj)."""
    return fair_probability * decimal_odds - 1.0


def kelly_fraction(fair_probability: float, decimal_odds: float) -> float:
    """Tam Kelly kriterine göre kasanın yatırılması gereken oranı (negatifse 0)."""
    b = decimal_odds - 1.0
    if b <= 0:
        return 0.0
    f = (b * fair_probability - (1.0 - fair_probability)) / b
    return max(f, 0.0)


def fair_odds(fair_probability: float) -> float:
    if fair_probability <= 0:
        return math.inf
    return 1.0 / fair_probability
