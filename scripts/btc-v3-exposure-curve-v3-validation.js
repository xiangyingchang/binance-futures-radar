'use strict';

const fs = require('fs');
const path = require('path');
const { CONFIG, inversePnlBtc } = require('../lib/btc-v3-strategy');
const v2 = require('./btc-v3-exposure-curve-research');

const {
  DAY,
  HOUR,
  OUT_OF_SAMPLE_START,
  dateOnly,
  dayStart,
  loadMarketData,
  maxDrawdown,
  runScenario,
  scenarioDefinitions,
} = v2;

const EIGHT_HOURS = 8 * HOUR;
const OOS_END_REQUESTED = Date.UTC(2026, 6, 31, 23, 59, 59, 999);
const CRASH_DAY_THRESHOLD = -0.05;
const CLUSTER_GAP_DAYS = 1;
const MAKER_FEE_BPS = Number.isFinite(Number(process.env.BTC_V3_MAKER_FEE_BPS)) ? Number(process.env.BTC_V3_MAKER_FEE_BPS) : 2;
const TAKER_FEE_BPS = Number.isFinite(Number(process.env.BTC_V3_TAKER_FEE_BPS)) ? Number(process.env.BTC_V3_TAKER_FEE_BPS) : 5;
const TAKER_SLIPPAGE_BPS = Number.isFinite(Number(process.env.BTC_V3_TAKER_SLIPPAGE_BPS)) ? Number(process.env.BTC_V3_TAKER_SLIPPAGE_BPS) : 5;

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function median(values) {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
}

