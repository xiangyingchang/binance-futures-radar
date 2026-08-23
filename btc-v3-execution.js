'use strict';

(() => {
  const accounting = window.BtcV3ExecutionAccounting;
  const $ = (id) => document.getElementById(id);
  if (!accounting) return;

  let snapshot = null;
  let records = [];
  let ledgerError = null;
  let pendingExecutionId = null;

  function number(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function formatTime(value) {
    if (!value) return '--';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '--';
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(date);
  }

  function formatX(value) {
    const parsed = number(value);
    return parsed === null ? '--' : parsed.toFixed(2) + 'x';
  }

  function formatBtc(value) {
    const parsed = number(value);
    return parsed === null ? '--' : (parsed >= 0 ? '+' : '') + parsed.toFixed(4) + ' BTC';
  }

  function formatContracts(value) {
    const parsed = number(value);
    return parsed === null ? '--' : (parsed > 0 ? '+' : '') + parsed + ' 张';
  }

  function formatPrice(value) {
    const parsed = number(value);
    return parsed === null || parsed <= 0 ? '--' : '$' + parsed.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatPercent(value) {
    const parsed = number(value);
    return parsed === null ? '--' : parsed.toFixed(1) + '%';
  }

  function formatPnl(pnl) {
    if (!pnl || pnl.btc === null || pnl.usd === null) return '--';
    const btc = Number(pnl.btc);
    const usd = Number(pnl.usd);
    return (btc >= 0 ? '+' : '') + btc.toFixed(4) + ' BTC / ' + (usd >= 0 ? '+' : '') + '$' + usd.toFixed(2);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;',
    }[character]));
  }

  function context() {
    const equityBtc = number($('btc-holdings')?.value);
    return {
      equityBtc,
      contractSizeUsd: number(snapshot?.instrument?.contractSize) || 100,
      markPrice: number(snapshot?.funding?.markPrice),
      targetExposure: number(snapshot?.signal?.finalTarget),
    };
  }

  function setText(id, value) {
    const node = $(id);
    if (node) node.textContent = value;
  }

  function renderHistory(equityBtc, contractSizeUsd) {
    const body = $('execution-history-body');
    if (!body) return;
    if (!records.length) {
      body.innerHTML = '<tr><td colspan="7">暂无实际交易记录。</td></tr>';
      return;
    }

    const history = accounting.buildExecutionHistory(records, { equityBtc, contractSizeUsd }).reverse();
    body.innerHTML = history.map((entry) => {
      const time = entry.executedAt
        ? formatTime(entry.executedAt) + (entry.executionTimePrecision === 'approximate' ? '（约）' : '')
        : '未提供 · 记录 ' + formatTime(entry.recordedAt);
      const target = formatX(entry.targetExposureAtExecution);
      const actual = formatX(entry.actualExposure);
      return '<tr>'
        + '<td>' + escapeHtml(time) + '</td>'
        + '<td data-side="' + escapeHtml(entry.side) + '">' + escapeHtml(entry.side) + '</td>'
        + '<td>' + escapeHtml(String(entry.contracts)) + '</td>'
        + '<td>' + escapeHtml(formatPrice(entry.avgFillPrice)) + '</td>'
        + '<td>' + escapeHtml(target) + '</td>'
        + '<td>' + escapeHtml(actual) + '</td>'
        + '<td>' + escapeHtml(entry.note || '--') + '</td>'
        + '</tr>';
    }).join('');
  }

  function render() {
    const state = accounting.calculateLedgerState(records);
    const current = context();
    const metrics = accounting.calculatePositionMetrics(state.position, current);
    const targetExposure = current.targetExposure;

    setText('execution-ledger-status', ledgerError
      ? 'Execution Ledger 读取失败：' + ledgerError
      : snapshot
        ? 'Execution Ledger 已读取 ' + records.length + ' 条 · Strategy Target 与 Actual Position 独立计算'
        : 'Execution Ledger 已读取 ' + records.length + ' 条 · 等待 V3 Strategy Snapshot');
    setText('execution-equity-note', current.equityBtc !== null && current.equityBtc > 0
      ? 'Actual Exposure 基于当前 V3 BTC 数量 ' + current.equityBtc.toFixed(4) + ' BTC 和 COIN-M futures delta；不会读取 Binance 账户。'
      : '请先填写有效的当前 V3 BTC 数量，才能计算 Actual Exposure。');
    setText('execution-target-exposure', formatX(targetExposure));
    setText('execution-actual-exposure', formatX(metrics.actualExposure));
    setText('execution-actual-contracts', formatContracts(metrics.actualContracts));
    setText('execution-target-contracts', formatContracts(metrics.targetContracts));
    setText('execution-remaining-contracts', formatContracts(metrics.remainingContracts));
    setText('execution-actual-overlay', formatBtc(metrics.actualOverlayBtc));
    setText('execution-average-entry', formatPrice(metrics.averageEntryPrice));
    setText('execution-tracking-error', metrics.trackingError === null ? '--' : (metrics.trackingError >= 0 ? '+' : '') + metrics.trackingError.toFixed(4) + 'x');
    setText('execution-pnl', formatPnl(metrics.unrealizedPnl));
    setText('execution-funding', '--');

    const progress = $('execution-progress');
    const progressValue = metrics.completionPercent === null ? 0 : metrics.completionPercent;
    if (progress) {
      progress.style.setProperty('--execution-progress', progressValue + '%');
      progress.setAttribute('aria-valuenow', progressValue.toFixed(1));
    }
    setText('execution-completion', metrics.completionPercent === null ? '--' : formatPercent(metrics.completionPercent));
    renderHistory(current.equityBtc, current.contractSizeUsd);
  }

  async function loadLedger() {
    try {
      const response = await fetch('/api/btc-v3-execution', { cache: 'no-store', headers: { Accept: 'application/json' } });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || payload.error || ('HTTP ' + response.status));
      records = (Array.isArray(payload.records) ? payload.records : []).map((record) => accounting.normalizeRecord(record));
      ledgerError = null;
      render();
      return true;
    } catch (error) {
      ledgerError = error.message || 'Execution Ledger unavailable';
      render();
      return false;
    }
  }

  function makeExecutionId() {
    if (window.crypto?.randomUUID) return 'exec_' + window.crypto.randomUUID();
    return 'exec_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
  }

  async function submitExecution(event) {
    event.preventDefault();
    const key = String($('execution-api-key')?.value || '').trim();
    const targetExposure = number(snapshot?.signal?.finalTarget);
    const contracts = number($('execution-contracts')?.value);
    const avgFillPrice = number($('execution-fill-price')?.value);
    if (!key) return setText('execution-form-status', '请输入写入密钥。');
    if (targetExposure === null) return setText('execution-form-status', 'V3 Strategy Target 尚未加载，暂不能记录。');
    if (!Number.isInteger(contracts) || contracts <= 0) return setText('execution-form-status', 'Contracts 必须是正整数。');
    if (avgFillPrice === null || avgFillPrice <= 0) return setText('execution-form-status', 'Average Fill Price 必须为正数。');

    if (!pendingExecutionId) pendingExecutionId = makeExecutionId();
    const executedAtInput = String($('execution-time')?.value || '').trim();
    let executedAt = null;
    if (executedAtInput) {
      const parsedExecutionTime = new Date(executedAtInput);
      if (Number.isNaN(parsedExecutionTime.getTime())) {
        return setText('execution-form-status', 'Execution Time 无法解析，请留空或重新输入。');
      }
      executedAt = parsedExecutionTime.toISOString();
    }
    const payload = {
      executionId: pendingExecutionId,
      side: $('execution-side')?.value,
      contracts,
      avgFillPrice,
      executedAt,
      executionTimePrecision: 'approximate',
      targetExposureAtExecution: targetExposure,
      note: String($('execution-note')?.value || '').trim(),
    };
    const submit = $('execution-submit');
    if (submit) submit.disabled = true;
    setText('execution-form-status', '正在追加 Execution Ledger…');

    try {
      const response = await fetch('/api/btc-v3-execution', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + key,
          'Idempotency-Key': pendingExecutionId,
        },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || result.error || ('HTTP ' + response.status));
      const submittedExecutionId = pendingExecutionId;
      const loaded = await loadLedger();
      const confirmed = loaded && records.some((record) => record.executionId === submittedExecutionId);
      if (confirmed) {
        pendingExecutionId = null;
        $('execution-form')?.reset();
        setText('execution-form-status', result.duplicate ? '幂等重复提交：历史记录已存在，未追加新行。' : '已追加到 Execution Ledger。');
      } else {
        setText('execution-form-status', 'API 已接受写入，但历史刷新未确认；请重试，当前 executionId 会保持不变。');
      }
    } catch (error) {
      setText('execution-form-status', '写入失败：' + (error.message || error) + '；可重试，当前 executionId 会保持不变。');
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  window.addEventListener('btc-v3:snapshot', (event) => {
    snapshot = event.detail || null;
    render();
  });
  $('execution-form')?.addEventListener('submit', submitExecution);
  for (const id of ['btc-holdings', 'current-contracts']) {
    $(id)?.addEventListener('input', render);
  }
  loadLedger();
})();
