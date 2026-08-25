'use strict';

(() => {
  const accounting = window.BtcV3ExecutionAccounting;
  const keyStorage = window.BtcV3TrackingKeyStorage;
  const $ = (id) => document.getElementById(id);
  if (!accounting) return;

  let snapshot = null;
  let executionRecords = [];
  let capitalFlowRecords = [];
  let accountSnapshotRecords = [];
  let executionError = null;
  let trackingError = null;
  let trackingGateOpen = false;
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

  function formatReconciliationStatus(value) {
    return ({
      MATCH: '一致',
      MISMATCH: '不一致',
      EQUITY_DELTA: '权益有变化',
      NO_SNAPSHOT: '暂无快照',
    }[value] || value || '--');
  }

  function formatEquityStatus(status) {
    return ({
      OBSERVED: '已核验（OBSERVED）',
      ESTIMATED: '估算（ESTIMATED）',
      UNAVAILABLE: '不可用（UNAVAILABLE）',
    }[status] || status || '--');
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

  function restoreWriteKey() {
    const input = $('tracking-api-key');
    if (!input) return;
    if (!keyStorage) return;
    const saved = keyStorage.get(window);
    if (saved) {
      input.value = saved;
      setText('tracking-key-note', '本机已缓存密钥（24 小时未操作会自动清除）。');
    }
  }

  function trackingGateNode() {
    return $('tracking-access-gate');
  }

  function setTrackingGate(open, note) {
    trackingGateOpen = open;
    const gate = trackingGateNode();
    if (gate) gate.hidden = !open;
    if (note) setText('tracking-gate-note', note);
    const keyInput = $('tracking-gate-key');
    if (open && keyInput) keyInput.focus();
  }

  function rememberWriteKey(value) {
    if (!value) return;
    if (!keyStorage) return;
    keyStorage.put(window, value);
  }

  function touchWriteKey() {
    if (!keyStorage) return;
    keyStorage.touch(window);
  }

  function forgetWriteKey() {
    if (!keyStorage) return;
    keyStorage.remove(window);
  }

  function clearWriteKey() {
    forgetWriteKey();
    const input = $('tracking-api-key');
    if (input) input.value = '';
    executionRecords = [];
    capitalFlowRecords = [];
    accountSnapshotRecords = [];
    executionError = '尚未输入 V3 私人追踪数据访问密钥';
    trackingError = '尚未输入 V3 私人追踪数据访问密钥';
    render();
    publishTracking();
    setText('tracking-key-note', '本机缓存的密钥已清除；下次进入前需要重新输入。');
    setTrackingGate(true, '本机缓存的密钥已清除。输入访问密钥后重新读取私人追踪数据。');
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
      action.textContent = '等待';
      action.dataset.action = 'wait';
      detail.textContent = '等待策略目标、策略权益、实际合约张数和标记价格完整。';
      return;
    }
    const delta = state.remainingContracts;
    if (delta > 0) {
      action.textContent = `买入 ${delta} 张`;
      action.dataset.action = 'buy';
    } else if (delta < 0) {
      action.textContent = `卖出 ${Math.abs(delta)} 张`;
      action.dataset.action = 'sell';
    } else {
      action.textContent = '无需调整';
      action.dataset.action = 'hold';
    }
    detail.textContent = `目标 ${formatContracts(state.targetContracts)} · 实际 ${formatContracts(state.currentActualContracts)} · 遵循 V3.1 每日再平衡，不包含额外无交易区间。`;
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
      const side = entry.side === 'BUY' ? '买入' : entry.side === 'SELL' ? '卖出' : entry.side;
      return '<tr>'
        + '<td>' + escapeHtml(time) + '</td>'
        + '<td data-side="' + escapeHtml(entry.side) + '">' + escapeHtml(side) + '</td>'
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
      const type = entry.flowType === 'INITIAL_CAPITAL' ? '初始本金' : entry.flowType === 'CONTRIBUTION' ? '追加投入' : entry.flowType === 'WITHDRAWAL' ? '提取本金' : '调整';
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
      body.innerHTML = '<tr><td colspan="6">暂无账户快照。</td></tr>';
      return;
    }
    const latestId = tracking.latestSnapshot?.snapshotId;
    body.innerHTML = accountSnapshotRecords.slice().reverse().map((entry) => {
      const time = entry.capturedAt
        ? formatTime(entry.capturedAt) + (entry.captureTimePrecision === 'approximate' ? '（约）' : '')
        : '未提供 · 记录 ' + formatTime(entry.recordedAt);
      const reconcile = entry.snapshotId === latestId ? formatReconciliationStatus(tracking.reconciliation.status) : '历史记录';
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
    const positionSource = tracking.actualPositionSource === 'account_snapshot'
      ? '账户快照'
      : tracking.actualPositionSource === 'account_snapshot_plus_execution_ledger'
        ? '账户快照 + 快照后执行账本'
        : '执行账本推导';
    const executionStatus = executionError ? '执行账本读取失败：' + executionError : '执行账本已读取 ' + executionRecords.length + ' 条';
    const trackingStatus = trackingError ? ' · 追踪账本读取失败：' + trackingError : ' · 资金流 ' + capitalFlowRecords.length + ' 条 · 账户快照 ' + accountSnapshotRecords.length + ' 条';

    setText('tracking-ledger-status', executionStatus + trackingStatus);
    const equityLabel = tracking.equityStatus === 'OBSERVED' ? '已核验观察值' : tracking.equityStatus === 'ESTIMATED' ? '估算值' : '不可用';
    setText('tracking-equity-note', `策略权益来源：${equityLabel}。它只代表分配给 V3 的 BTC，不代表用户全部 BTC；资金流不计入策略盈亏。`);
    setText('tracking-current-equity', tracking.currentStrategyEquityBtc === null ? '--' : tracking.currentStrategyEquityBtc.toFixed(4) + ' BTC');
    setText('tracking-equity-source', equityLabel);
    setText('tracking-equity-status', formatEquityStatus(tracking.equityStatus));
    setText('tracking-current-mark', formatPrice(currentMark));
    setText('tracking-actual-source', positionSource);
    const latestSnapshotTime = tracking.latestSnapshot
      ? (tracking.latestSnapshot.capturedAt || tracking.latestSnapshot.recordedAt)
      : null;
    setText('tracking-last-snapshot', latestSnapshotTime ? '最近账户快照：' + formatTime(latestSnapshotTime) : '最近账户快照：暂无');
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
    setText('tracking-last-observed-equity', tracking.lastObservedEquityBtc === null ? '--' : tracking.lastObservedEquityBtc.toFixed(4) + ' BTC');
    setText('tracking-capital-adjusted-equity', tracking.capitalAdjustedEquityBtc === null ? '--' : tracking.capitalAdjustedEquityBtc.toFixed(4) + ' BTC');
    setText('tracking-estimated-equity', tracking.estimatedCurrentEquityBtc === null ? '--' : tracking.estimatedCurrentEquityBtc.toFixed(4) + ' BTC');
    setText('tracking-strategy-pnl', formatBtc(tracking.strategyPnlBtc, 4));
    setText('tracking-strategy-pnl-note', tracking.currentStrategyEquityBtc === null
      ? '等待当前策略权益快照'
      : '估算：当前/估算权益 − 净投入本金。可能包含已实现期货盈亏、未实现盈亏、资金费、手续费和对账差异；不是精确收益。');
    setText('tracking-reconcile', formatReconciliationStatus(tracking.reconciliation.status));
    setText('tracking-reconcile-note', tracking.reconciliation.message);
    setText('execution-ledger-status', executionStatus + trackingStatus);
    renderDailyAction(tracking);

    const progress = $('execution-progress');
    if (progress) {
      const hasCompletion = tracking.completionPercent !== null;
      const progressValue = hasCompletion ? tracking.completionPercent : 0;
      progress.style.setProperty('--execution-progress', progressValue + '%');
      progress.setAttribute('aria-valuenow', progressValue.toFixed(1));
      progress.setAttribute('aria-valuetext', hasCompletion
        ? formatPercent(tracking.completionPercent)
        : '完成率不适用；请查看剩余合约和追踪误差');
    }
    setText('execution-completion', tracking.completionPercent === null
      ? `完成率不适用 · 误差 ${tracking.trackingError === null ? '--' : tracking.trackingError.toFixed(4) + 'x'}`
      : formatPercent(tracking.completionPercent));
    renderExecutionHistory(tracking.currentStrategyEquityBtc, current.contractSizeUsd);
    renderCapitalHistory(tracking);
    renderSnapshotHistory(tracking);
    window.BtcV3AccountTracking = tracking;
  }

  async function loadTracking() {
    try {
      const key = writeKey();
      if (!key) {
        trackingError = '尚未输入 V3 私人追踪数据访问密钥';
        setTrackingGate(true);
        render();
        return { ok: false, tracking: window.BtcV3AccountTracking || null };
      }
      const response = await fetch('/api/btc-v3-tracking', { cache: 'no-store', headers: { Accept: 'application/json', Authorization: 'Bearer ' + key } });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || payload.error || ('HTTP ' + response.status));
      executionRecords = (Array.isArray(payload.executionRecords) ? payload.executionRecords : []).map((record) => accounting.normalizeRecord(record));
      capitalFlowRecords = (Array.isArray(payload.capitalFlowRecords) ? payload.capitalFlowRecords : []).map((record) => accounting.normalizeCapitalFlow(record));
      accountSnapshotRecords = (Array.isArray(payload.accountSnapshotRecords) ? payload.accountSnapshotRecords : []).map((record) => accounting.normalizeAccountSnapshot(record));
      rememberWriteKey(key);
      touchWriteKey();
      executionError = null;
      trackingError = null;
      setTrackingGate(false);
      const tracking = publishTracking();
      render();
      return { ok: true, tracking };
    } catch (error) {
      trackingError = error.message || 'V3 tracking unavailable';
      if (/401|unauthorized|access key|authorization/i.test(trackingError)) {
        forgetWriteKey();
        executionRecords = [];
        capitalFlowRecords = [];
        accountSnapshotRecords = [];
        setTrackingGate(true, '访问密钥不正确或已失效，请重新输入。');
      }
      render();
      return { ok: false, tracking: window.BtcV3AccountTracking || null };
    }
  }

  function makeId(prefix) {
    if (window.crypto?.randomUUID) return prefix + '_' + window.crypto.randomUUID();
    return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
  }

  function writeKey() {
    const inputValue = String($('tracking-api-key')?.value || $('execution-api-key')?.value || '').trim();
    if (inputValue) return inputValue;
    if (!keyStorage) return '';
    return keyStorage.get(window);
  }

  async function loadExecutionLedger() {
    try {
      const key = writeKey();
      if (!key) {
        executionError = '尚未输入 V3 私人追踪数据访问密钥';
        render();
        return;
      }
      const response = await fetch('/api/btc-v3-execution', { cache: 'no-store', headers: { Accept: 'application/json', Authorization: 'Bearer ' + key } });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || payload.error || ('HTTP ' + response.status));
      executionRecords = (Array.isArray(payload.records) ? payload.records : []).map((record) => accounting.normalizeRecord(record));
      rememberWriteKey(key);
      touchWriteKey();
      executionError = null;
      render();
    } catch (error) {
      executionError = error.message || 'Execution ledger unavailable';
      if (/401|unauthorized|access key|authorization/i.test(executionError)) {
        forgetWriteKey();
        executionRecords = [];
      }
      render();
    }
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
      rememberWriteKey(key);
      touchWriteKey();
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
    if (targetExposure === null) return setText('execution-form-status', 'V3 策略目标尚未加载，暂不能记录。');
    if (!Number.isInteger(contracts) || contracts <= 0) return setText('execution-form-status', '合约张数必须是正整数。');
    if (avgFillPrice === null || avgFillPrice <= 0) return setText('execution-form-status', '平均成交价必须为正数。');
    if (!pendingExecutionId) pendingExecutionId = makeId('exec');
    const executionTime = parseOptionalTime('execution-time', '成交时间');
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
    setText('execution-form-status', '正在追加执行账本…');
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
      rememberWriteKey(key);
      touchWriteKey();
      const submittedId = pendingExecutionId;
      const loaded = await loadTracking();
      const confirmed = loaded.ok && executionRecords.some((record) => record.executionId === submittedId);
      if (!confirmed) {
        setText('execution-form-status', 'API 已接受写入，但刷新未确认；请重试，当前 executionId 会保持不变。');
        return;
      }
      pendingExecutionId = null;
      $('execution-form')?.reset();
      setText('execution-form-status', result.duplicate ? '幂等重复提交：历史记录已存在，未追加新行。' : '已追加到执行账本。');
    } catch (error) {
      setText('execution-form-status', '写入失败：' + (error.message || error) + '；可重试，当前 executionId 会保持不变。');
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  async function submitCapitalFlow(event) {
    event.preventDefault();
    const amount = number($('capital-flow-amount')?.value);
    if (amount === null || amount <= 0) return setText('capital-flow-form-status', 'BTC 数量必须为正数。');
    const flowTime = parseOptionalTime('capital-flow-time', '生效时间');
    if (flowTime.error) return setText('capital-flow-form-status', flowTime.error);
    const reason = String($('capital-flow-reason')?.value || '').trim();
    if (!reason) return setText('capital-flow-form-status', '原因不能为空。');
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
    let markPrice = number($('account-snapshot-mark')?.value);
    const liveMark = number(snapshot?.funding?.markPrice);
    let markSourceNote = '';
    if (markPrice === null && liveMark !== null && liveMark > 0) {
      markPrice = liveMark;
      markSourceNote = 'public mark price at snapshot capture; not a Binance private-account value';
      setText('account-snapshot-form-status', '未手填标记价格，将默认写入当前公开 V3 mark price（不是 Binance 私有账户返回值）。正在提交…');
    }
    if (strategyEquityBtc === null || strategyEquityBtc < 0) return setText('account-snapshot-form-status', '策略权益 BTC 必须为 0 或正数。');
    if (!Number.isInteger(actualContracts)) return setText('account-snapshot-form-status', '实际合约张数必须是整数。');
    if (markPrice !== null && markPrice <= 0) return setText('account-snapshot-form-status', '标记价格必须为正数或留空。');
    const capturedTime = parseOptionalTime('account-snapshot-time', '采集时间');
    if (capturedTime.error) return setText('account-snapshot-form-status', capturedTime.error);
    if (!pendingSnapshotId) pendingSnapshotId = makeId('snapshot');
    const confirmed = await postTrackingRecord('account-snapshot', pendingSnapshotId, {
      snapshotId: pendingSnapshotId,
      capturedAt: capturedTime.value,
      captureTimePrecision: 'approximate',
      strategyEquityBtc,
      actualContracts,
      markPrice,
      note: [String($('account-snapshot-note')?.value || '').trim(), markSourceNote].filter(Boolean).join(' · '),
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
  $('clear-tracking-key')?.addEventListener('click', clearWriteKey);
  $('tracking-gate-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const key = String($('tracking-gate-key')?.value || '').trim();
    if (!key) return;
    const submit = $('tracking-gate-submit');
    if (submit) submit.disabled = true;
    setText('tracking-gate-note', '正在验证访问密钥…');
    const keyInput = $('tracking-api-key');
    if (keyInput) keyInput.value = key;
    const result = await loadTracking();
    if (result.ok) {
      await loadExecutionLedger();
    } else if (!/401|unauthorized|access key|authorization/i.test(trackingError || '')) {
      setTrackingGate(true, '私人追踪数据暂不可用：' + (trackingError || '请稍后重试。'));
    }
    if (submit) submit.disabled = false;
  });
  $('tracking-gate-skip')?.addEventListener('click', () => {
    setTrackingGate(false, '已选择只看策略信号。私人追踪数据保持锁定；需要时点击“清除本页密钥”重新进入。');
    trackingError = '私人追踪数据已锁定（只看策略信号模式）';
    render();
  });
  for (const id of ['btc-holdings', 'current-contracts']) $(id)?.addEventListener('input', render);
  restoreWriteKey();
  const restoredKey = keyStorage ? keyStorage.get(window) : '';
  if (restoredKey) {
    setText('tracking-key-note', '本机已缓存密钥（24 小时未操作会自动清除）。');
    loadTracking().then(() => loadExecutionLedger());
  }
  $('tracking-api-key')?.addEventListener('change', () => loadTracking().then(() => loadExecutionLedger()));
})();