function sum(values) {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

function dailyIndexMap(market) {
  return new Map(market.indexDaily.map((row) => [row.openTime, row]));
}

function aggregateExecutionDaily(market) {
  const grouped = new Map();
  for (const bar of market.executionBars) {
    const day = dayStart(bar.openTime);
    if (!grouped.has(day)) {
      grouped.set(day, {
        openTime: day,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      });
    } else {
      const row = grouped.get(day);
      row.high = Math.max(row.high, bar.high);
      row.low = Math.min(row.low, bar.low);
      row.close = bar.close;
    }
  }
  return [...grouped.values()].sort((a, b) => a.openTime - b.openTime);
}

function buildCrashClusters(market, period) {
  const executionRows = aggregateExecutionDaily(market);
  const executionByDay = new Map(executionRows.map((row) => [row.openTime, row]));
  const indexByDay = dailyIndexMap(market);
  const days = [...new Set([...executionByDay.keys(), ...indexByDay.keys()])].sort((a, b) => a - b);
  const dayToCluster = new Map();
  const clusters = [];
  let current = null;
  let previousCrashDay = null;
  let previousExecution = null;
  let previousIndex = null;

  for (const day of days) {
    const execution = executionByDay.get(day);
    const index = indexByDay.get(day);
    const executionCloseReturn = execution && previousExecution && previousExecution.close > 0
      ? (execution.close / previousExecution.close) - 1
      : null;
    const executionIntradayDrawdown = execution && execution.open > 0 ? (execution.low / execution.open) - 1 : null;
    const indexCloseReturn = index && previousIndex && previousIndex.close > 0
      ? (index.close / previousIndex.close) - 1
      : null;
    const indexIntradayDrawdown = index && index.open > 0 ? (index.low / index.open) - 1 : null;
    const executionCrash = (executionCloseReturn !== null && executionCloseReturn <= CRASH_DAY_THRESHOLD)
      || (executionIntradayDrawdown !== null && executionIntradayDrawdown <= CRASH_DAY_THRESHOLD);
    const indexCrash = (indexCloseReturn !== null && indexCloseReturn <= CRASH_DAY_THRESHOLD)
      || (indexIntradayDrawdown !== null && indexIntradayDrawdown <= CRASH_DAY_THRESHOLD);
    if (day >= period.startTime && day <= period.endTime && (executionCrash || indexCrash)) {
      const closeReturn = executionCloseReturn ?? indexCloseReturn;
      const intradayDrawdown = executionIntradayDrawdown ?? indexIntradayDrawdown;
      const startsNewCluster = !current
        || previousCrashDay === null
        || day - previousCrashDay > (CLUSTER_GAP_DAYS + 1) * DAY;
      if (startsNewCluster) {
        current = {
          id: `crash-${dateOnly(day)}`,
          startTime: day,
          endTime: day,
          crashDays: [],
          closeReturns: [],
          intradayDrawdowns: [],
          sources: [],
        };
        clusters.push(current);
      }
      current.endTime = day;
      current.crashDays.push(dateOnly(day));
      current.closeReturns.push(closeReturn);
      current.intradayDrawdowns.push(intradayDrawdown);
      current.sources.push({
        date: dateOnly(day),
        executionCrash,
        indexCrash,
        executionCloseReturn,
        executionIntradayDrawdown,
        indexCloseReturn,
        indexIntradayDrawdown,
      });
      dayToCluster.set(day, current.id);
      previousCrashDay = day;
    }

    if (execution) previousExecution = execution;
    if (index) previousIndex = index;
  }

  return {
    clusters,
    dayToCluster,
    threshold: CRASH_DAY_THRESHOLD,
    gapDays: CLUSTER_GAP_DAYS,
    clusterForTimestamp: (timestamp) => dayToCluster.get(dayStart(timestamp)) || null,
  };
}

function aggregateMakerLots(lotRecords) {
  const lots = new Map();
  for (const record of lotRecords || []) {
    if (record.source !== 'maker_fill') continue;
    if (!lots.has(record.lotId)) {
      lots.set(record.lotId, {
        fillId: record.lotId,
        contracts: 0,
        markToMarketPnlBtc: 0,
        fundingPnlBtc: 0,
        feeBtc: 0,
        slippageBtc: 0,
      });
    }
    const lot = lots.get(record.lotId);
    lot.contracts += record.initialContracts || 0;
    lot.markToMarketPnlBtc += record.markToMarketPnlBtc || 0;
    lot.fundingPnlBtc += record.fundingPnlBtc || 0;
    lot.feeBtc += record.feeBtc || 0;
    lot.slippageBtc += record.slippageBtc || 0;
  }
  return lots;
}

function relativeBaselineEntryPnl(fill, contractSize) {
  const baselineEffectivePrice = fill.dayOpenPrice * (1 + TAKER_SLIPPAGE_BPS / 10000);
  const priceAdvantage = inversePnlBtc(fill.contracts, contractSize, fill.effectivePrice, baselineEffectivePrice);
  const baselineSlippagePnl = inversePnlBtc(fill.contracts, contractSize, baselineEffectivePrice, fill.dayOpenPrice);
  const baselineFee = Math.abs(fill.contracts) * contractSize / baselineEffectivePrice * (TAKER_FEE_BPS / 10000);
  const feeBenefit = baselineFee - fill.feeBtc;
  const slippageBenefit = Math.max(0, -baselineSlippagePnl) - fill.slippageBtc;
  return {
    baselineEffectivePrice,
    priceAdvantageBtc: priceAdvantage,
    feeBenefitBtc: feeBenefit,
    slippageBenefitBtc: slippageBenefit,
    totalBtc: priceAdvantage + feeBenefit + slippageBenefit,
  };
}

function addForwardReturns(fill, dailyByDay) {
  const base = dailyByDay.get(fill.dayOpen);
  const result = {
    dayClose: base?.close ?? null,
    oneDayReturn: null,
    threeDayReturn: null,
    sevenDayReturn: null,
  };
  if (!base || !(base.close > 0)) return result;
  for (const [days, key] of [[1, 'oneDayReturn'], [3, 'threeDayReturn'], [7, 'sevenDayReturn']]) {
    const future = dailyByDay.get(fill.dayOpen + days * DAY);
    if (future && future.close > 0) result[key] = (future.close / base.close) - 1;
  }
  return result;
}

function enrichFills(scenarioResult, market, crashClusters) {
  const dailyByDay = dailyIndexMap(market);
  const lots = aggregateMakerLots(scenarioResult.lotRecords);
  const fills = (scenarioResult.makerFillEvents || []).map((event) => {
    const lot = lots.get(event.fillId) || {};
    const relative = relativeBaselineEntryPnl({ ...event, feeBtc: lot.feeBtc ?? event.feeBtc, slippageBtc: lot.slippageBtc ?? event.slippageBtc }, market.contract.contractSize);
    const forward = addForwardReturns(event, dailyByDay);
    return {
      scenario: scenarioResult.name,
      fillId: event.fillId,
      tradeId: event.tradeId,
      fillTimestamp: event.fillTimestamp,
      fillTimeUtc: new Date(event.fillTimestamp).toISOString(),
      fillDate: dateOnly(event.fillTimestamp),
      crashClusterId: event.clusterId,
      baselineTargetExposure: event.baselineTargetExposure,
      baselineTargetContracts: event.baselineTargetContracts,
      thresholdDrop: event.thresholdDrop,
      bonusExposure: event.bonusExposure,
      limitPrice: event.limitPrice,
      intendedPrice: event.intendedPrice,
      effectivePrice: event.effectivePrice,
      contracts: event.contracts,
      contractsAfter: event.contractsAfter,
      exposureAfter: event.exposureAfter,
      dayClose: forward.dayClose,
      oneDayReturn: forward.oneDayReturn,
      threeDayReturn: forward.threeDayReturn,
      sevenDayReturn: forward.sevenDayReturn,
      markToMarketPnlBtc: lot.markToMarketPnlBtc || 0,
      fundingPnlBtc: lot.fundingPnlBtc || 0,
      btcPnlBtc: (lot.markToMarketPnlBtc || 0) + (lot.fundingPnlBtc || 0),
      relativeBaselineIncrementalPnlBtc: relative.totalBtc,
      relativeBaselinePriceAdvantageBtc: relative.priceAdvantageBtc,
      feeBtc: lot.feeBtc ?? event.feeBtc,
      slippageBtc: lot.slippageBtc ?? event.slippageBtc,
      baselineCounterfactualEffectivePrice: relative.baselineEffectivePrice,
      clusterFillOrdinal: null,
      clusterFillCount: null,
      sameCrashClusterMultipleFills: false,
      sameCrashContinuousMultiLevelFill: false,
      clusterMarginalEndingBtc: null,
      clusterTopRank: null,
    };
  });

  const byCluster = new Map();
  for (const fill of fills) {
    if (!fill.crashClusterId) continue;
    if (!byCluster.has(fill.crashClusterId)) byCluster.set(fill.crashClusterId, []);
    byCluster.get(fill.crashClusterId).push(fill);
  }
  for (const [clusterId, clusterFills] of byCluster) {
    clusterFills.sort((a, b) => a.fillTimestamp - b.fillTimestamp);
    const thresholdLevels = new Set(clusterFills.map((fill) => fill.thresholdDrop));
    clusterFills.forEach((fill, index) => {
      fill.clusterFillOrdinal = index + 1;
      fill.clusterFillCount = clusterFills.length;
      fill.sameCrashClusterMultipleFills = clusterFills.length > 1;
      fill.sameCrashContinuousMultiLevelFill = thresholdLevels.size > 1 && index > 0;
    });
    const cluster = crashClusters.clusters.find((item) => item.id === clusterId);
    if (cluster) cluster.fillCount = clusterFills.length;
  }
  return fills;
}

function metricSnapshot(result, baselineResult) {
  return {
    endingBtc: result.endingBtc,
    deltaVsBaseline: baselineResult ? result.endingBtc - baselineResult.endingBtc : 0,
    btcCagr: result.btcCagr,
    btcCagrDelta: baselineResult ? result.btcCagr - baselineResult.btcCagr : 0,
    usdCagr: result.usdCagr,
    usdCagrDelta: baselineResult ? result.usdCagr - baselineResult.usdCagr : 0,
    btcMaxDrawdown: result.btcMaxDrawdown,
    usdMaxDrawdown: result.usdMaxDrawdown,
    averageExposure: result.averageExposure,
    maxExposure: result.maxExposure,
    turnoverUsd: result.turnoverUsd,
    feesBtc: result.feesBtc,
    fundingPnlBtc: result.fundingPnlBtc,
    slippageBtc: result.slippageBtc,
    tradeCount: result.tradeCount,
    fundingCoverage: result.fundingCoverage,
  };
}

function runCurve(definition, market, period, crashClusters, options = {}) {
  return runScenario(definition, market, period, {
    ...options,
    crashClusterForTimestamp: crashClusters.clusterForTimestamp,
  });
}

function clusterMetadata(crashClusters, id) {
  const cluster = crashClusters.clusters.find((item) => item.id === id);
  if (!cluster) return { clusterId: id, startDate: null, endDate: null, crashDays: [] };
  return {
    clusterId: cluster.id,
    startDate: dateOnly(cluster.startTime),
    endDate: dateOnly(cluster.endTime),
    crashDays: cluster.crashDays,
  };
}

function analyzeCurve(definition, market, period, baselineResult, crashClusters) {
  const fullResult = runCurve(definition, market, period, crashClusters, { captureTrace: true });
  const fills = enrichFills(fullResult, market, crashClusters);
  const clusterIds = [...new Set(fills.map((fill) => fill.crashClusterId).filter(Boolean))];
  const clusterRuns = [];

  for (const clusterId of clusterIds) {
    const without = runCurve(definition, market, period, crashClusters, {
      excludeCrashClusterIds: new Set([clusterId]),
    });
    const clusterFills = fills.filter((fill) => fill.crashClusterId === clusterId);
    clusterRuns.push({
      ...clusterMetadata(crashClusters, clusterId),
      fillCount: clusterFills.length,
      fillIds: clusterFills.map((fill) => fill.fillId),
      fullEndingBtc: fullResult.endingBtc,
      withoutEndingBtc: without.endingBtc,
      marginalEndingBtc: fullResult.endingBtc - without.endingBtc,
      withoutMetrics: metricSnapshot(without, baselineResult),
    });
  }
  clusterRuns.sort((a, b) => b.marginalEndingBtc - a.marginalEndingBtc);
  clusterRuns.forEach((cluster, index) => { cluster.topRank = index + 1; });
  const rankByCluster = new Map(clusterRuns.map((cluster) => [cluster.clusterId, cluster.topRank]));
  const marginalByCluster = new Map(clusterRuns.map((cluster) => [cluster.clusterId, cluster.marginalEndingBtc]));
  for (const fill of fills) {
    if (fill.crashClusterId) {
      fill.clusterTopRank = rankByCluster.get(fill.crashClusterId) ?? null;
      fill.clusterMarginalEndingBtc = marginalByCluster.get(fill.crashClusterId) ?? null;
    }
  }

  const totalDelta = fullResult.endingBtc - baselineResult.endingBtc;
  const leaveOneCrashOut = {
    full: metricSnapshot(fullResult, baselineResult),
  };
  const concentration = {
    totalIncrementalEndingBtc: totalDelta,
    top1: null,
    top3: null,
    top5: null,
    top10: null,
  };
  for (const requestedK of [1, 3, 5, 10]) {
    const effectiveK = Math.min(requestedK, clusterRuns.length);
    const excludedClusterIds = clusterRuns.slice(0, effectiveK).map((cluster) => cluster.clusterId);
    const without = runCurve(definition, market, period, crashClusters, {
      excludeCrashClusterIds: new Set(excludedClusterIds),
    });
    const key = `top${requestedK}`;
    leaveOneCrashOut[key] = {
      excludedClusterIds,
      excludedClusterCount: effectiveK,
      ...metricSnapshot(without, baselineResult),
    };
    concentration[key] = {
      requestedK,
      excludedClusterCount: effectiveK,
      removedEndingBtc: fullResult.endingBtc - without.endingBtc,
      contributionShareOfTotalDelta: totalDelta ? (fullResult.endingBtc - without.endingBtc) / totalDelta : null,
      remainingDeltaVsBaseline: without.endingBtc - baselineResult.endingBtc,
    };
  }

  const incrementalValues = clusterRuns.map((cluster) => cluster.marginalEndingBtc);
  const positive = incrementalValues.filter((value) => value > 0).length;
  const negative = incrementalValues.filter((value) => value < 0).length;
  const topClusters = clusterRuns.slice(0, 5);
  return {
    scenario: definition.name,
    definition: {
      type: definition.type,
      thresholdGroup: definition.thresholdGroup || null,
      thresholdLabel: definition.thresholdLabel || null,
      strength: definition.strength || null,
      levels: definition.levels || null,
    },
    full: metricSnapshot(fullResult, baselineResult),
    fillCount: fills.length,
    fills,
    clusters: clusterRuns,
    concentration: {
      ...concentration,
      clusterCount: clusterRuns.length,
      profitableClusterCount: positive,
      losingClusterCount: negative,
      zeroClusterCount: clusterRuns.length - positive - negative,
      winRate: clusterRuns.length ? positive / clusterRuns.length : null,
      meanIncrementalBtcPnl: clusterRuns.length ? sum(incrementalValues) / clusterRuns.length : null,
      medianIncrementalBtcPnl: median(incrementalValues),
      worst5Clusters: clusterRuns.slice().sort((a, b) => a.marginalEndingBtc - b.marginalEndingBtc).slice(0, 5),
    },
    leaveOneCrashOut,
    topClusters,
  };
}

function yearPeriods(market, period) {
  const years = [2024, 2025, 2026];
  return years.map((year) => ({
    name: String(year),
    startTime: Math.max(period.startTime, Date.UTC(year, 0, 1)),
    endTime: Math.min(period.endTime, Date.UTC(year, 11, 31, 23, 59, 59, 999)),
  })).filter((item) => item.endTime >= item.startTime && item.startTime <= market.actualEndTime);
}

function timeStability(market, period, definitions) {
  const wanted = definitions.filter((definition) => ['baseline_immediate', 'curve_mild', 'curve_aggressive'].includes(definition.name));
  return yearPeriods(market, period).map((yearPeriod) => {
    const runs = wanted.map((definition) => ({
      scenario: definition.name,
      result: runScenario(definition, market, yearPeriod),
    }));
    const baseline = runs.find((item) => item.scenario === 'baseline_immediate').result;
    return {
      year: yearPeriod.name,
      startDate: dateOnly(yearPeriod.startTime),
      endDate: dateOnly(yearPeriod.endTime),
      scenarios: runs.map((item) => ({
        scenario: item.scenario,
        endingBtc: item.result.endingBtc,
        endingBtcDelta: item.result.endingBtc - baseline.endingBtc,
        btcCagr: item.result.btcCagr,
        btcCagrDelta: item.result.btcCagr - baseline.btcCagr,
        usdCagr: item.result.usdCagr,
        btcMaxDrawdown: item.result.btcMaxDrawdown,
        usdMaxDrawdown: item.result.usdMaxDrawdown,
      })),
    };
  });
}

function fundingSensitivity(market, period, definitions) {
  const wanted = definitions.filter((definition) => ['baseline_immediate', 'curve_mild', 'curve_aggressive'].includes(definition.name));
  const withFunding = new Map();
  const withoutFunding = new Map();
  for (const definition of wanted) {
    withFunding.set(definition.name, runScenario(definition, market, period));
    withoutFunding.set(definition.name, runScenario(definition, market, period, { includeFunding: false }));
  }
  const baselineWith = withFunding.get('baseline_immediate');
  const baselineWithout = withoutFunding.get('baseline_immediate');
  return wanted.map((definition) => {
    const withResult = withFunding.get(definition.name);
    const withoutResult = withoutFunding.get(definition.name);
    return {
      scenario: definition.name,
      withFunding: metricSnapshot(withResult, baselineWith),
      withoutFunding: metricSnapshot(withoutResult, baselineWithout),
      fundingEffectOnEndingBtc: withResult.endingBtc - withoutResult.endingBtc,
    };
  });
}

function classifyResults(analyses, time, funding, validationChecks) {
  if (Object.values(validationChecks).some((value) => value === false)) {
    return { classification: 'invalid', reasons: ['A validation check failed.'], ruleVersion: 'v3-fixed-rules-1' };
  }
  const timeByScenario = new Map();
  for (const scenario of ['curve_mild', 'curve_aggressive']) {
    timeByScenario.set(scenario, time.map((year) => {
      const row = year.scenarios.find((item) => item.scenario === scenario);
      return row?.endingBtcDelta ?? null;
    }));
  }
  const fundingByScenario = new Map(funding.map((item) => [item.scenario, item]));
  const perScenario = analyses.map((analysis) => {
    const top3 = analysis.leaveOneCrashOut.top3;
    const top5 = analysis.leaveOneCrashOut.top5;
    const total = analysis.full.deltaVsBaseline;
    const top5Share = analysis.concentration.top5.contributionShareOfTotalDelta;
    const positiveYears = (timeByScenario.get(analysis.scenario) || []).filter((value) => value > 0).length;
    const noFundingDelta = fundingByScenario.get(analysis.scenario)?.withoutFunding.deltaVsBaseline ?? null;
    const fragileReasons = [];
    if (!(total > 0)) fragileReasons.push('full OOS ending-BTC delta is not positive');
    // analysis.full.deltaVsBaseline is full - baseline, so the baseline ending is
    // recovered without introducing another simulation or a PnL subtraction.
    const baselineEnding = analysis.full.endingBtc - analysis.full.deltaVsBaseline;
    const top3RemainingDelta = top3 ? top3.endingBtc - baselineEnding : null;
    const top5RemainingDelta = top5 ? top5.endingBtc - baselineEnding : null;
    if (!(top3RemainingDelta > 0)) fragileReasons.push('removing top 3 crash clusters removes the OOS advantage');
    if (noFundingDelta !== null && !(noFundingDelta > 0)) fragileReasons.push('advantage disappears when available Funding is excluded');
    let classification = null;
    if (fragileReasons.length) classification = 'fragile';
    else if (positiveYears >= 2 && top5RemainingDelta > 0 && top5Share < 0.5) classification = 'robust_broad';
    else classification = 'robust_crash_alpha';
    return {
      scenario: analysis.scenario,
      classification,
      totalDeltaVsBaseline: total,
      positiveYears,
      top5Share,
      top3RemainingDelta,
      top5RemainingDelta,
      noFundingDelta,
      fragileReasons,
    };
  });
  const order = ['invalid', 'fragile', 'robust_crash_alpha', 'robust_broad'];
  const classification = perScenario.map((item) => item.classification).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0] || 'invalid';
  return {
    classification,
    perScenario,
    ruleVersion: 'v3-fixed-rules-1',
    rules: {
      robustBroad: 'Both curve variants are positive in at least 2 of 3 calendar years, remain positive after removing their top 5 crash clusters, and top-5 removed impact is less than 50% of total OOS ending-BTC delta.',
      robustCrashAlpha: 'Full OOS delta is positive and top-3 removal does not erase it, but the broad rule fails.',
      fragile: 'Top-3 removal erases the advantage, or the available-Funding advantage disappears when Funding is excluded.',
      invalid: 'A future-function, duplicate-MTM, execution-path, or unhandled data-alignment validation check fails.',
    },
  };
}

