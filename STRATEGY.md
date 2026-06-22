# MarketLens Trading Strategy — v6 (Validated)

**Status:** ✅ Walk-Forward validiert | Letzte Aktualisierung: Juni 2026

---

## Kernergebnis

| Zeitraum | Trades | WR | Gesamt R | Ø/Trade |
|---|---|---|---|---|
| In-Sample (~300 Tage) | 58 | 25.9% | +24.0R | 0.41R |
| **Out-of-Sample (~200 Tage)** | **42** | **21.4%** | **+10.0R** | **0.24R** |
| Gesamt (~500 Tage) | 100 | 24.0% | +34.0R | 0.34R |

Strategie funktioniert auf ungesehenen Daten → kein Overfitting.

---

## Signal-Filter (alle müssen erfüllt sein)

1. **EMA Cross** — EMA20 kreuzt EMA50 auf dem 4h-Chart
   - LONG: Golden Cross (EMA20 überholt EMA50 von unten)
   - SHORT: Death Cross (EMA20 fällt unter EMA50)

2. **EMA200 Makro** — Preis muss auf der richtigen Seite der EMA200 sein
   - LONG nur wenn Preis > EMA200
   - SHORT nur wenn Preis < EMA200

3. **BTC Master Filter** — BTC muss Richtung bestätigen
   - LONG Alts nur wenn BTC > EMA200
   - SHORT Alts nur wenn BTC < EMA200

4. **Volumen** — Aktuelles Volumen ≥ 1.0× 20-Kerzen-Durchschnitt

5. **ADX Rising** — ADX(14) jetzt > ADX vor 3 Kerzen
   - Fängt frühe Trenddynamik, vermeidet Seitwärtsmärkte

6. **1h Bestätigung** — Gleiche Richtung auch auf dem 1h-Chart

---

## Entry & Exit

| Level | Berechnung | Aktion |
|---|---|---|
| Entry | Aktueller Preis beim Signal | Voll rein |
| Stop Loss | max(20-Kerzen-Tief, Preis − ATR×1.5) | −1R |
| TP1 (2R) | Entry + Risk × 2 | 50% raus, SL → Break-Even |
| TP2 (4R) | Entry + Risk × 4 | Rest raus, +3R total |
| Break-Even | SL trifft Entry nach TP1 | +1R total |

**Risk (R)** = Abstand Entry zu Stop Loss

---

## Coins im Channel

| Coin | 500-Tage R | WR | Status |
|---|---|---|---|
| XRPUSDT | +7.0R | 43% | ✅ |
| ETHUSDT | +6.0R | 25% | ✅ |
| SOLUSDT | +6.0R | 30% | ✅ |
| LINKUSDT | +6.0R | 40% | ✅ |
| BNBUSDT | +5.0R | 40% | ✅ |
| LTCUSDT | +4.0R | 17% | ✅ |

**Raus (negativ über 500 Tage):** AVAX (−1R), DOT (−3R), BTC als Signal (−1R)
**Bewusst ausgelassen:** ATOM (zu wenig Trades), ADA (zu wenig Trades)
**BTC:** Nur Master Filter, kein eigenes Signal

---

## Was getestet und verworfen wurde

| Ansatz | Ergebnis | Grund |
|---|---|---|
| ADX > 25 Threshold | ❌ | Zu wenige Signale, +3R |
| ADX > 20 Threshold | ❌ | Negative Coins |
| Trailing Stop (EMA20) | ❌ | +8.7R vs +11R |
| Hybrid Trail | ❌ | +4.1R vs +8.0R |
| RSI < 65 / > 35 Filter | ❌ | +9R vs +34R (zu viele gute Trades rausgefiltert) |

---

## Technische Parameter

```
Timeframe:       4h primär, 1h Bestätigung
Lookback:        210 Kerzen (EMA200 Warmup)
Cooldown:        6 Kerzen (24h) zwischen Signalen pro Coin
SL Berechnung:   max(20-Kerzen-Tief, Preis − ATR(14) × 1.5)
Max SL:          8% vom Preis
ADX Periode:     14
ADX Rising:      ADX[now] > ADX[now−3]
Volumen:         Aktuell / 20-Kerzen-Avg ≥ 1.0
```

---

## Nächste Optimierungsideen (noch nicht getestet)

- Volumen-Threshold erhöhen (1.0x → 1.2x)
- Cooldown erhöhen (6 → 8 Kerzen)
- SL-Multiplikator anpassen (1.5 → 2.0)
- ADA testen mit mehr historischen Daten
