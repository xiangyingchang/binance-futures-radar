'use strict';

const WATCHED_ENTITIES = Object.freeze([
  {
    id: '7-siblings',
    name: '7 Siblings',
    chainId: 1,
    addresses: Object.freeze([
      '0x28a55c4b4f9615fde3cdaddf6cc01fcf2e38a6b0',
    ]),
  },
]);

const TRACKED_TOKENS = Object.freeze({
  WETH: { address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', decimals: 18, kind: 'eth' },
  USDC: { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6, kind: 'stable' },
  USDT: { address: '0xdac17f958d2ee523a2206206994597c13d831ec7', decimals: 6, kind: 'stable' },
  DAI: { address: '0x6b175474e89094c44da98b954eedeac495271d0f', decimals: 18, kind: 'stable' },
  USDS: { address: '0xdc035d45d973e3ec169d2276ddab16f1e407384f', decimals: 18, kind: 'stable' },
});

const TOKEN_BY_ADDRESS = new Map(
  Object.entries(TRACKED_TOKENS).map(([symbol, config]) => [config.address, { symbol, ...config }]),
);

const DIRECT_PROTOCOL_HINTS = Object.freeze({
  '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2': 'Aave V3 Pool',
  '0xc13e21b648a5ee794902342038ff3adab66be987': 'Spark Pool',
});

function normalizeAddress(value) {
  return String(value || '').trim().toLowerCase();
}

function isTrackedAddress(address, entity = WATCHED_ENTITIES[0]) {
  const normalized = normalizeAddress(address);
  return entity.addresses.some((item) => normalizeAddress(item) === normalized);
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function units(rawValue, decimals) {
  try {
    const raw = BigInt(String(rawValue || '0'));
    const d = BigInt(Number(decimals || 0));
    const base = 10n ** d;
    const whole = raw / base;
    const fraction = raw % base;
    return Number(whole) + (Number(fraction) / Number(base));
  } catch (_) {
    return 0;
  }
}

function makeFlow({ hash, timestamp, asset, amount, direction, kind, from, to, source, functionName }) {
  const ts = Number(timestamp || 0);
  return {
    hash: String(hash || ''),
    timestamp: ts * (ts < 10_000_000_000 ? 1000 : 1),
    asset,
    amount: Math.abs(toNumber(amount)),
    direction,
    kind,
    from: normalizeAddress(from),
    to: normalizeAddress(to),
    source,
    functionName: String(functionName || '').trim(),
  };
}

function parseNormalTransactions(rows, entity) {
  const flows = [];
  const calls = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const fromTracked = isTrackedAddress(row?.from, entity);
    const toTracked = isTrackedAddress(row?.to, entity);
    if (!fromTracked && !toTracked) continue;
    const timestamp = Number(row?.timeStamp || 0);
    const valueEth = units(row?.value, 18);
    if (valueEth > 0) {
      flows.push(makeFlow({
        hash: row?.hash, timestamp, asset: 'ETH', amount: valueEth,
        direction: toTracked ? 'IN' : 'OUT', kind: 'eth', from: row?.from, to: row?.to,
        source: 'normal', functionName: row?.functionName,
      }));
    }
    if (fromTracked && String(row?.isError || '0') === '0') {
      const counterparty = normalizeAddress(row?.to);
      const protocol = DIRECT_PROTOCOL_HINTS[counterparty] || null;
      const fn = String(row?.functionName || '').toLowerCase();
      const action = /borrow/.test(fn) ? 'BORROW'
        : /repay/.test(fn) ? 'REPAY'
          : /supply|deposit/.test(fn) ? 'SUPPLY'
            : /withdraw/.test(fn) ? 'WITHDRAW'
              : null;
      if (protocol || action) {
        calls.push({ hash: String(row?.hash || ''), timestamp: timestamp * 1000, protocol, action, to: counterparty, functionName: String(row?.functionName || '') });
      }
    }
  }
  return { flows, calls };
}

function parseInternalTransactions(rows, entity) {
  const flows = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (String(row?.isError || '0') === '1') continue;
    const fromTracked = isTrackedAddress(row?.from, entity);
    const toTracked = isTrackedAddress(row?.to, entity);
    if (!fromTracked && !toTracked) continue;
    const valueEth = units(row?.value, 18);
    if (valueEth <= 0) continue;
    flows.push(makeFlow({
      hash: row?.hash, timestamp: row?.timeStamp, asset: 'ETH', amount: valueEth,
      direction: toTracked ? 'IN' : 'OUT', kind: 'eth', from: row?.from, to: row?.to, source: 'internal',
    }));
  }
  return flows;
}