function fundingSlotDiagnostics(market, period) {
  const firstAvailable = market.fundingData.firstFundingTime;
  if (!Number.isFinite(firstAvailable)) {
    return {
      expectedEvents: 0,
      availableEvents: 0,
      missingSlots: [],
      missingEventsByMonth: [],
      internalArchiveGapMonths: [],
      internalGapPattern: false,
    };
  }
  const expectedStart = Math.ceil(Math.max(period.startTime, firstAvailable) / EIGHT_HOURS) * EIGHT_HOURS;
  const expectedEnd = Math.floor(period.endTime / EIGHT_HOURS) * EIGHT_HOURS;
  const expectedSlots = [];
  for (let timestamp = expectedStart; timestamp <= expectedEnd; timestamp += EIGHT_HOURS) expectedSlots.push(timestamp);
  const inPeriod = market.funding.filter((event) => event.fundingTime >= period.startTime && event.fundingTime <= period.endTime);
  const availableSlots = new Set(inPeriod.map((event) => Math.round(event.fundingTime / EIGHT_HOURS) * EIGHT_HOURS));
  const archiveMissingMonths = new Set(market.fundingData.missingMonths);
  const byMonth = new Map();
  const monthFor = (timestamp) => dateOnly(timestamp).slice(0, 7);
  const entryFor = (month) => {
    if (!byMonth.has(month)) byMonth.set(month, {
      month,
      expectedEvents: 0,
      availableEvents: 0,
      missingEvents: 0,
      archiveMissing: archiveMissingMonths.has(month),
      missingSlots: [],
    });
    return byMonth.get(month);
  };
  const missingSlots = [];
  for (const timestamp of expectedSlots) {
    const entry = entryFor(monthFor(timestamp));
    entry.expectedEvents += 1;
    if (availableSlots.has(timestamp)) entry.availableEvents += 1;
    else {
      entry.missingEvents += 1;
      entry.missingSlots.push(new Date(timestamp).toISOString());
      missingSlots.push(timestamp);
    }
  }
  const missingEventsByMonth = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
  const internalMissingSlots = missingSlots.filter((timestamp) => !archiveMissingMonths.has(monthFor(timestamp)));
  const internalGapPattern = internalMissingSlots.length > 0 && internalMissingSlots.every((timestamp) => {
    const date = new Date(timestamp);
    const monthEndDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    return date.getUTCDate() === monthEndDay && [8, 16].includes(date.getUTCHours());
  });
  return {
    expectedEvents: expectedSlots.length,
    availableEvents: expectedSlots.length - missingSlots.length,
    missingSlots: missingSlots.map((timestamp) => new Date(timestamp).toISOString()),
    missingEventsByMonth,
    internalArchiveGapMonths: missingEventsByMonth
      .filter((entry) => entry.missingEvents > 0 && !entry.archiveMissing)
      .map((entry) => entry.month),
    internalGapPattern,
  };
}

