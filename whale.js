'use strict';

(() => {
  const root = document.getElementById('whale-section');
  if (!root) return;

  const els = {
    status: document.getElementById('whale-api-status'),
    refresh: document.getElementById('whale-refresh-btn'),
    state: document.getElementById('whale-state'),
    stateReason: document.getElementById('whale-state-reason'),
    eth24h: document.getElementById('whale-eth-24h'),
    stable24h: document.getElementById('whale-stable-24h'),
    eth7d: document.getElementById('whale-eth-7d'),
    addressCount: document.getElementById('whale-address-count'),
    updated: document.getElementById('whale-updated'),
    tableBody: document.getElementById('whale-actions-body'),
    empty: document.getElementById('whale-empty'),
  };

  const API = '/api/whale-intelligence';

  function setStatus(text, level = 'normal') {
    els.status.textContent = text;
    els.status.dataset.level = level;
  }

  function fmtNumber(value, digits = 1) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: digits }) : '—';
  }

  function compactUsd(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    const sign = n > 0 ? '+' : n < 0 ? '-' : '';
    const x = Math.abs(n);
    if (x >= 1e9) return `${sign}$${(x / 1e9).toFixed(2)}B`;
    if (x >= 1e6) return `${sign}$${(x / 1e6).toFixed(2)}M`;
    if (x >= 1e3) return `${sign}$${(x / 1e3).toFixed(0)}K`;
    return `${sign}$${x.toFixed(0)}`;
  }

  function fmtEth(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return `${n >= 0 ? '+' : ''}${fmtNumber(n, Math.abs(n) >= 100 ? 0 : 2)} ETH`;
  }

  function formatTime(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('zh-CN', { hour12: false });
  }

  function stateMeta(state) {
    if (state === 'ACCUMULATING') return { label: 'ACCUMULATING', className: 'whale-positive' };
    if (state === 'DISTRIBUTING') return { label: 'DISTRIBUTING', className: 'whale-negative' };
    if (state === 'LEVERAGE_BUILDING') return { label: 'LEVERAGE BUILDING', className: 'whale-warning' };
    if (state === 'DELEVERAGING') return { label: 'DELEVERAGING', className: 'whale-negative' };
    return { label: 'NEUTRAL', className: 'whale-neutral' };
  }

  function actionMeta(action) {
    const state = action?.classification || 'TRANSFER_OR_UNKNOWN';
    if (state === 'ACCUMULATING') return { label: '买入/积累', className: 'whale-positive' };
    if (state === 'DISTRIBUTING') return { label: '卖出/分发', className: 'whale-negative' };
    if (state === 'LEVERAGE_BUILDING') return { label: '加杠杆', className: 'whale-warning' };
    if (state === 'DELEVERAGING') return { label: '去杠杆', className: 'whale-negative' };
    return { label: '资金流/待确认', className: 'whale-neutral' };
  }

  function renderUnconfigured(payload) {
    const addresses = payload?.entities?.flatMap((x) => x.addresses || []) || [];
    els.addressCount.textContent = `地址：${addresses.length}`;
    els.state.textContent = '未配置数据源';
    els.state.className = 'whale-state whale-neutral';
    els.stateReason.textContent = '在 Vercel Environment Variables 添加 ETHERSCAN_API_KEY 后即可读取链上数据。Etherscan 免费 API 已足够当前单地址使用。';
    els.eth24h.textContent = '—';
    els.stable24h.textContent = '—';
    els.eth7d.textContent = '—';
    els.tableBody.innerHTML = '';
    els.empty.classList.remove('hidden');
    els.empty.textContent = '数据源未配置。地址已经写入系统，配置 API Key 后无需改代码。';
    setStatus('等待 ETHERSCAN_API_KEY', 'warning');
  }

  function render(payload) {
    if (!payload?.configured) return renderUnconfigured(payload);
    const snap = payload?.snapshots?.[0];
    if (!snap) throw new Error('没有返回巨鲸快照');

    const meta = stateMeta(snap.state?.state);
    els.state.textContent = meta.label;
    els.state.className = `whale-state ${meta.className}`;
    els.stateReason.textContent = snap.state?.reason || '—';
    els.eth24h.textContent = `${fmtEth(snap.summary24h?.ethNet)} · ${compactUsd(snap.summary24h?.ethNetUsd)}`;
    els.stable24h.textContent = compactUsd(snap.summary24h?.stableNetUsd);
    els.eth7d.textContent = `${fmtEth(snap.summary7d?.ethNet)} · ${compactUsd(snap.summary7d?.ethNetUsd)}`;
    els.addressCount.textContent = `地址：${snap.entity?.addresses?.length || 0}`;
    els.updated.textContent = `链上更新：${formatTime(payload.generatedAt)}`;

    const actions = Array.isArray(snap.significantActions) ? snap.significantActions : [];
    els.tableBody.innerHTML = '';
    if (!actions.length) {
      els.empty.classList.remove('hidden');
      els.empty.textContent = '近 7 天当前地址没有 ≥$1M 或 ≥500 ETH 的显著动作。';
    } else {
      els.empty.classList.add('hidden');
      for (const action of actions) {
        const tr = document.createElement('tr');
        const actionView = actionMeta(action);
        const protocols = (action.protocolHints || []).join('、') || '—';
        const assets = (action.assets || []).join(' / ') || '—';
        tr.innerHTML = `
          <td>${formatTime(action.timestamp)}</td>
          <td><span class="status-pill ${actionView.className}">${actionView.label}</span><small>${action.confidence || 'LOW'} confidence</small></td>
          <td>${fmtEth(action.ethNet)}<small>${compactUsd(action.ethNetUsd)}</small></td>
          <td>${compactUsd(action.stableNetUsd)}</td>
          <td>${assets}</td>
          <td>${protocols}</td>
          <td><a class="action-btn" href="https://etherscan.io/tx/${encodeURIComponent(action.hash)}" target="_blank" rel="noreferrer">Etherscan</a></td>
        `;
        els.tableBody.appendChild(tr);
      }
    }
    setStatus('Etherscan V2 正常', 'success');
  }

  async function load() {
    els.refresh.disabled = true;
    setStatus('正在读取链上数据…');
    try {
      const response = await fetch(API, { cache: 'no-store', headers: { Accept: 'application/json' } });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.message || `HTTP ${response.status}`);
      render(payload);
    } catch (error) {
      setStatus('链上数据暂不可用', 'error');
      els.state.textContent = 'DATA UNAVAILABLE';
      els.state.className = 'whale-state whale-negative';
      els.stateReason.textContent = error.message || '读取失败';
    } finally {
      els.refresh.disabled = false;
    }
  }

  els.refresh.addEventListener('click', load);
  load();
})();
