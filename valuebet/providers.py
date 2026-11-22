"""Oran verisi sağlayıcıları.

- TheOddsAPIProvider: https://the-odds-api.com (ücretsiz plan: ayda 500 istek)
- SampleProvider: API anahtarı olmadan deneme için yerel örnek veri
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

import httpx

SAMPLE_PATH = Path(__file__).parent / "data" / "sample_odds.json"
SPORTS = {"nba": "basketball_nba", "nhl": "icehockey_nhl"}
SPORT_KEY = SPORTS["nba"]


class ProviderError(RuntimeError):
    pass


class SampleProvider:
    name = "demo"

    def __init__(self, path: Path = SAMPLE_PATH):
        self.path = path
        self.quota: dict[str, Any] = {}

    def fetch(self, markets: tuple[str, ...] = ("h2h", "spreads", "totals"), regions: str = "us,eu", sport: str = "nba") -> list[dict[str, Any]]:
        if sport != "nba":
            return []  # demo verisi yalnızca NBA için
        with open(self.path, encoding="utf-8") as fh:
            events = json.load(fh)
        for e in events:
            for b in e["bookmakers"]:
                b["markets"] = [m for m in b["markets"] if m["key"] in markets]
        return events


class TheOddsAPIProvider:
    name = "the-odds-api"
    BASE_URL = "https://api.the-odds-api.com/v4"

    def __init__(self, api_key: str | None = None, cache_seconds: int = 120, timeout: float = 15.0):
        self.api_key = api_key or os.environ.get("ODDS_API_KEY", "")
        if not self.api_key:
            raise ProviderError("ODDS_API_KEY tanımlı değil")
        self.cache_seconds = cache_seconds
        self.timeout = timeout
        self._cache: dict[tuple, tuple[float, list[dict[str, Any]]]] = {}
        self.quota: dict[str, Any] = {}

    def fetch(self, markets: tuple[str, ...] = ("h2h", "spreads", "totals"), regions: str = "us,eu", sport: str = "nba") -> list[dict[str, Any]]:
        if sport not in SPORTS:
            raise ProviderError(f"Bilinmeyen spor: {sport}. Seçenekler: {', '.join(SPORTS)}")
        key = (sport, tuple(sorted(markets)), regions)
        cached = self._cache.get(key)
        if cached and time.time() - cached[0] < self.cache_seconds:
            return cached[1]

        params = {
            "regions": regions,
            "markets": ",".join(markets),
            "oddsFormat": "decimal",
            "dateFormat": "iso",
        }
        try:
            resp = httpx.get(
                f"{self.BASE_URL}/sports/{SPORTS[sport]}/odds",
                params=params,
                # Anahtar URL yerine başlıkta gönderilir: loglara/geçmişe düşmez.
                headers={"x-api-key": self.api_key},
                timeout=self.timeout,
            )
        except httpx.HTTPError as exc:
            raise ProviderError(f"Oran servisine ulaşılamadı: {exc}") from exc

        if resp.status_code == 401:
            raise ProviderError("API anahtarı geçersiz (401)")
        if resp.status_code == 429:
            raise ProviderError("İstek limiti aşıldı (429)")
        if resp.status_code != 200:
            raise ProviderError(f"Oran servisi hata döndürdü: {resp.status_code} {resp.text[:200]}")

        self.quota = {
            "remaining": resp.headers.get("x-requests-remaining"),
            "used": resp.headers.get("x-requests-used"),
            "last_cost": resp.headers.get("x-requests-last"),
        }
        events = resp.json()
        self._cache[key] = (time.time(), events)
        return events


def get_provider(demo: bool | None = None):
    """API anahtarı varsa canlı veriyi, yoksa demo verisini kullanır."""
    if demo is None:
        demo = not os.environ.get("ODDS_API_KEY")
    return SampleProvider() if demo else TheOddsAPIProvider()