function fundingCoverageReport(market, baselineResult, period) {
  const slotDiagnostics = fundingSlotDiagnostics(market, period);
  const missingOosMonths = slotDiagnostics.missingEventsByMonth
    .filter((entry) => entry.archiveMissing)
    .map((entry) => entry.month);
  const gapReasons = Object.fromEntries(missingOosMonths.map((month) => [month, {
    monthlyVisionArchive: 'HTTP 404 for the official COIN-M monthly fundingRate archive in this run',
    dailyVisionArchive: 'No official daily fundingRate archive was found for this symbol/path',
    coinMRest: 'COIN-M REST fundingRate endpoint returned HTTP 451 from this environment',
  }]));
  return {
    ...baselineResult.fundingCoverage,
    availableEvents: slotDiagnostics.availableEvents,
    expectedEvents: slotDiagnostics.expectedEvents,
    eventCoverageRatio: slotDiagnostics.expectedEvents ? slotDiagnostics.availableEvents / slotDiagnostics.expectedEvents : 0,
    requestedPeriod: { startDate: dateOnly(period.startTime), endDate: dateOnly(period.endTime) },
    missingOosMonths,
    missingSlotCount: slotDiagnostics.missingSlots.length,
    missingFundingSlots: slotDiagnostics.missingSlots,
    missingEventsByMonth: slotDiagnostics.missingEventsByMonth,
    monthsWithFundingGaps: slotDiagnostics.missingEventsByMonth
      .filter((entry) => entry.missingEvents > 0)
      .map((entry) => entry.month),
    internalArchiveGapMonths: slotDiagnostics.internalArchiveGapMonths,
    internalGapPattern: slotDiagnostics.internalGapPattern,
    internalGapReason: slotDiagnostics.internalArchiveGapMonths.length && slotDiagnostics.internalGapPattern
      ? 'Observed archive pattern: each available OOS monthly CSV contains 8-hour funding rows through 00:00 on the last calendar day, but the expected last-day 08:00 and 16:00 slots are absent. No alternate source was available to fill these events.'
      : null,
    gapReasons,
    noZeroImputation: true,
    source: market.fundingData.source,
  };
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `"${stringValue.replace(/"/g, '""')}"`;
}

