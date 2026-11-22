# Değerli Bahis Bulucu (NBA · NHL · EuroLeague · NFL)

NBA, NHL, EuroLeague ve NFL maçlarında bahis şirketlerinin oranlarını karşılaştırıp **pozitif beklenen değerli (+EV)** bahisleri bulan uygulama. Web arayüzü, REST API ve komut satırı aracı içerir.

## Nasıl çalışır?

1. **Oranlar** [The Odds API](https://the-odds-api.com) üzerinden çekilir (Maç Sonucu, Handikap, Toplam Sayı).
2. **Adil olasılık** — Pinnacle gibi düşük marjlı "keskin" bir şirketin oranlarından marj (vig) temizlenerek bulunur. Keskin şirket yoksa diğer şirketlerin marjsız olasılıklarının medyanı (konsensüs) kullanılır. Değerlendirilen şirket kendi referansına dahil edilmez.
   - Marj temizleme yöntemleri: `power` (varsayılan), `shin`, `multiplicative`, `additive`.
3. **EV** = adil olasılık × oran − 1. EV, belirlediğiniz eşiğin üstündeyse bahis listelenir. %25'in üzerindeki EV'ler büyük ihtimalle hatalı/eski oran olduğundan elenir.
4. **Stake** — Kelly kriteri × seçilen çarpan (varsayılan çeyrek Kelly), tek bahiste kasanın en fazla %3'ü.
5. Handikap ve toplam marketlerinde yalnızca **aynı çizgideki** (ör. -4.5 ile -4.5) teklifler karşılaştırılır.

## iPhone uygulaması (PWA)

`docs/` klasörü sunucu gerektirmeyen, tamamen telefonda çalışan bir web uygulamasıdır. Oranları doğrudan The Odds API'den çeker, hesaplamayı cihazda yapar (motor: `docs/valuebet.js`, Python motoruyla birebir aynı sonuçları verdiği testlerle doğrulanır). API anahtarı yalnızca cihazın tarayıcı deposunda tutulur.

- Yayınlama: GitHub → Settings → Pages → *Deploy from a branch* → dal ve `/docs` klasörü.
- iPhone'a ekleme: Safari'de sayfayı açın → **Paylaş** → **Ana Ekrana Ekle**.
- Ayarlar değiştirildiğinde yeniden API isteği yapılmaz; son çekilen oranlar üzerinden yeniden hesaplanır (kota dostu).
- **iddaa sekmesi:** iddaa'da gördüğünüz oranları (maç sonucu, handikap, alt/üst) ve maçın MBS değerini elle girersiniz. Oranlar Pinnacle'ın marjsız oranıyla karşılaştırılır; iddaa çizgisi farklıysa adil olasılık normal dağılım modeliyle (fark σ≈12.5, toplam σ≈18.5) düzeltilir. MBS kuralına uyan ve her maçtan tek seçim içeren pozitif EV'li kuponlar, beklenen log büyümesine göre sıralanarak önerilir. Girişler yalnızca cihazda saklanır.
- **Uzatmalar (iddaa):** iddaa NBA'de uzatmalar sayılır, NHL'de sayılmaz. Bu yüzden basketbol (NBA, EuroLeague) ve NFL varsayılan olarak **uzatmalar dahil** (MS iki yönlü) değerlendirilir; NHL her zaman normal süredir. iddaa sekmesindeki "Uzatmalar sayılmaz" anahtarı lig bazında hatırlanır: açıldığında o lig normal süre modeline geçer (MS 1-X-2, normal süre handikap ve alt/üst). Normal süre modeli Pinnacle'ın uzatmalar dahil oranlarına uydurulur: fark ayrık normal dağılım, beraberlik olasılığı lige özgü uzatma oranına (NBA ~%6, EuroLeague ~%5, NFL ~%5,5) kalibre, uzatma yazı-tura; toplamdan uzatmanın ortalama katkısı düşülür. Normal süre bahisleri kayıtta elle sonuçlandırılır.
- **NHL:** Üstteki NBA/NHL düğmesiyle spor değiştirilir; her spor için son tarama ayrı saklanır. iddaa'da buz hokeyi normal süreye (60 dk) göre oynandığı için NHL kartında MS ve handikap 1-X-2, alt/üst normal süre golleri olarak girilir. Adil olasılıklar, Pinnacle'ın uzatmalar dahil maç sonucu ve toplam gol oranlarına uydurulan bir Poisson gol modelinden türetilir (normal sürede beraberlik NHL gerçeğine göre ~%21-23'e kalibre edilir, uzatma/penaltı yazı-tura ve toplam gole +1 sayılır). NBA ve NHL girişleri aynı kuponda birleştirilebilir.
- Yerelde deneme: `python -m http.server -d docs 8080`

## Bahis kaydı

Uygulamadaki **Kayıt** sekmesi: değerli bahisleri (ayrıntıda "Kayda ekle") ve iddaa kupon önerilerini kaydeder. Kâr/zarar, ROI, kazanma oranı, ortalama EV ve **CLV** (aldığınız oranın, maç başlamadan önceki son taramadaki adil olasılığa göre değeri) gösterilir. "Sonuçları güncelle" biten maçların skorlarını çekip (lig başına 2 istek) bahisleri otomatik sonuçlandırır; iddaa hokey (normal süre) bahisleri elle sonuçlandırılır. CSV dışa aktarma ve JSON yedek/geri yükleme vardır. Kayıtlar yalnızca cihazdadır.

## Zamanlanmış tarama ve bildirim

`.github/workflows/scan.yml` her gün 18:07 (TR) `scripts/scan_notify.py`'yi çalıştırır; değerli bahis bulursa [ntfy](https://ntfy.sh) ile telefona bildirim gönderir. Aynı bahis iki kez bildirilmez.

- Gerekli repo gizli değerleri (Settings → Secrets and variables → Actions): `ODDS_API_KEY`, `NTFY_TOPIC`.
- Ayarlar `notify.json`'da: ligler, bölge (`eu` = lig başına 3 istek), kaç saat ilerisi, en düşük EV, oran aralığı, şirket filtresi, kota alt sınırı.
- Kota: maç listesi ücretsiz `/events` uç noktasından alınır; önümüzdeki saatlerde maçı olmayan lige istek harcanmaz. Kabaca ayda ~250 istek.
- Elle çalıştırma: Actions → "Değerli bahis taraması" → Run workflow. Yerel deneme: `python scripts/scan_notify.py --demo --dry-run`.

**NHL notu:** Bazı Avrupa şirketleri hokey alt/üst ve handikabını uzatmasız fiyatlar; Pinnacle uzatmayı sayar. Karışmasın diye hokeyde handikap/toplam yalnızca uzatmayı saydığı bilinen şirketler arasında karşılaştırılır (`HOCKEY_OT_BOOKS`).

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
python -m valuebet --sport nhl                    # NHL
python -m valuebet --min-edge 0.03 --books draftkings,fanduel
python -m valuebet --reference consensus --devig shin --json
```

**API**

`GET /api/value-bets?min_edge=0.02&reference=sharp&devig=power&markets=h2h,spreads,totals&books=draftkings,fanduel&bankroll=1000&kelly=0.25`

## Notlar

- Ücretsiz API planı ayda 500 istek verir; her tarama (3 market × 2 bölge) 6 istek harcar. Yanıtlar 120 sn önbelleğe alınır (`CACHE_SECONDS`).
- Anahtar URL'de değil `x-api-key` başlığında gönderilir.
- Betfair/Matchbook gibi borsalarda EV, komisyon (%5 / %2) düşülmüş net orana göre hesaplanır.
- Pinnacle oranları `eu` bölgesindedir; bu yüzden varsayılan bölge `us,eu`'dur.
- Demo verisi `scripts/generate_sample.py` ile üretilir.
- Testler: `python -m pytest`

> **Uyarı:** Oranlar hızla değişir; bahis yapmadan önce oranı şirkette doğrulayın. +EV uzun vadeli bir avantajdır, tekil bahislerde kayıp olağandır. Yalnızca bulunduğunuz ülkede yasal ve lisanslı kanalları kullanın, 18 yaş altıysanız bahis oynamayın ve kaybetmeyi göze alamayacağınız parayla oynamayın.
