# Binance Futures Radar

Live Binance USDⓈ-M futures radar for high-RSI short-watch candidates.

## Production

https://binance-futures-radar.vercel.app

The web UI no longer calls Binance directly from the browser. It requests the same-origin `/api/radar` Vercel Function, which performs the market scan server-side in Vercel `sin1` (Singapore).

## Strategy filters

- RSI 1h > 90
- RSI 4h >= 80
- Funding APR > -500%
- Rank > 100 when rank data is available
- 24h price change < 35%

## Architecture

Browser → `/api/radar` → Binance Futures API

This avoids Safari/CORS/network failures and the HTTP 451 restriction seen from US-hosted GitHub/Vercel compute.