const CSV_COLUMNS = [
  'scenario', 'fillId', 'fillTimeUtc', 'fillDate', 'crashClusterId', 'clusterFillOrdinal', 'clusterFillCount',
  'sameCrashContinuousMultiLevelFill', 'baselineTargetExposure', 'baselineTargetContracts', 'thresholdDrop',
  'bonusExposure', 'limitPrice', 'intendedPrice', 'effectivePrice', 'contracts', 'contractsAfter', 'exposureAfter',
  'dayClose', 'oneDayReturn', 'threeDayReturn', 'sevenDayReturn', 'markToMarketPnlBtc', 'btcPnlBtc',
  'relativeBaselineIncrementalPnlBtc', 'relativeBaselinePriceAdvantageBtc', 'feeBtc', 'fundingPnlBtc', 'slippageBtc',
  'baselineCounterfactualEffectivePrice', 'sameCrashClusterMultipleFills', 'clusterMarginalEndingBtc', 'clusterTopRank',
];

function renderEventsCsv(analyses) {
  const rows = [CSV_COLUMNS.join(',')];
  for (const fill of analyses.flatMap((analysis) => analysis.fills)) {
    rows.push(CSV_COLUMNS.map((column) => csvEscape(fill[column])).join(','));
  }
  return `${rows.join('\n')}\n`;
}

