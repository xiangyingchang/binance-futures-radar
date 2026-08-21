'use strict';

const { WATCHED_ENTITIES, TRACKED_TOKENS, buildWhaleSnapshot } = require('../lib/whale-intelligence');

const CHAIN_ID = 1;
const LOOKBACK_DAYS = 7;
const LOOKBACK_BLOCKS = 60_000; // >7d at ~12s/block; exact windows are filtered by block timestamps later.
const LOG_BLOCK_CHUNK = 7_500;
const REQUEST_TIMEOUT_MS = 12_000;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const CHAINLINK_ETH_USD = '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419';
const CHAINLINK_LATEST_ROUND_DATA = '0xfeaf968c';
const PUBLIC_RPC_URLS = [
  String(process.env.ETHEREUM_RPC_URL || '').trim(),
  'https://ethereum-rpc.publicnode.com',
  'https://eth.llamarpc.com',
  'https://cloudflare-eth.com',
].filter(Boolean);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function hexNumber(value) {
  return `0x${Number(value).toString(16)}`;
}

function padTopicAddress(address) {
  return `0x${String(address || '').toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
}

function topicToAddress(topic) {
  const clean = String(topic || '').replace(/^0x/, '');
  return clean.length >= 40 ? `0x${clean.slice(-40)}`.toLowerCase() : '';
}

function decodeUint(hex) {
  try { return BigInt(hex || '0x0').toString(); } catch (_) { return '0'; }
}

function tokenByAddress(address) {
  const normalized = String(address || '').toLowerCase();
  for (const [symbol, config] of Object.entries(TRACKED_TOKENS)) {
    if (config.address.toLowerCase() === normalized) return { symbol, ...config };
  }
  return null;
}

async function fetchRpc(url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'binance-futures-radar-whale/2.0',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const payload = await response.json().catch(() => null);
    if (!payload) throw new Error('RPC returned empty response');
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('RPC request timed out');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function rpcCall(method, params = []) {
  const errors = [];
  for (const url of PUBLIC_RPC_URLS) {
    try {
      const payload = await fetchRpc(url, { jsonrpc: '2.0', id: 1, method, params });
      if (payload.error) throw new Error(payload.error.message || 'RPC error');
      return { result: payload.result, rpcUrl: url };
    } catch (error) {
      errors.push(`${new URL(url).hostname}: ${error.message}`);
    }
  }
  throw new Error(`All Ethereum RPC endpoints failed: ${errors.join(' | ')}`);
}

async function rpcBatch(calls) {
  if (!calls.length) return { results: [], rpcUrl: null };
  const errors = [];
  for (const url of PUBLIC_RPC_URLS) {
    try {
      const body = calls.map((call, index) => ({
        jsonrpc: '2.0', id: index + 1, method: call.method, params: call.params || [],
      }));
      const payload = await fetchRpc(url, body);
      if (!Array.isArray(payload)) throw new Error('RPC batch response is not an array');
      const byId = new Map(payload.map((item) => [Number(item.id), item]));
      const results = body.map((request) => {
        const item = byId.get(request.id);
        if (!item) throw new Error(`Missing RPC batch result ${request.id}`);
        if (item.error) throw new Error(item.error.message || 'RPC batch error');
        return item.result;
      });
      return { results, rpcUrl: url };
    } catch (error) {
      errors.push(`${new URL(url).hostname}: ${error.message}`);
    }
  }
  throw new Error(`All Ethereum RPC endpoints failed: ${errors.join(' | ')}`);
}

function decodeChainlinkEthUsd(raw) {
  const clean = String(raw || '').replace(/^0x/, '');
  if (clean.length < 128) return null;
  try {
    const answerWord = BigInt(`0x${clean.slice(64, 128)}`);
    const signed = answerWord >= (1n << 255n) ? answerWord - (1n << 256n) : answerWord;
    const price = Number(signed) / 1e8;
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch (_) {
    return null;
  }
}

function uniqueLogs(logs) {
  const seen = new Set();
  const out = [];
  for (const log of logs) {
    const key = `${log?.transactionHash || ''}:${log?.logIndex || ''}`;
    if (!log?.transactionHash || seen.has(key)) continue;
    seen.add(key);
    out.push(log);
  }
  return out;
}

function buildRanges(startBlock, endBlock) {
  const ranges = [];
  for (let from = startBlock; from <= endBlock; from += LOG_BLOCK_CHUNK) {
    ranges.push([from, Math.min(endBlock, from + LOG_BLOCK_CHUNK - 1)]);
  }
  return ranges;
}

async function fetchTrackedTransferLogs(entity, startBlock, endBlock) {
  const tokenAddresses = Object.values(TRACKED_TOKENS).map((token) => token.address);
  const watchedTopics = entity.addresses.map(padTopicAddress);
  const calls = [];
  for (const [fromBlock, toBlock] of buildRanges(startBlock, endBlock)) {
    const common = { address: tokenAddresses, fromBlock: hexNumber(fromBlock), toBlock: hexNumber(toBlock) };
    calls.push({
      method: 'eth_getLogs',
      params: [{ ...common, topics: [TRANSFER_TOPIC, watchedTopics] }],
    });
    calls.push({
      method: 'eth_getLogs',
      params: [{ ...common, topics: [TRANSFER_TOPIC, null, watchedTopics] }],
    });
  }

  const logs = [];
  let rpcUrl = null;
  for (let i = 0; i < calls.length; i += 6) {
    const batch = await rpcBatch(calls.slice(i, i + 6));
    rpcUrl = rpcUrl || batch.rpcUrl;
    for (const result of batch.results) logs.push(...(Array.isArray(result) ? result : []));
  }
  return { logs: uniqueLogs(logs), rpcUrl };
}

async function fetchBlockTimestamps(blockNumbers) {
  const unique = [...new Set(blockNumbers.filter(Number.isFinite))];
  const timestamps = new Map();
  for (let i = 0; i < unique.length; i += 50) {
    const slice = unique.slice(i, i + 50);
    const batch = await rpcBatch(slice.map((blockNumber) => ({
      method: 'eth_getBlockByNumber', params: [hexNumber(blockNumber), false],
    })));
    batch.results.forEach((block, index) => {
      const ts = Number.parseInt(block?.timestamp || '0x0', 16);
      if (Number.isFinite(ts) && ts > 0) timestamps.set(slice[index], ts);
    });
  }
  return timestamps;
}

function logsToTokenRows(logs, timestamps) {
  return logs.map((log) => {
    const token = tokenByAddress(log?.address);
    const blockNumber = Number.parseInt(log?.blockNumber || '0x0', 16);
    if (!token || !Array.isArray(log?.topics) || log.topics.length < 3) return null;
    return {
      hash: log.transactionHash,
      timeStamp: String(timestamps.get(blockNumber) || 0),
      from: topicToAddress(log.topics[1]),
      to: topicToAddress(log.topics[2]),
      contractAddress: token.address,
      value: decodeUint(log.data),
      tokenDecimal: String(token.decimals),
      tokenSymbol: token.symbol,
    };
  }).filter((row) => row && Number(row.timeStamp) > 0);
}

async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const now = Date.now();
  try {
    const [{ result: latestBlockHex }, { result: priceRaw }] = await Promise.all([
      rpcCall('eth_blockNumber'),
      rpcCall('eth_call', [{ to: CHAINLINK_ETH_USD, data: CHAINLINK_LATEST_ROUND_DATA }, 'latest']),
    ]);
    const latestBlock = Number.parseInt(latestBlockHex || '0x0', 16);
    const ethPriceUsd = decodeChainlinkEthUsd(priceRaw);
    if (!Number.isFinite(latestBlock) || latestBlock <= 0) throw new Error('Unable to resolve latest Ethereum block');
    if (!Number.isFinite(ethPriceUsd) || ethPriceUsd <= 0) throw new Error('Unable to resolve Chainlink ETH/USD price');

    const startBlock = Math.max(0, latestBlock - LOOKBACK_BLOCKS);
    const snapshots = [];
    let activeRpcUrl = null;

    for (const entity of WATCHED_ENTITIES) {
      const transferResult = await fetchTrackedTransferLogs(entity, startBlock, latestBlock);
      activeRpcUrl = activeRpcUrl || transferResult.rpcUrl;
      const blockNumbers = transferResult.logs.map((log) => Number.parseInt(log.blockNumber || '0x0', 16));
      const timestamps = await fetchBlockTimestamps(blockNumbers);
      const tokenRows = logsToTokenRows(transferResult.logs, timestamps);
      const snapshot = buildWhaleSnapshot({
        entity,
        normalRows: [],
        internalRows: [],
        tokenRows,
        ethPriceUsd,
        now,
      });
      snapshot.coverage = {
        ...snapshot.coverage,
        source: 'ethereum-public-rpc',
        trackedTransferLogs: tokenRows.length,
        limitation: '当前 RPC MVP 直接读取 WETH/USDC/USDT/DAI/USDS Transfer logs。可可靠识别这些 ERC20 资金流，但不完整覆盖纯原生 ETH 转账、internal trace、CEX 标签和未登记代理/新钱包；协议/借贷含义只有在资金流足够明确时才推断。',
      };
      snapshots.push(snapshot);
    }

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({
      configured: true,
      source: 'ethereum-public-rpc',
      rpcHost: activeRpcUrl ? new URL(activeRpcUrl).hostname : null,
      generatedAt: new Date(now).toISOString(),
      lookbackDays: LOOKBACK_DAYS,
      latestBlock,
      ethPriceSource: 'chainlink-mainnet',
      snapshots,
    });
  } catch (error) {
    return res.status(502).json({
      configured: true,
      source: 'ethereum-public-rpc',
      error: 'WHALE_DATA_UNAVAILABLE',
      message: error.message || 'Unable to load whale data from Ethereum RPC',
    });
  }
}

module.exports = handler;
module.exports._test = {
  padTopicAddress,
  topicToAddress,
  decodeUint,
  decodeChainlinkEthUsd,
  logsToTokenRows,
  buildRanges,
};