function parseTokenTransfers(rows, entity) {
  const flows = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const token = TOKEN_BY_ADDRESS.get(normalizeAddress(row?.contractAddress));
    if (!token) continue;
    const fromTracked = isTrackedAddress(row?.from, entity);
    const toTracked = isTrackedAddress(row?.to, entity);
    if (!fromTracked && !toTracked) continue;
    const amount = units(row?.value, row?.tokenDecimal ?? token.decimals);
    if (amount <= 0) continue;
    flows.push(makeFlow({
      hash: row?.hash, timestamp: row?.timeStamp, asset: token.symbol, amount,
      direction: toTracked ? 'IN' : 'OUT', kind: token.kind, from: row?.from, to: row?.to,
      source: 'erc20', functionName: row?.functionName,
    }));
  }
  return flows;
}

function signed(flow) {
  return flow.direction === 'IN' ? flow.amount : -flow.amount;
}

function summarizeWindow(flows, sinceMs, ethPriceUsd) {
  let ethNet = 0;
  let stableNetUsd = 0;
  let grossEth = 0;
  let grossStableUsd = 0;
  for (const flow of flows) {
    if (flow.timestamp < sinceMs) continue;
    if (flow.kind === 'eth') {
      ethNet += signed(flow);
      grossEth += flow.amount;
    } else if (flow.kind === 'stable') {
      stableNetUsd += signed(flow);
      grossStableUsd += flow.amount;
    }
  }
  return { ethNet, ethNetUsd: ethNet * ethPriceUsd, stableNetUsd, grossEth, grossStableUsd };
}

function groupByTransaction(flows, calls, ethPriceUsd) {
  const map = new Map();
  function ensure(hash) {
    if (!map.has(hash)) {
      map.set(hash, { hash, timestamp: 0, ethNet: 0, stableNetUsd: 0, grossUsd: 0, assets: new Set(), counterparties: new Set(), calls: [] });
    }
    return map.get(hash);
  }
  for (const flow of flows) {
    if (!flow.hash) continue;
    const item = ensure(flow.hash);
    item.timestamp = Math.max(item.timestamp, flow.timestamp || 0);
    item.assets.add(flow.asset);
    const cp = flow.direction === 'IN' ? flow.from : flow.to;
    if (cp) item.counterparties.add(cp);
    if (flow.kind === 'eth') {
      item.ethNet += signed(flow);
      item.grossUsd += flow.amount * ethPriceUsd;
    } else if (flow.kind === 'stable') {
      item.stableNetUsd += signed(flow);
      item.grossUsd += flow.amount;
    }
  }
  for (const call of calls) {
    if (!call.hash) continue;
    const item = ensure(call.hash);
    item.timestamp = Math.max(item.timestamp, call.timestamp || 0);
    item.calls.push(call);
    if (call.to) item.counterparties.add(call.to);
  }

  return [...map.values()].map((item) => {
    const ethNetUsd = item.ethNet * ethPriceUsd;
    const callActions = item.calls.map((call) => call.action).filter(Boolean);
    let classification = 'TRANSFER_OR_UNKNOWN';
    let confidence = 'LOW';
    if (ethNetUsd >= 1_000_000 && item.stableNetUsd <= -500_000) {
      classification = 'ACCUMULATING'; confidence = 'HIGH';
    } else if (ethNetUsd <= -1_000_000 && item.stableNetUsd >= 500_000) {
      classification = 'DISTRIBUTING'; confidence = 'HIGH';
    } else if (callActions.includes('BORROW') && item.stableNetUsd > 0) {
      classification = 'LEVERAGE_BUILDING'; confidence = 'MEDIUM';
    } else if (callActions.includes('REPAY') && item.stableNetUsd < 0) {
      classification = 'DELEVERAGING'; confidence = 'MEDIUM';
    }
    const counterpartyHints = [...item.counterparties].map((address) => DIRECT_PROTOCOL_HINTS[address]).filter(Boolean);
    return {
      hash: item.hash, timestamp: item.timestamp, ethNet: item.ethNet, ethNetUsd,
      stableNetUsd: item.stableNetUsd, grossUsd: item.grossUsd,
      assets: [...item.assets], counterparties: [...item.counterparties].slice(0, 4),
      protocolHints: [...new Set([...item.calls.map((call) => call.protocol).filter(Boolean), ...counterpartyHints])],
      functionNames: item.calls.map((call) => call.functionName).filter(Boolean), classification, confidence,
    };
  }).sort((a, b) => b.timestamp - a.timestamp);
}