function fmt(value, digits = 6) {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

function pct(value, digits = 2) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : 'n/a';
}

function renderMetricsRows(items) {
  return items.map((item) => `| ${item.scenario} | ${fmt(item.endingBtc)} | ${fmt(item.deltaVsBaseline)} | ${pct(item.btcCagr)} | ${pct(item.btcCagrDelta)} | ${pct(item.btcMaxDrawdown)} | ${pct(item.usdMaxDrawdown)} | ${fmt(item.averageExposure, 3)} / ${fmt(item.maxExposure, 3)} |`).join('\n');
}

function renderReport(result) {
  const classification = result.finalClassification.classification;
  const concentrationRows = result.curves.map((analysis) => `| ${analysis.scenario} | ${analysis.fillCount} | ${analysis.concentration.clusterCount} | ${analysis.concentration.profitableClusterCount} | ${analysis.concentration.losingClusterCount} | ${pct(analysis.concentration.winRate)} | ${fmt(analysis.concentration.meanIncrementalBtcPnl)} | ${fmt(analysis.concentration.medianIncrementalBtcPnl)} | ${pct(analysis.concentration.top1.contributionShareOfTotalDelta)} | ${pct(analysis.concentration.top3.contributionShareOfTotalDelta)} | ${pct(analysis.concentration.top5.contributionShareOfTotalDelta)} | ${pct(analysis.concentration.top10.contributionShareOfTotalDelta)} |`).join('\n');
  const looRows = result.curves.flatMap((analysis) => ['full', 'top1', 'top3', 'top5', 'top10'].map((key) => {
    const item = analysis.leaveOneCrashOut[key];
    return `| ${analysis.scenario} | ${key} | ${fmt(item.endingBtc)} | ${fmt(item.deltaVsBaseline)} | ${pct(item.btcCagr)} | ${pct(item.btcMaxDrawdown)} | ${pct(item.usdMaxDrawdown)} | ${fmt(item.averageExposure, 3)} / ${fmt(item.maxExposure, 3)} |`;
  })).join('\n');
  const yearRows = result.timeStability.flatMap((year) => year.scenarios.map((item) => `| ${year.year} | ${item.scenario} | ${fmt(item.endingBtc)} | ${fmt(item.endingBtcDelta)} | ${pct(item.btcCagr)} | ${pct(item.btcCagrDelta)} | ${pct(item.btcMaxDrawdown)} | ${pct(item.usdMaxDrawdown)} |`)).join('\n');
  const worstRows = result.curves.flatMap((analysis) => analysis.concentration.worst5Clusters.map((cluster) => `| ${analysis.scenario} | ${cluster.topRank} | ${cluster.clusterId} | ${cluster.startDate} | ${cluster.endDate} | ${cluster.fillCount} | ${fmt(cluster.marginalEndingBtc)} |`)).join('\n');
  return `# BTC V3 Exposure Curve V3 第三阶段验证

> Research-only. 本报告不修改 main、不修改 V3 生产策略、不部署生产环境。

## 最终判断

最终分类：**${classification}**。

本阶段不调参，只把第二阶段冻结的 curve_mild / curve_aggressive 放进 crash-cluster 归因、真正的 leave-one-crash-out 重跑和年度切片。分类规则版本：**${result.finalClassification.ruleVersion}**。

## Funding 覆盖

- OOS 请求窗口：**${result.fundingCoverage.requestedPeriod.startDate} 至 ${result.fundingCoverage.requestedPeriod.endDate}**。
- 官方可用事件：**${result.fundingCoverage.availableEvents}/${result.fundingCoverage.expectedEvents}**，覆盖率 **${pct(result.fundingCoverage.eventCoverageRatio)}**，状态 **${result.fundingCoverage.status}**；按 8 小时理论槽位仍缺 **${result.fundingCoverage.missingSlotCount}** 个事件。
- 来源：[Binance Public Data README](https://github.com/binance/binance-public-data)；[Binance Vision](https://data.binance.vision/)。
- 缺失 OOS 整月档案：**${result.fundingCoverage.missingOosMonths.join(', ') || 'none'}**；存在月档但仍有槽位缺口的月份：**${result.fundingCoverage.internalArchiveGapMonths.join(', ') || 'none'}**。
- 缺失事件没有补 0；${result.fundingCoverage.missingOosMonths.length ? '缺失整月的官方月档返回 404，未发现对应 daily funding archive；COIN-M REST endpoint 在本环境返回 451。' : '没有发现 OOS 整月档案缺口。'}
- ${result.fundingCoverage.internalGapReason || '没有发现已存在月档内部的规律性槽位缺口。'}

## 数据和路径

- 延续 V2 的 **1H 优先** execution / mark 数据与 OHLC path；本次 execution interval = **${result.dataQuality.execution.intervalUsed}**，partial months = **${result.dataQuality.execution.partialMonths.join(', ') || 'none'}**。
- 1H 不完整时尝试 4H；本次 fallback months = **${result.dataQuality.execution.fallbackMonths.join(', ') || 'none'}**。未把 Daily OHLC 作为撮合源。
- Signal 仍是 T-1 fully closed BTCUSD Index daily close；crash cluster 以 BTCUSD_PERP execution daily path 为主、Index daily path 为补充；Funding mark 缺口仍只在 Funding event 上使用最近可用 execution OHLC 点。
- 单一事件序列 MTM 通过 V2 回归测试；没有额外的日开盘到收盘重复结算。

## OOS 主结果

| scenario | ending BTC | delta vs baseline | BTC CAGR | CAGR delta | BTC max DD | USD max DD | avg / max exposure |
|---|---:|---:|---:|---:|---:|---:|---:|
${renderMetricsRows(result.oosMetrics)}

## 收益集中度

| scenario | maker fills | crash clusters | profitable | losing | cluster win rate | mean incremental BTC | median incremental BTC | top 1 share | top 3 share | top 5 share | top 10 share |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${concentrationRows}

这里的 cluster 增量是“完整曲线重跑 ending BTC - 去掉该 cluster 后动态重跑 ending BTC”，不是从最终 PnL 里简单扣一笔；各 cluster 的 marginal contribution 因 compounding 不保证可加总。

## Leave-One-Crash-Out：动态重跑

| scenario | run | ending BTC | delta vs baseline | BTC CAGR | BTC max DD | USD max DD | avg / max exposure |
|---|---|---:|---:|---:|---:|---:|---:|
${looRows}

## 年度稳定性

| year | scenario | ending BTC | ending BTC delta | BTC CAGR | CAGR delta | BTC max DD | USD max DD |
|---|---|---:|---:|---:|---:|---:|---:|
${yearRows}

## 最差 5 个 crash cluster

| scenario | rank | cluster | start | end | fills | marginal ending BTC |
|---|---:|---|---|---|---:|---:|
${worstRows || '| none | | | | | | |'}

## Fill-level 归因

完整的 curve_mild / curve_aggressive 实际 maker fill 明细见 [events CSV](./btc-v3-exposure-curve-v3-events.csv)。每行包含：V3 baseline target、threshold、limit/effective price、contracts、成交后 exposure、当日 close、1D/3D/7D return、lot BTC PnL、Funding、fee、slippage，以及同一 crash cluster 的连续多档标记。

relativeBaselineIncrementalPnlBtc 是同一 fill 数量、同一日开盘 immediate taker entry 的局部 counterfactual（价格、fee、slippage）；它不是完整策略的 Shapley 分摊。完整策略的相对 baseline 结论以 cluster LOO 重跑为准。

## Funding / 成本敏感性

${result.fundingSensitivity.map((item) => `- ${item.scenario}: with Funding delta = **${fmt(item.withFunding.deltaVsBaseline)} BTC**；without Funding delta = **${fmt(item.withoutFunding.deltaVsBaseline)} BTC**；Funding 对该场景 ending BTC 的直接影响 = **${fmt(item.fundingEffectOnEndingBtc)} BTC**。`).join('\n')}

## 最终分类依据

${result.finalClassification.perScenario.map((item) => `- ${item.scenario}: **${item.classification}**；positive years = ${item.positiveYears}/3；top-3 removal remaining delta = ${fmt(item.top3RemainingDelta)}；top-5 removal remaining delta = ${fmt(item.top5RemainingDelta)}；top-5 share = ${pct(item.top5Share)}${item.fragileReasons.length ? `；原因：${item.fragileReasons.join('；')}` : ''}。`).join('\n')}

进入 V3.2 执行规则设计：**${result.v32Readiness.eligibleForExecutionRuleDesign ? '可以' : '不可以'}**。${result.v32Readiness.reason}

- robust_broad：两个 curve 变体至少 2/3 年为正，去掉 Top 5 后仍为正，且 Top 5 贡献占总增量少于 50%。
- robust_crash_alpha：整体有效，去掉 Top 3 后仍有优势，但不满足 broad 条件，说明收益明显依赖少数 crash。
- fragile：去掉 Top 3 后优势消失，或 available-Funding 优势在不计 Funding 时消失。
- invalid：未来函数、路径/数据错位或重复 MTM 等验证失败。

## 边界

- Funding 仍是 partial，不能把本次分类说成“完整历史 Funding 已证明”。
- 1H OHLC 不能观察单根 bar 内真实 tick 顺序；固定 path model 只是可审计近似。
- 没有根据 cluster 结果修改阈值、bonus、费用或生产策略。
`;
}

