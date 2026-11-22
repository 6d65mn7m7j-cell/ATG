# NBA Değerli Bahis Bulucu

NBA maçlarında bahis şirketlerinin oranlarını karşılaştırıp **pozitif beklenen değerli (+EV)** bahisleri bulan uygulama. Web arayüzü, REST API ve komut satırı aracı içerir.

## Nasıl çalışır?

1. **Oranlar** [The Odds API](https://the-odds-api.com) üzerinden çekilir (Maç Sonucu, Handikap, Toplam Sayı).
2. **Adil olasılık** — Pinnacle gibi düşük marjlı "keskin" bir şirketin oranlarından marj (vig) temizlenerek bulunur. Keskin şirket yoksa diğer şirketlerin marjsız olasılıklarının medyanı (konsensüs) kullanılır. Değerlendirilen şirket kendi referansına dahil edilmez.
   - Marj temizleme yöntemleri: `power` (varsayılan), `shin`, `multiplicative`, `additive`.
3. **EV** = adil olasılık × oran − 1. EV, belirlediğiniz eşiğin üstündeyse bahis listelenir. %25'in üzerindeki EV'ler büyük ihtimalle hatalı/eski oran olduğundan elenir.
4. **Stake** — Kelly kriteri × seçilen çarpan (varsayılan çeyrek Kelly), tek bahiste kasanın en fazla %3'ü.
5. Handikap ve toplam marketlerinde yalnızca **aynı çizgideki** (ör. -4.5 ile -4.5) teklifler karşılaştırılır.

## Kurulum

```bash
pip install -r requirements.txt
export ODDS_API_KEY=anahtarınız   # the-odds-api.com'dan ücretsiz alınır; yoksa demo verisi kullanılır
```

## Kullanım

**Web arayüzü**

```bash
uvicorn valuebet.server:app --reload
# http://localhost:8000
```

**Komut satırı**

```bash
python -m valuebet --demo                         # örnek veriyle dene
python -m valuebet --min-edge 0.03 --books draftkings,fanduel
python -m valuebet --reference consensus --devig shin --json
```

**API**

`GET /api/value-bets?min_edge=0.02&reference=sharp&devig=power&markets=h2h,spreads,totals&books=draftkings,fanduel&bankroll=1000&kelly=0.25`

## Notlar

- Ücretsiz API planı ayda 500 istek verir; her tarama (3 market × 2 bölge) 6 istek harcar. Yanıtlar 120 sn önbelleğe alınır (`CACHE_SECONDS`).
- Pinnacle oranları `eu` bölgesindedir; bu yüzden varsayılan bölge `us,eu`'dur.
- Demo verisi `scripts/generate_sample.py` ile üretilir.
- Testler: `python -m pytest`

> **Uyarı:** Oranlar hızla değişir; bahis yapmadan önce oranı şirkette doğrulayın. +EV uzun vadeli bir avantajdır, tekil bahislerde kayıp olağandır. Yalnızca bulunduğunuz ülkede yasal ve lisanslı kanalları kullanın, 18 yaş altıysanız bahis oynamayın ve kaybetmeyi göze alamayacağınız parayla oynamayın.