function deriveState(summary24h, txGroups, now = Date.now()) {
  const recent = txGroups.filter((item) => item.timestamp >= now - 24 * 60 * 60 * 1000);
  const hasBorrow = recent.some((item) => item.classification === 'LEVERAGE_BUILDING');
  const hasRepay = recent.some((item) => item.classification === 'DELEVERAGING');
  if (summary24h.ethNetUsd >= 10_000_000 && summary24h.stableNetUsd <= -5_000_000) {
    return { state: 'ACCUMULATING', score: 80, reason: '24H WETH/ETH 净流入显著，同时稳定币净流出，符合积累/买入特征。' };
  }
  if (summary24h.ethNetUsd <= -10_000_000 && summary24h.stableNetUsd >= 5_000_000) {
    return { state: 'DISTRIBUTING', score: -80, reason: '24H WETH/ETH 净流出显著，同时稳定币净流入，符合分发/卖出特征。' };
  }
  if (hasBorrow && summary24h.stableNetUsd >= 5_000_000) {
    return { state: 'LEVERAGE_BUILDING', score: 45, reason: '检测到借款提示且稳定币净流入，可能在建立后续购买力。' };
  }
  if (hasRepay && summary24h.stableNetUsd <= -5_000_000) {
    return { state: 'DELEVERAGING', score: -45, reason: '检测到还款提示且稳定币净流出，可能在降低杠杆。' };
  }
  if (summary24h.stableNetUsd >= 10_000_000) {
    return { state: 'NEUTRAL', score: 15, reason: '24H 出现大额稳定币净流入，但仅凭 Transfer logs 不能确认是借款还是内部调拨；继续观察后续 WETH 流向。' };
  }
  if (summary24h.stableNetUsd <= -10_000_000) {
    return { state: 'NEUTRAL', score: -15, reason: '24H 出现大额稳定币净流出，但仅凭 Transfer logs 不能确认是还款、买入还是内部调拨。' };
  }
  return { state: 'NEUTRAL', score: 0, reason: '当前登记地址 24H 未出现足够明确的大额方向性 WETH/稳定币资金流。' };
}

function buildWhaleSnapshot({ entity, normalRows, internalRows, tokenRows, ethPriceUsd, now = Date.now() }) {
  const normal = parseNormalTransactions(normalRows, entity);
  const internalFlows = parseInternalTransactions(internalRows, entity);
  const tokenFlows = parseTokenTransfers(tokenRows, entity);
  const flows = [...normal.flows, ...internalFlows, ...tokenFlows];
  const txGroups = groupByTransaction(flows, normal.calls, ethPriceUsd);
  const summary24h = summarizeWindow(flows, now - 24 * 60 * 60 * 1000, ethPriceUsd);
  const summary7d = summarizeWindow(flows, now - 7 * 24 * 60 * 60 * 1000, ethPriceUsd);
  const state = deriveState(summary24h, txGroups, now);
  const significantActions = txGroups.filter((item) => item.grossUsd >= 1_000_000 || Math.abs(item.ethNet) >= 500).slice(0, 12);
  return {
    entity: { id: entity.id, name: entity.name, chainId: entity.chainId, addresses: entity.addresses },
    ethPriceUsd, state, summary24h, summary7d, significantActions,
    coverage: {
      normalTransactions: Array.isArray(normalRows) ? normalRows.length : 0,
      internalTransactions: Array.isArray(internalRows) ? internalRows.length : 0,
      tokenTransfers: Array.isArray(tokenRows) ? tokenRows.length : 0,
      limitation: '仅覆盖当前手工登记地址；未登记代理/新钱包会漏报，低置信度资金流不强行解释。',
    },
  };
}

module.exports = {
  WATCHED_ENTITIES,
  TRACKED_TOKENS,
  normalizeAddress,
  isTrackedAddress,
  parseNormalTransactions,
  parseInternalTransactions,
  parseTokenTransfers,
  summarizeWindow,
  groupByTransaction,
  deriveState,
  buildWhaleSnapshot,
};