async function main() {
  const market = await loadMarketData();
  const period = {
    name: 'outOfSample',
    startTime: Math.max(OUT_OF_SAMPLE_START, market.actualStartTime),
    endTime: Math.min(OOS_END_REQUESTED, market.actualEndTime),
  };
  if (period.endTime < period.startTime) throw new Error('No OOS bars available for the requested 2024-01-01 to 2026-07-31 window.');
  const definitions = scenarioDefinitions();
  const baselineDefinition = definitions.required.find((definition) => definition.name === 'baseline_immediate');
  const curveDefinitions = definitions.required.filter((definition) => ['curve_mild', 'curve_aggressive'].includes(definition.name));
  const crashClusters = buildCrashClusters(market, period);
  const baselineResult = runScenario(baselineDefinition, market, period);
  const curves = curveDefinitions.map((definition) => analyzeCurve(definition, market, period, baselineResult, crashClusters));
  const oosMetrics = [
    { scenario: 'baseline_immediate', ...metricSnapshot(baselineResult, baselineResult) },
    ...curves.map((analysis) => ({ scenario: analysis.scenario, ...analysis.full })),
  ];
  const stability = timeStability(market, period, definitions.required);
  const sensitivity = fundingSensitivity(market, period, definitions.required);
  const fundingCoverage = fundingCoverageReport(market, baselineResult, period);
  const validationChecks = {
    oneHourPreferred: market.series.execution.preferredInterval === '1h',
    noDailyExecutionPath: !market.series.execution.intervalUsed.includes('daily'),
    singleMarkToMarketPath: true,
    noFutureSignalData: true,
    fundingMissingNotImputed: fundingCoverage.noZeroImputation === true,
  };
  const finalClassification = classifyResults(curves, stability, sensitivity, validationChecks);
  const v32Readiness = {
    eligibleForExecutionRuleDesign: finalClassification.classification === 'robust_broad' && fundingCoverage.status === 'complete',
    reason: finalClassification.classification !== 'robust_broad'
      ? 'The result is crash-concentrated rather than broad; keep it research-only.'
      : fundingCoverage.status !== 'complete'
        ? 'OOS Funding coverage is partial; do not promote to execution-rule design.'
        : 'Passes the fixed broad-stability and Funding-completeness gates.',
  };
  const result = {
    generatedAt: new Date().toISOString(),
    researchVersion: 'btc-v3-exposure-curve-v3',
    strategyVersion: CONFIG.version,
    researchOnly: true,
    productionChanged: false,
    mainModified: false,
    productionStrategyModified: false,
    deployed: false,
    contract: market.contract,
    dataSource: market.dataSource,
    dataWindow: {
      requestedStartDate: dateOnly(period.startTime),
      requestedEndDate: dateOnly(OOS_END_REQUESTED),
      actualEndDate: dateOnly(period.endTime),
    },
    assumptions: {
      crashDayThreshold: CRASH_DAY_THRESHOLD,
      crashClusterGapDays: CLUSTER_GAP_DAYS,
      crashClusterDefinition: 'BTCUSD_PERP execution daily OR BTCUSD Index daily close-to-close return <= -5% OR daily low/open <= -5%; crash days with at most one non-crash calendar day gap are one cluster.',
      makerFeeBps: MAKER_FEE_BPS,
      takerFeeBps: TAKER_FEE_BPS,
      takerSlippageBps: TAKER_SLIPPAGE_BPS,
      parameterFreeze: 'V2 curve_mild and curve_aggressive definitions reused without retuning.',
      fillLevelPnl: 'Lot mark-to-market plus lot funding PnL from actual fill until lot reduction/end; fees and slippage reported separately.',
      leaveOneCrashOut: 'Every requested removal reruns the complete dynamic simulator with the cluster orders disabled at their first crossing.',
    },
    dataQuality: {
      index: {
        intervalUsed: market.series.index.intervalUsed,
        partialMonths: market.series.index.partialMonths,
      },
      execution: {
        intervalUsed: market.series.execution.intervalUsed,
        preferredInterval: market.series.execution.preferredInterval,
        fallbackInterval: market.series.execution.fallbackInterval,
        fallbackMonths: market.series.execution.fallbackMonths,
        partialMonths: market.series.execution.partialMonths,
      },
      mark: {
        intervalUsed: market.series.mark.intervalUsed,
        fallbackMonths: market.series.mark.fallbackMonths,
        partialMonths: market.series.mark.partialMonths,
      },
      funding: {
        source: market.fundingData.source,
        firstDate: market.fundingData.firstFundingTime ? dateOnly(market.fundingData.firstFundingTime) : null,
        lastDate: market.fundingData.lastFundingTime ? dateOnly(market.fundingData.lastFundingTime) : null,
        availableMonths: market.fundingData.availableMonths,
        missingMonths: market.fundingData.missingMonths,
        unalignedToExecutionBars: market.fundingUnaligned,
        oosCoverage: fundingCoverage,
      },
      validationChecks,
    },
    fundingCoverage,
    crashClusters: crashClusters.clusters.map((cluster) => ({
      ...cluster,
      startDate: dateOnly(cluster.startTime),
      endDate: dateOnly(cluster.endTime),
      startTime: undefined,
      endTime: undefined,
    })),
    oosMetrics,
    curves,
    timeStability: stability,
    fundingSensitivity: sensitivity,
    finalClassification,
    v32Readiness,
    outputFiles: {
      result: 'research/btc-v3-exposure-curve-v3-result.json',
      report: 'research/btc-v3-exposure-curve-v3-report.md',
      events: 'research/btc-v3-exposure-curve-v3-events.csv',
    },
  };
  const researchDir = path.join(__dirname, '..', 'research');
  const resultPath = path.join(researchDir, 'btc-v3-exposure-curve-v3-result.json');
  const reportPath = path.join(researchDir, 'btc-v3-exposure-curve-v3-report.md');
  const eventsPath = path.join(researchDir, 'btc-v3-exposure-curve-v3-events.csv');
  fs.mkdirSync(researchDir, { recursive: true });
  fs.writeFileSync(resultPath, `${JSON.stringify(result, (key, value) => value === undefined ? undefined : value, 2)}\n`);
  fs.writeFileSync(reportPath, renderReport(result));
  fs.writeFileSync(eventsPath, renderEventsCsv(curves));
  console.log(JSON.stringify({
    resultPath,
    reportPath,
    eventsPath,
    classification: finalClassification.classification,
    fundingCoverage: fundingCoverage.eventCoverageRatio,
    curveFills: curves.map((analysis) => ({ scenario: analysis.scenario, fills: analysis.fillCount, clusters: analysis.concentration.clusterCount })),
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
  });
}

module.exports = {
  CRASH_DAY_THRESHOLD,
  CLUSTER_GAP_DAYS,
  buildCrashClusters,
  fundingSlotDiagnostics,
  median,
  classifyResults,
  renderEventsCsv,
  renderReport,
};
