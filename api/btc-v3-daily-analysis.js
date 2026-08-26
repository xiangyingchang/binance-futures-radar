'use strict';

const CANONICAL_URL = 'https://raw.githubusercontent.com/xiangyingchang/binance-futures-radar/main/data/btc-v3-daily-analysis.json';

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let response;
    try {
      response = await fetch(`${CANONICAL_URL}?t=${Date.now()}`, {
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'binance-futures-radar-v3-daily-analysis/1.0',
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      return res.status(502).json({
        status: 'error',
        error: 'BTC_V3_DAILY_ANALYSIS_UPSTREAM_ERROR',
        summary: `Canonical daily analysis fetch failed: HTTP ${response.status}`,
        source: CANONICAL_URL,
      });
    }

    const data = await response.json();
    if (!data || typeof data !== 'object' || !data.candleDate || !data.generatedAt || !data.strategyVersion) {
      return res.status(502).json({
        status: 'error',
        error: 'BTC_V3_DAILY_ANALYSIS_INVALID_PAYLOAD',
        summary: 'Canonical daily analysis payload is incomplete.',
        source: CANONICAL_URL,
      });
    }

    return res.status(200).json({ ...data, servedVia: 'vercel-same-origin-proxy' });
  } catch (error) {
    return res.status(502).json({
      status: 'error',
      error: 'BTC_V3_DAILY_ANALYSIS_UNAVAILABLE',
      summary: `Canonical daily analysis fetch failed: ${error?.name === 'AbortError' ? 'timeout' : (error?.message || error)}`,
      source: CANONICAL_URL,
    });
  }
};
