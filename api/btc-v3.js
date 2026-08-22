'use strict';

const { buildBtcV3Snapshot } = require('../lib/btc-v3-snapshot');
const { UpstreamError } = require('../lib/binance-coinm');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const snapshot = await buildBtcV3Snapshot();
    return res.status(200).json(snapshot);
  } catch (error) {
    const status = error instanceof UpstreamError ? error.status : 500;
    return res.status(status).json({
      error: 'BTC_V3_DATA_UNAVAILABLE',
      message: error.message || 'Unable to calculate BTC V3 signal',
      autoTrade: false,
    });
  }
};
