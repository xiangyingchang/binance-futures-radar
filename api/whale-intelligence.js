'use strict';

const { WATCHED_ENTITIES, buildWhaleSnapshot } = require('../lib/whale-intelligence');

const ETHERSCAN_BASE = 'https://api.etherscan.io/v2/api';
const CHAIN_ID = 1;
const LOOKBACK_DAYS = 7;
const REQUEST_TIMEOUT_MS = 12000;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function fetchEtherscan(apiKey, params) {
  const url = new URL(ETHERSCAN_BASE);
  const merged = { chainid: CHAIN_ID, apikey: apiKey, ...params };
  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'binance-futures-radar-whale/1.0' },
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Etherscan HTTP ${response.status}`);
    if (!payload) throw new Error('Etherscan returned an empty response');

    const noTransactions = payload.status === '0'
      && /no transactions found/i.test(String(payload.message || payload.result || ''));
    if (noTransactions) return [];

    if (payload.status === '0' && !Array.isArray(payload.result)) {
      throw new Error(String(payload.result || payload.message || 'Etherscan API error'));
    }
    return payload.result;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Etherscan request timed out');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = String(process.env.ETHERSCAN_API_KEY || '').trim();
  if (!apiKey) {
    return res.status(200).json({
      configured: false,
      source: 'etherscan-v2',
      message: 'ETHERSCAN_API_KEY is not configured. Add a free Etherscan API key in Vercel Environment Variables.',
      entities: WATCHED_ENTITIES.map((entity) => ({
        id: entity.id,
        name: entity.name,
        addresses: entity.addresses,
      })),
    });
  }

  const now = Date.now();
  const since = Math.floor((now - LOOKBACK_DAYS * 24 * 60 * 60 * 1000) / 1000);
  try {
    const [startBlockRaw, ethPriceRaw] = await Promise.all([
      fetchEtherscan(apiKey, {
        module: 'block',
        action: 'getblocknobytime',
        timestamp: since,
        closest: 'before',
      }),
      fetchEtherscan(apiKey, {
        module: 'stats',
        action: 'ethprice',
      }),
    ]);

    const startBlock = Number(startBlockRaw);
    const ethPriceUsd = Number(ethPriceRaw?.ethusd || 0);
    if (!Number.isFinite(startBlock) || startBlock <= 0) throw new Error('Unable to resolve 7-day start block');
    if (!Number.isFinite(ethPriceUsd) || ethPriceUsd <= 0) throw new Error('Unable to resolve ETH/USD price');

    const snapshots = [];
    for (const entity of WATCHED_ENTITIES) {
      // One address for now; append addresses to lib/whale-intelligence.js as the cluster expands.
      // For multiple addresses we fetch each separately and merge the raw rows before classification.
      const normalRows = [];
      const internalRows = [];
      const tokenRows = [];

      for (const address of entity.addresses) {
        const common = {
          module: 'account',
          address,
          startblock: startBlock,
          endblock: 999999999,
          page: 1,
          offset: 1000,
          sort: 'desc',
        };

        const [normal, token, internal] = await Promise.all([
          fetchEtherscan(apiKey, { ...common, action: 'txlist' }),
          fetchEtherscan(apiKey, { ...common, action: 'tokentx' }),
          fetchEtherscan(apiKey, { ...common, action: 'txlistinternal' }),
        ]);
        normalRows.push(...(Array.isArray(normal) ? normal : []));
        tokenRows.push(...(Array.isArray(token) ? token : []));
        internalRows.push(...(Array.isArray(internal) ? internal : []));
      }

      snapshots.push(buildWhaleSnapshot({
        entity,
        normalRows,
        internalRows,
        tokenRows,
        ethPriceUsd,
        now,
      }));
    }

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({
      configured: true,
      source: 'etherscan-v2',
      generatedAt: new Date(now).toISOString(),
      lookbackDays: LOOKBACK_DAYS,
      snapshots,
    });
  } catch (error) {
    return res.status(502).json({
      configured: true,
      source: 'etherscan-v2',
      error: 'WHALE_DATA_UNAVAILABLE',
      message: error.message || 'Unable to load whale data',
    });
  }
}

module.exports = handler;
