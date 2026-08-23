'use strict';

(() => {
  const accounting = window.BtcV3ExecutionAccounting;
  const $ = (id) => document.getElementById(id);
  if (!accounting) return;

  let snapshot = null;
  let executionRecords = [];
  let capitalFlowRecords = [];
  let accountSnapshotRecords = [];
  let executionError = null;
  let trackingError = null;
  let pendingExecutionId = null;
  let pendingFlowId = null;
  let pendingSnapshotId = null;

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
    return parsed === null ? '--' : parsed.toFixed(3) + 'x';
  }

  function formatBtc(value, decimals = 4) {
    const parsed = number(value);
    return parsed === null ? '--' : (parsed >= 0 ? '+' : '') + parsed.toFixed(decimals) + ' BTC';
  }

  function formatAmount(value, decimals = 4) {
    const parsed = number(value);
    return parsed === null ? '--' : (parsed >= 0 ? '+' : '') + parsed.toFixed(decimals) + ' BTC';
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
    return String(value ?? '').replace(/[&<>'\"]/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;',
    }[character]));
  }

  function setText(id, value) {
    const node = $(id);
    if (node) node.textContent = value;
  }

  function context() {
    const tracked = window.BtcV3AccountTracking || null;
    const equityBtc = number(tracked?.currentStrategyEquityBtc) ?? number($('btc-holdings')?.value);
    const currentContracts = number(tracked?.currentActualContracts) ?? number($('current-contracts')?.value);
    return {
      equityBtc,
      currentContracts,
      contractSizeUsd: number(snapshot?.instrument?.contractSize) || 100,
      markPrice: number(snapshot?.funding?.markPrice),
      targetExposure: number(snapshot?.signal?.finalTarget),
    };
  }

  function calculateState() {
    const current = context();
    return {
      current,
      tracking: accounting.calculateTrackingState({
        executionRecords,
        capitalFlowRecords,
        accountSnapshotRecords,
        markPrice: current.markPrice,
        targetExposure: current.targetExposure,
        contractSizeUsd: current.contractSizeUsd,
      }),
    };
  }

  function publishTracking() {
    const state = calculateState().tracking;
    window.BtcV3AccountTracking = state;
    window.dispatchEvent(new CustomEvent('btc-v3:account-tracking', { detail: state }));
    return state;
  }

  function renderDailyAction(state) {
    const action = $('tracking-action');
    const detail = $('tracking-action-detail');
    if (!action || !detail) return;
    if (state.targetContracts === null || state.currentActualContracts === null) {
      action.textContent = 'WAIT';
      action.dataset.action = 'wait';
      detail.textContent = '等待 Target、Strategy Equity、Actual Contracts 和 Mark Price 完整。';
      return;
    }
    const delta = state.remainingContracts;
    if (delta > 0) {
      action.textContent = `BUY ${delta} contracts`;
      action.dataset.action = 'buy';
    } else if (delta < 0) {
      action.textContent = `SELL ${Math.abs(delta)} contracts`;
      action.dataset.action = 'sell';
    } else {
      action.textContent = 'NO ACTION';
      action.dataset.action = 'hold';
    }
    detail.textContent = `Target ${formatContracts(state.targetContracts)} · Actual ${formatContracts(state.currentActualContracts)} · 遵循 V3.1 daily rebalance，不含额外 no-trade band。`;
  }

  function renderExecutionHistory(equityBtc, contractSizeUsd) {
    const body = $('execution-history-body');
    if (!body) return;
    if (!executionRecords.length) {
      body.innerHTML = '<tr><td colspan="8">暂无实际交易记录。</td></tr>';
      return;
    }

    const history = accounting.buildExecutionHistory(executionRecords, { equityBtc, contractSizeUsd }).reverse();
    body.innerHTML = history.map((entry) => {
      const time = entry.executedAt
        ? formatTime(entry.executedAt) + (entry.executionTimePrecision === 'approximate' ? '（约）' : '')
        : '未提供 · 记录 ' + formatTime(entry.recordedAt);
      return '<tr>'
        + '<td>' + escapeHtml(time) + '</td>'
        + '<td data-side="' + escapeHtml(entry.side) + '">' + escapeHtml(entry.side) + '</td>'
        + '<td>' + escapeHtml(String(entry.contracts)) + '</td>'
        + '<td>' + escapeHtml(formatPrice(entry.avgFillPrice)) + '</td>'
        + '<td>' + escapeHtml(formatX(entry.targetExposureAtExecution)) + '</td>'
        + '<td>' + escapeHtml(formatContracts(entry.actualContracts)) + '</td>'
        + '<td>' + escapeHtml(formatX(entry.actualExposure)) + '</td>'
        + '<td>' + escapeHtml(entry.note || '--') + '</td>'
        + '</tr>';
    }).join('');
  }

  function renderCapitalHistory(capitalState) {
    const body = $('capital-flow-history-body');
    if (!body) return;
    if (!capitalFlowRecords.length) {
      body.innerHTML = '<tr><td colspan="6">暂无资金流记录。</td></tr>';
      return;
    }
    body.innerHTML = capitalState.timeline.slice().reverse().map((entry) => {
      const time = entry.effectiveAt
        ? formatTime(entry.effectiveAt) + (entry.effectiveTimePrecision === 'approximate' ? '（约）' : '')
        : '未提供 · 记录 ' + formatTime(entry.recordedAt);
      const type = entry.flowType === 'INITIAL_CAPITAL' ? 'Initial Capital' : entry.flowType === 'CONTRIBUTION' ? 'Contribution' : entry.flowType === 'WITHDRAWAL' ? 'Withdrawal' : 'Adjustment';
      return '<tr>'
        + '<td>' + escapeHtml(time) + '</td>'
        + '<td>' + escapeHtml(type) + '</td>'
        + '<td>' + escapeHtml(formatAmount(entry.signedAmountBtc)) + '</td>'
        + '<td>' + escapeHtml(entry.cumulativeNetCapitalBtc.toFixed(4) + ' BTC') + '</td>'
        + '<td>' + escapeHtml(entry.reason || '--') + '</td>'
        + '<td>' + escapeHtml(entry.note || '--') + '</td>'
        + '</tr>';
    }).join('');
  }

  function renderSnapshotHistory(tracking) {
    const body = $('snapshot-history-body');
    if (!body) return;
    if (!accountSnapshotRecords.length) {
      body.innerHTML = '<tr><td colspan="6">暂无 Account Snapshot。</td></tr>';
      return;
    }
    const latestId = tracking.latestSnapshot?.snapshotId;
    body.innerHTML = accountSnapshotRecords.slice().reverse().map((entry) => {
      const time = entry.capturedAt
        ? formatTime(entry.capturedAt) + (entry.captureTimePrecision === 'approximate' ? '（约）' : '')
        : '未提供 · 记录 ' + formatTime(entry.recordedAt);
      const reconcile = entry.snapshotId === latestId ? tracking.reconciliation.status : 'HISTORICAL';
      return '<tr>'
        + '<td>' + escapeHtml(time) + '</td>'
        + '<td>' + escapeHtml(entry.strategyEquityBtc.toFixed(4) + ' BTC') + '</td>'
        + '<td>' + escapeHtml(formatContracts(entry.actualContracts)) + '</td>'
        + '<td>' + escapeHtml(formatPrice(entry.markPrice)) + '</td>'
        + '<td>' + escapeHtml(reconcile) + '</td>'
        + '<td>' + escapeHtml(entry.note || '--') + '</td>'
        + '</tr>';
    }).join('');
  }

  function render() {
    const { current, tracking } = calculateState();
    const currentMark = tracking.currentMarkPrice ?? current.markPrice;
    const positionSource = tracking.actualPositionSource === 'account_snapshot' ? 'Account Snapshot' : 'Execution Ledger 推导';
    const equitySource = tracking.equitySource === 'account_snapshot' ? 'Account Snapshot（当前真实 Equity）' : 'Capital Flow basis（尚无 Equity Snapshot）';
    const executionStatus = executionError ? 'Execution Ledger 读取失败：' + executionError : 'Execution Ledger 已读取 ' + executionRecords.length + ' 条';
    const trackingStatus = trackingError ? ' · Tracking Ledger 读取失败：' + trackingError : ' · Capital Flow ' + capitalFlowRecords.length + ' 条 · Account Snapshot ' + accountSnapshotRecords.length + ' 条';

    setText('tracking-ledger-status', executionStatus + trackingStatus);
    setText('tracking-equity-note', `Strategy Equity 来源：${equitySource}。它只代表分配给 V3 的 BTC，不代表用户全部 BTC；Capital Flow 不计入 Strategy PnL。`);
    setText('tracking-current-equity', tracking.currentStrategyEquityBtc === null ? '--' : tracking.currentStrategyEquityBtc.toFixed(4) + ' BTC');
    setText('tracking-equity-source', equitySource);
    setText('tracking-current-mark', formatPrice(currentMark));
    setText('tracking-actual-source', positionSource);
    setText('execution-target-exposure', formatX(current.targetExposure));
    setText('execution-actual-exposure', formatX(tracking.actualExposure));
    setText('execution-actual-contracts', formatContracts(tracking.currentActualContracts));
    setText('execution-target-contracts', formatContracts(tracking.targetContracts));
    setText('execution-remaining-contracts', formatContracts(tracking.remainingContracts));
    setText('execution-actual-overlay', formatBtc(tracking.actualOverlayBtc));
    setText('execution-average-entry', formatPrice(tracking.averageEntryPrice));
    setText('execution-tracking-error', tracking.trackingError === null ? '--' : (tracking.trackingError >= 0 ? '+' : '') + tracking.trackingError.toFixed(4) + 'x');
    setText('execution-pnl', tracking.reconciliation.status === 'MISMATCH' ? '--' : formatPnl(tracking.unrealizedPnl));
    setText('execution-funding', '--');
    setText('tracking-net-capital', formatBtc(tracking.netCapitalBtc, 4));
    setText('tracking-starting-capital', formatBtc(tracking.startingCapitalBtc, 4));
    setText('tracking-contributions', formatBtc(tracking.additionalContributionsBtc, 4));
    setText('tracking-withdrawals', formatBtc(-tracking.withdrawalsBtc, 4));
    setText('tracking-strategy-pnl', formatBtc(tracking.strategyPnlBtc, 4));
    setText('tracking-strategy-pnl-note', tracking.currentStrategyEquityBtc === null
      ? '等待当前 Strategy Equity Snapshot'
      : 'Current Equity − Net Capital；以当前 Snapshot 为准，包含 mark-to-market 及未拆分的 Funding / Fee 影响。');
    setText('tracking-reconcile', tracking.reconciliation.status);
    setText('tracking-reconcile-note', tracking.reconciliation.message);
    setText('execution-ledger-status', executionStatus + trackingStatus);
    renderDailyAction(tracking);

    const progress = $('execution-progress');
    const progressValue = tracking.completionPercent === null ? 0 : tracking.completionPercent;
    if (progress) {
      progress.style.setProperty('--execution-progress', progressValue + '%');
      progress.setAttribute('aria-valuenow', progressValue.toFixed(1));
    }
    setText('execution-completion', tracking.completionPercent === null ? '--' : formatPercent(tracking.completionPercent));
    renderExecutionHistory(tracking.currentStrategyEquityBtc, current.contractSizeUsd);
    renderCapitalHistory(tracking);
    renderSnapshotHistory(tracking);
    window.BtcV3AccountTracking = tracking;
  }

  async function loadTracking() {
    try {
      const response = await fetch('/api/btc-v3-tracking', { cache: 'no-store', headers: { Accept: 'application/json' } });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || payload.error || ('HTTP ' + response.status));
      executionRecords = (Array.isArray(payload.executionRecords) ? payload.executionRecords : []).map((record) => accounting.normalizeRecord(record));
      capitalFlowRecords = (Array.isArray(payload.capitalFlowRecords) ? payload.capitalFlowRecords : []).map((record) => accounting.normalizeCapitalFlow(record));
      accountSnapshotRecords = (Array.isArray(payload.accountSnapshotRecords) ? payload.accountSnapshotRecords : []).map((record) => accounting.normalizeAccountSnapshot(record));
      executionError = null;
      trackingError = null;
      const tracking = publishTracking();
      render();
      return { ok: true, tracking };
    } catch (error) {
      trackingError = error.message || 'V3 tracking unavailable';
      render();
      return { ok: false, tracking: window.BtcV3AccountTracking || null };
    }
  }

  function makeId(prefix) {
    if (window.crypto?.randomUUID) return prefix + '_' + window.crypto.randomUUID();
    return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
  }

  function writeKey() {
    return String($('tracking-api-key')?.value || $('execution-api-key')?.value || '').trim();
  }

  function parseOptionalTime(id, label) {
    const value = String($(id)?.value || '').trim();
    if (!value) return { value: null, error: null };
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return { value: null, error: label + ' 无法解析，请留空或重新输入。' };
    return { value: date.toISOString(), error: null };
  }

  async function postTrackingRecord(ledgerType, id, payload, statusId, submitId) {
    const key = writeKey();
    if (!key) {
      setText(statusId, '请输入写入密钥。');
      return false;
    }
    const submit = $(submitId);
    if (submit) submit.disabled = true;
    setText(statusId, '正在追加独立账本…');
    try {
      const response = await fetch('/api/btc-v3-tracking', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + key,
          'Idempotency-Key': id,
        },
        body: JSON.stringify({ ledgerType, ...payload }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || result.error || ('HTTP ' + response.status));
      const loaded = await loadTracking();
      const confirmed = loaded.ok && (ledgerType === 'capital-flow'
        ? capitalFlowRecords.some((record) => record.flowId === id)
        : accountSnapshotRecords.some((record) => record.snapshotId === id));
      if (!confirmed) {
        setText(statusId, 'API 已接受写入，但刷新未确认；请重试，当前 ID 会保持不变。');
        return false;
      }
      setText(statusId, result.duplicate ? '幂等重复提交：历史记录已存在，未追加新行。' : '已追加到独立账本。');
      return true;
    } catch (error) {
      setText(statusId, '写入失败：' + (error.message || error) + '；可重试，当前 ID 会保持不变。');
      return false;
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  async function submitExecution(event) {
    event.preventDefault();
    const key = writeKey();
    const targetExposure = number(snapshot?.signal?.finalTarget);
    const contracts = number($('execution-contracts')?.value);
    const avgFillPrice = number($('execution-fill-price')?.value);
    if (!key) return setText('execution-form-status', '请输入写入密钥。');
    if (targetExposure === null) return setText('execution-form-status', 'V3 Strategy Target 尚未加载，暂不能记录。');
    if (!Number.isInteger(contracts) || contracts <= 0) return setText('execution-form-status', 'Contracts 必须是正整数。');
    if (avgFillPrice === null || avgFillPrice <= 0) return setText('execution-form-status', 'Average Fill Price 必须为正数。');
    if (!pendingExecutionId) pendingExecutionId = makeId('exec');
    const executionTime = parseOptionalTime('execution-time', 'Execution Time');
    if (executionTime.error) return setText('execution-form-status', executionTime.error);
    const payload = {
      executionId: pendingExecutionId,
      side: $('execution-side')?.value,
      contracts,
      avgFillPrice,
      executedAt: executionTime.value,
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
      const submittedId = pendingExecutionId;
      const loaded = await loadTracking();
      const confirmed = loaded.ok && executionRecords.some((record) => record.executionId === submittedId);
      if (!confirmed) {
        setText('execution-form-status', 'API 已接受写入，但刷新未确认；请重试，当前 executionId 会保持不变。');
        return;
      }
      pendingExecutionId = null;
      $('execution-form')?.reset();
      setText('execution-form-status', result.duplicate ? '幂等重复提交：历史记录已存在，未追加新行。' : '已追加到 Execution Ledger。');
    } catch (error) {
      setText('execution-form-status', '写入失败：' + (error.message || error) + '；可重试，当前 executionId 会保持不变。');
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  async function submitCapitalFlow(event) {
    event.preventDefault();
    const amount = number($('capital-flow-amount')?.value);
    if (amount === null || amount <= 0) return setText('capital-flow-form-status', 'BTC Amount 必须为正数。');
    const flowTime = parseOptionalTime('capital-flow-time', 'Effective Time');
    if (flowTime.error) return setText('capital-flow-form-status', flowTime.error);
    const reason = String($('capital-flow-reason')?.value || '').trim();
    if (!reason) return setText('capital-flow-form-status', 'Reason 不能为空。');
    if (!pendingFlowId) pendingFlowId = makeId('flow');
    const isWithdrawal = $('capital-flow-type')?.value === 'WITHDRAWAL';
    const confirmed = await postTrackingRecord('capital-flow', pendingFlowId, {
      flowId: pendingFlowId,
      flowType: isWithdrawal ? 'WITHDRAWAL' : 'CONTRIBUTION',
      asset: 'BTC',
      amount,
      direction: isWithdrawal ? 'OUT' : 'IN',
      effectiveAt: flowTime.value,
      effectiveTimePrecision: 'approximate',
      reason,
      note: String($('capital-flow-note')?.value || '').trim(),
    }, 'capital-flow-form-status', 'capital-flow-submit');
    if (confirmed) {
      pendingFlowId = null;
      $('capital-flow-form')?.reset();
    }
  }

  async function submitSnapshot(event) {
    event.preventDefault();
    const strategyEquityBtc = number($('account-snapshot-equity')?.value);
    const actualContracts = number($('account-snapshot-contracts')?.value);
    const markPrice = number($('account-snapshot-mark')?.value);
    if (strategyEquityBtc === null || strategyEquityBtc < 0) return setText('account-snapshot-form-status', 'Strategy Equity BTC 必须为 0 或正数。');
    if (!Number.isInteger(actualContracts)) return setText('account-snapshot-form-status', 'Actual Contracts 必须是整数。');
    if (markPrice !== null && markPrice <= 0) return setText('account-snapshot-form-status', 'Mark Price 必须为正数或留空。');
    const capturedTime = parseOptionalTime('account-snapshot-time', 'Captured At');
    if (capturedTime.error) return setText('account-snapshot-form-status', capturedTime.error);
    if (!pendingSnapshotId) pendingSnapshotId = makeId('snapshot');
    const confirmed = await postTrackingRecord('account-snapshot', pendingSnapshotId, {
      snapshotId: pendingSnapshotId,
      capturedAt: capturedTime.value,
      captureTimePrecision: 'approximate',
      strategyEquityBtc,
      actualContracts,
      markPrice,
      note: String($('account-snapshot-note')?.value || '').trim(),
    }, 'account-snapshot-form-status', 'account-snapshot-submit');
    if (confirmed) {
      pendingSnapshotId = null;
      $('account-snapshot-form')?.reset();
    }
  }

  window.addEventListener('btc-v3:snapshot', (event) => {
    snapshot = event.detail || null;
    render();
    publishTracking();
  });
  window.addEventListener('btc-v3:account-tracking', () => render());
  $('execution-form')?.addEventListener('submit', submitExecution);
  $('capital-flow-form')?.addEventListener('submit', submitCapitalFlow);
  $('account-snapshot-form')?.addEventListener('submit', submitSnapshot);
  for (const id of ['btc-holdings', 'current-contracts']) $(id)?.addEventListener('input', render);
  loadTracking();
})();
