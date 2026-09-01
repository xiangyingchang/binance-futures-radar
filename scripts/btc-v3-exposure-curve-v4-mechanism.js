'use strict';

const fs = require('fs');
const path = require('path');
const { CONFIG, computeSignal } = require('../lib/btc-v3-strategy');
const v2 = require('./btc-v3-exposure-curve-research');
const { buildCrashClusters } = require('./btc-v3-exposure-curve-v3-validation');

const {
  DAY,
  HOUR,
  OUT_OF_SAMPLE_START,
  dateOnly,
  loadMarketData,
} = v2;

const EIGHT_HOURS = 8 * HOUR;
const OOS_END_REQUESTED = Date.UTC(2026, 6, 31, 23, 59, 59, 999);
const PERIOD = {
  name: 'outOfSample',
  startTime: OUT_OF_SAMPLE_START,
  endTime: OOS_END_REQUESTED,
};
const SCENARIO_NAMES = ['curve_mild', 'curve_aggressive'];
const STAGE3_RESULT_PATH = path.join(__dirname, '..', 'research', 'btc-v3-exposure-curve-v3-result.json');

const FEATURE_DEFINITIONS = [
  { key: 'v3TrendScore', label: 'V3 Trend Score', source: 'Frozen V3 computeSignal trendScore' },
  { key: 'bearLock', label: 'Bear Lock', source: 'Frozen V3 computeSignal bearLock' },
  { key: 'baselineTargetExposure', label: 'Baseline target exposure', source: 'Frozen V3 computeSignal finalTarget' },
  { key: 'priceVsMA200', label: 'Price vs MA200', source: 'Pre-crash closed BTCUSD Index close / MA200 - 1' },
  { key: 'ma200Slope30', label: 'MA200 30D slope', source: 'Frozen V3 30-observation MA200 slope' },
  { key: 'ema15VsEma30', label: 'EMA15 vs EMA30', source: 'Pre-crash EMA15 / EMA30 - 1' },
  { key: 'drawdown365', label: '365D drawdown', source: 'Frozen V3 trailingDrawdown' },
  { key: 'ma200Deviation', label: 'MA200 deviation', source: 'Frozen V3 close / MA200 - 1' },
  { key: 'rv30', label: 'RV30', source: 'Frozen V3 annualized 30D realized volatility' },
  { key: 'volatilityCap', label: 'Volatility cap', source: 'Frozen V3 volatilityCap' },
  { key: 'preCrash7dReturn', label: 'Crash前 7D return', source: 'Closed Index close return over the prior 7 observations' },
  { key: 'preCrash30dReturn', label: 'Crash前 30D return', source: 'Closed Index close return over the prior 30 observations' },
  { key: 'preCrash7dRealizedVol', label: 'Crash前 7D realized vol', source: 'Annualized sample volatility over the prior 7 daily returns' },
  { key: 'consecutiveDown3', label: '连续 3 日下跌', source: 'All prior 3 closed daily returns < 0' },
  { key: 'consecutiveDown5', label: '连续 5 日下跌', source: 'All prior 5 closed daily returns < 0' },
  { key: 'consecutiveDown7', label: '连续 7 日下跌', source: 'All prior 7 closed daily returns < 0' },
  { key: 'preCrash30dHighDrawdown', label: '距离 30D high 回撤', source: 'Pre-crash close / prior 30-observation high - 1' },
  { key: 'preCrash90dHighDrawdown', label: '距离 90D high 回撤', source: 'Pre-crash close / prior 90-observation high - 1' },
  { key: 'fundingLastRate', label: 'Funding last rate', source: 'Last available covered Funding rate before cluster start' },
  { key: 'fundingMean7dAvailable', label: 'Funding 7D mean', source: 'Mean of available covered Funding rates in prior 7 calendar days; no zero fill' },
  { key: 'fundingMedian7dAvailable', label: 'Funding 7D median', source: 'Median of available covered Funding rates in prior 7 calendar days; no zero fill' },
  { key: 'fundingPositiveShare7d', label: 'Funding positive share 7D', source: 'Positive share of available covered Funding rates in prior 7 calendar days' },
];

const RULE_SPECS = [
  { name: 'bear_lock_on', label: 'Bear Lock on', key: 'bearLock', predicate: (value) => value === true },
  { name: 'trend_score_low', label: 'Trend Score <= 1', key: 'v3TrendScore', predicate: (value) => Number.isFinite(value) && value <= 1 },
  { name: 'ma200_slope_negative', label: 'MA200 slope < 0', key: 'ma200Slope30', predicate: (value) => Number.isFinite(value) && value < 0 },
  { name: 'baseline_exposure_high', label: 'Baseline exposure >= 1.0', key: 'baselineTargetExposure', predicate: (value) => Number.isFinite(value) && value >= 1 },
  { name: 'rv30_high', label: 'RV30 >= V3 target annual vol', key: 'rv30', predicate: (value) => Number.isFinite(value) && value >= CONFIG.targetAnnualVol },
  { name: 'price_below_ma200', label: 'Price below MA200', key: 'priceVsMA200', predicate: (value) => Number.isFinite(value) && value < 0 },
  { name: 'ema_bearish', label: 'EMA15 below EMA30', key: 'ema15VsEma30', predicate: (value) => Number.isFinite(value) && value < 0 },
  { name: 'pre7d_negative', label: 'Crash前 7D return < 0', key: 'preCrash7dReturn', predicate: (value) => Number.isFinite(value) && value < 0 },
  { name: 'pre30d_negative', label: 'Crash前 30D return < 0', key: 'preCrash30dReturn', predicate: (value) => Number.isFinite(value) && value < 0 },
  { name: 'pre7d_three_down', label: 'Crash前连续 3 日下跌', key: 'consecutiveDown3', predicate: (value) => value === true },
  { name: 'pre7d_five_down', label: 'Crash前连续 5 日下跌', key: 'consecutiveDown5', predicate: (value) => value === true },
  { name: 'pre7d_seven_down', label: 'Crash前连续 7 日下跌', key: 'consecutiveDown7', predicate: (value) => value === true },
  { name: '365d_drawdown_20', label: '365D drawdown <= V3 cheap threshold', key: 'drawdown365', predicate: (value) => Number.isFinite(value) && value <= CONFIG.cheapDrawdown },
];

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function mean(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((total, value) => total + value, 0) / clean.length : null;
}

function median(values) {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
}

function quantile(values, fraction) {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const position = (clean.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return clean[lower];
  return clean[lower] + ((clean[upper] - clean[lower]) * (position - lower));
}

function distribution(values) {
  const clean = values.filter(Number.isFinite);
  return {
    n: clean.length,
    mean: mean(clean),
    median: median(clean),
    q25: quantile(clean, 0.25),
    q75: quantile(clean, 0.75),
    min: clean.length ? Math.min(...clean) : null,
    max: clean.length ? Math.max(...clean) : null,
    values: clean,
  };
}

function booleanDistribution(values) {
  const clean = values.filter((value) => typeof value === 'boolean');
  const numeric = clean.map((value) => value ? 1 : 0);
  return {
    ...distribution(numeric),
    trueCount: clean.filter(Boolean).length,
    trueRate: clean.length ? clean.filter(Boolean).length / clean.length : null,
  };
}

function sampleStd(values) {
  const clean = values.filter(Number.isFinite);
  if (clean.length < 2) return null;
  const avg = mean(clean);
  return Math.sqrt(clean.reduce((total, value) => total + ((value - avg) ** 2), 0) / (clean.length - 1));
}

function annualizedVol(returns) {
  const std = sampleStd(returns);
  return std === null ? null : std * Math.sqrt(CONFIG.annualizationDays);
}

function closedIndexRowsBefore(market, timestamp) {
  return market.indexDaily
    .filter((row) => row.closeTime < timestamp && row.close > 0)
    .sort((a, b) => a.openTime - b.openTime);
}

function returnOverObservations(closes, observations) {
  if (closes.length < observations + 1) return null;
  const from = closes[closes.length - observations - 1];
  const to = closes.at(-1);
  return from > 0 && to > 0 ? (to / from) - 1 : null;
}

function highDrawdown(closes, observations) {
  if (closes.length < observations) return null;
  const window = closes.slice(-observations);
  const peak = Math.max(...window);
  const current = window.at(-1);
  return peak > 0 ? (current / peak) - 1 : null;
}

function consecutiveDecline(closes, observations) {
  if (closes.length < observations + 1) return null;
  const window = closes.slice(-(observations + 1));
  for (let index = 1; index < window.length; index += 1) {
    if (!(window[index] < window[index - 1])) return false;
  }
  return true;
}

function fundingFeatures(market, clusterStartTime) {
  const windowStart = clusterStartTime - 7 * DAY;
  const events = market.funding
    .filter((event) => event.fundingTime >= windowStart && event.fundingTime < clusterStartTime && Number.isFinite(event.fundingRate))
    .sort((a, b) => a.fundingTime - b.fundingTime);
  const rates = events.map((event) => event.fundingRate);
  const firstAvailable = market.fundingData.firstFundingTime;
  const expectedStart = Number.isFinite(firstAvailable)
    ? Math.ceil(Math.max(windowStart, firstAvailable) / EIGHT_HOURS) * EIGHT_HOURS
    : null;
  const expectedEnd = Math.floor((clusterStartTime - 1) / EIGHT_HOURS) * EIGHT_HOURS;
  const expectedSlots = expectedStart !== null && expectedEnd >= expectedStart
    ? Math.floor((expectedEnd - expectedStart) / EIGHT_HOURS) + 1
    : 0;
  const availableSlots = new Set(events.map((event) => Math.round(event.fundingTime / EIGHT_HOURS) * EIGHT_HOURS));
  const availableCount = Math.min(expectedSlots, availableSlots.size);
  const status = expectedSlots === 0 ? 'unavailable' : availableCount === expectedSlots ? 'complete' : 'partial';
  const last = events.at(-1);
  return {
    fundingLastRate: last ? last.fundingRate : null,
    fundingMean7dAvailable: mean(rates),
    fundingMedian7dAvailable: median(rates),
    fundingPositiveShare7d: rates.length ? rates.filter((rate) => rate > 0).length / rates.length : null,
    fundingEvents7dAvailable: events.length,
    fundingExpectedSlots7d: expectedSlots,
    fundingCoverageRatio7d: expectedSlots ? availableCount / expectedSlots : null,
    fundingStatus7d: status,
    fundingLastTime: last ? new Date(last.fundingTime).toISOString() : null,
  };
}

function featureSnapshot(market, clusterStartTime) {
  const rows = closedIndexRowsBefore(market, clusterStartTime);
  const closes = rows.map((row) => row.close);
  const signal = computeSignal(closes);
  const last = rows.at(-1);
  const funding = fundingFeatures(market, clusterStartTime);
  const ema15VsEma30 = signal.ready && signal.ema30 > 0 ? (signal.ema15 / signal.ema30) - 1 : null;
  const recentCloses = closes.slice(-8);
  const recentReturns = recentCloses.length === 8
    ? recentCloses.slice(1).map((close, index) => (close / recentCloses[index]) - 1)
    : [];
  return {
    featureAsOfDate: last ? dateOnly(last.openTime) : null,
    featureAsOfTime: last ? last.closeTime : null,
    featureObservationCount: closes.length,
    v3SignalReady: signal.ready === true,
    v3TrendScore: signal.ready ? signal.trendScore : null,
    bearLock: signal.ready ? signal.bearLock : null,
    baselineTargetExposure: signal.ready ? signal.finalTarget : null,
    priceVsMA200: signal.ready ? signal.ma200Deviation : null,
    ma200: signal.ready ? signal.ma200 : null,
    ma200Slope30: signal.ready ? signal.ma200Slope30 : null,
    ema15: signal.ready ? signal.ema15 : null,
    ema30: signal.ready ? signal.ema30 : null,
    ema15VsEma30,
    drawdown365: signal.ready ? signal.drawdown365 : null,
    ma200Deviation: signal.ready ? signal.ma200Deviation : null,
    rv30: signal.ready ? signal.rv30 : null,
    volatilityCap: signal.ready ? signal.volatilityCap : null,
    preCrash7dReturn: returnOverObservations(closes, 7),
    preCrash30dReturn: returnOverObservations(closes, 30),
    preCrash7dRealizedVol: annualizedVol(recentReturns),
    consecutiveDown3: consecutiveDecline(closes, 3),
    consecutiveDown5: consecutiveDecline(closes, 5),
    consecutiveDown7: consecutiveDecline(closes, 7),
    preCrash30dHighDrawdown: highDrawdown(closes, 30),
    preCrash90dHighDrawdown: highDrawdown(closes, 90),
    ...funding,
  };
}

function outcomeClass(marginalEndingBtc, filled) {
  if (!filled || !Number.isFinite(marginalEndingBtc)) return 'no_fill_or_zero';
  if (marginalEndingBtc > 0) return 'profitable';
  if (marginalEndingBtc < 0) return 'losing';
  return 'zero';
}

function stage3OutcomeMaps(stage3Result) {
  return Object.fromEntries(SCENARIO_NAMES.map((scenario) => {
    const curve = stage3Result.curves.find((item) => item.scenario === scenario);
    if (!curve) throw new Error(`Stage 3 result is missing ${scenario}.`);
    return [scenario, new Map(curve.clusters.map((cluster) => [cluster.clusterId, cluster]))];
  }));
}

function stage3FillCounts(stage3Result) {
  return Object.fromEntries(SCENARIO_NAMES.map((scenario) => {
    const curve = stage3Result.curves.find((item) => item.scenario === scenario);
    const counts = new Map();
    for (const fill of curve.fills) counts.set(fill.crashClusterId, (counts.get(fill.crashClusterId) || 0) + 1);
    return [scenario, counts];
  }));
}

function buildClusterRows(market, stage3Result, period) {
  const localClusters = buildCrashClusters(market, period).clusters;
  const localById = new Map(localClusters.map((cluster) => [cluster.id, cluster]));
  const outcomes = stage3OutcomeMaps(stage3Result);
  const fillCounts = stage3FillCounts(stage3Result);
  const rows = [];
  for (const stage3Cluster of stage3Result.crashClusters) {
    const local = localById.get(stage3Cluster.id);
    if (!local) throw new Error(`Stage 3 cluster ${stage3Cluster.id} cannot be reproduced from the frozen market data.`);
    const features = featureSnapshot(market, local.startTime);
    for (const scenario of SCENARIO_NAMES) {
      const outcome = outcomes[scenario].get(stage3Cluster.id) || null;
      const fillCount = fillCounts[scenario].get(stage3Cluster.id) || 0;
      const filled = fillCount > 0;
      rows.push({
        scenario,
        year: Number(stage3Cluster.startDate.slice(0, 4)),
        clusterId: stage3Cluster.id,
        startDate: stage3Cluster.startDate,
        endDate: stage3Cluster.endDate,
        crashDays: stage3Cluster.crashDays,
        fillCount,
        filled,
        outcomeClass: outcomeClass(outcome?.marginalEndingBtc, filled),
        marginalEndingBtc: filled ? outcome.marginalEndingBtc : null,
        fullEndingBtc: filled ? outcome.fullEndingBtc : null,
        withoutEndingBtc: filled ? outcome.withoutEndingBtc : null,
        clusterTopRank: filled ? outcome.topRank : null,
        ...features,
      });
    }
  }
  return rows;
}

function statsForRows(rows, key, predicate = null) {
  const selected = predicate ? rows.filter(predicate) : rows;
  const values = selected.map((row) => row[key]);
  if (values.some((value) => typeof value === 'boolean')) return booleanDistribution(values);
  return distribution(values.map((value) => Number(value)));
}

function outcomeRows(rows) {
  return {
    profitable: rows.filter((row) => row.outcomeClass === 'profitable'),
    losing: rows.filter((row) => row.outcomeClass === 'losing'),
    zero: rows.filter((row) => row.outcomeClass === 'zero'),
    noFillOrZero: rows.filter((row) => row.outcomeClass === 'no_fill_or_zero'),
  };
}

function featureComparisons(rows) {
  const outcomes = outcomeRows(rows.filter((row) => row.filled));
  return FEATURE_DEFINITIONS.map((feature) => ({
    key: feature.key,
    label: feature.label,
    source: feature.source,
    allFilled: statsForRows(rows.filter((row) => row.filled), feature.key),
    profitable: statsForRows(outcomes.profitable, feature.key),
    losing: statsForRows(outcomes.losing, feature.key),
    missingFilled: rows.filter((row) => row.filled && row[feature.key] === null).length,
  }));
}

function yearRegimeSummary(rows) {
  const years = [2024, 2025, 2026];
  return years.map((year) => {
    const yearRows = rows.filter((row) => row.year === year);
    const filledRows = yearRows.filter((row) => row.filled);
    const outcomes = outcomeRows(filledRows);
    const summary = {
      year,
      allClusterCount: yearRows.length,
      filledClusterCount: filledRows.length,
      profitableClusterCount: outcomes.profitable.length,
      losingClusterCount: outcomes.losing.length,
      zeroOrNoFillCount: yearRows.length - outcomes.profitable.length - outcomes.losing.length,
      featureDistributions: Object.fromEntries(FEATURE_DEFINITIONS.map((feature) => [feature.key, statsForRows(yearRows, feature.key)])),
      filledFeatureDistributions: Object.fromEntries(FEATURE_DEFINITIONS.map((feature) => [feature.key, statsForRows(filledRows, feature.key)])),
      outcomeIncrementalBtc: distribution(filledRows.map((row) => row.marginalEndingBtc)),
    };
    return summary;
  });
}

function groupMetrics(rows) {
  const outcomes = outcomeRows(rows);
  const values = rows.map((row) => row.marginalEndingBtc);
  return {
    n: rows.length,
    profitable: outcomes.profitable.length,
    losing: outcomes.losing.length,
    zero: outcomes.zero.length,
    winRate: rows.length ? outcomes.profitable.length / rows.length : null,
    meanIncrementalBtc: mean(values),
    medianIncrementalBtc: median(values),
    sumIncrementalBtc: values.filter(Number.isFinite).reduce((total, value) => total + value, 0),
  };
}

function ruleYearMetrics(rows, rule) {
  const withFeature = rows.filter((row) => row[rule.key] !== null && row[rule.key] !== undefined);
  const conditionRows = withFeature.filter((row) => rule.predicate(row[rule.key]));
  const otherRows = withFeature.filter((row) => !rule.predicate(row[rule.key]));
  return {
    year: rows[0]?.year || null,
    featureAvailableRows: withFeature.length,
    condition: { label: rule.conditionLabel || 'condition=true', ...groupMetrics(conditionRows) },
    other: { label: 'condition=false', ...groupMetrics(otherRows) },
    meanGapConditionMinusOther: conditionRows.length && otherRows.length
      ? mean(conditionRows.map((row) => row.marginalEndingBtc)) - mean(otherRows.map((row) => row.marginalEndingBtc))
      : null,
    winRateGapConditionMinusOther: conditionRows.length && otherRows.length
      ? (conditionRows.filter((row) => row.outcomeClass === 'profitable').length / conditionRows.length)
        - (otherRows.filter((row) => row.outcomeClass === 'profitable').length / otherRows.length)
      : null,
  };
}

function walkForwardRules(rows) {
  return RULE_SPECS.map((rule) => {
    const byYear = Object.fromEntries([2024, 2025, 2026].map((year) => {
      const metrics = ruleYearMetrics(rows.filter((row) => row.year === year && row.filled), rule);
      metrics.year = year;
      return [year, metrics];
    }));
    const formation = byYear[2024];
    const canForm = formation.condition.n >= 2 && formation.other.n >= 2
      && Number.isFinite(formation.meanGapConditionMinusOther);
    const preferredGroup = canForm
      ? (formation.meanGapConditionMinusOther >= 0 ? 'condition' : 'other')
      : null;
    const validation = [2025, 2026].map((year) => {
      const metrics = byYear[year];
      if (!preferredGroup) return { year, status: 'not_testable', preferredGroup: null };
      const preferred = metrics[preferredGroup];
      const other = metrics[preferredGroup === 'condition' ? 'other' : 'condition'];
      const enough = preferred.n >= 2 && other.n >= 2;
      const directionMaintained = enough
        && Number.isFinite(preferred.meanIncrementalBtc)
        && Number.isFinite(other.meanIncrementalBtc)
        && preferred.meanIncrementalBtc >= other.meanIncrementalBtc;
      return {
        year,
        status: !enough ? 'insufficient_sample' : directionMaintained ? 'direction_held' : 'direction_failed',
        preferredGroup,
        preferredMetrics: preferred,
        otherMetrics: other,
        directionMaintained,
        preferredMeanPositive: Number.isFinite(preferred.meanIncrementalBtc) && preferred.meanIncrementalBtc > 0,
      };
    });
    return {
      name: rule.name,
      label: rule.label,
      feature: rule.key,
      fixedCondition: `row.${rule.key} satisfies the pre-registered predicate; no threshold was fitted in 2025/2026`,
      formation2024: {
        ...formation,
        canForm,
        preferredGroup,
        hypothesis: canForm ? `2024 favors ${preferredGroup}` : 'No 2024 hypothesis formed',
      },
      validation,
      stableAcross2025And2026: validation.length === 2 && validation.every((item) => item.status === 'direction_held'),
    };
  });
}

function regimeComparison(years) {
  const byYear = new Map(years.map((year) => [year.year, year]));
  const y2024 = byYear.get(2024);
  const y2025 = byYear.get(2025);
  const y2026 = byYear.get(2026);
  const meanFeature = (year, key) => year?.featureDistributions?.[key]?.mean ?? null;
  const comparisons = [
    ['v3TrendScore', '2026 Trend Score vs 2024/2025', 'lower_is_more_bearish'],
    ['bearLock', '2026 Bear Lock rate vs 2024/2025', 'higher_is_more_bearish'],
    ['baselineTargetExposure', '2026 baseline exposure vs 2024/2025', 'lower_is_more_bearish'],
    ['ma200Slope30', '2026 MA200 slope vs 2024/2025', 'lower_is_more_bearish'],
    ['rv30', '2026 RV30 vs 2024/2025', 'higher_is_more_volatile'],
    ['preCrash7dReturn', '2026 pre-crash 7D return vs 2024/2025', 'lower_is_more_continuation'],
    ['preCrash30dReturn', '2026 pre-crash 30D return vs 2024/2025', 'lower_is_more_continuation'],
    ['consecutiveDown7', '2026 7D consecutive-decline rate vs 2024/2025', 'higher_is_more_continuation'],
    ['preCrash30dHighDrawdown', '2026 distance from 30D high vs 2024/2025', 'lower_is_more_drawn_down'],
    ['preCrash90dHighDrawdown', '2026 distance from 90D high vs 2024/2025', 'lower_is_more_drawn_down'],
  ].map(([key, label, interpretation]) => ({
    key,
    label,
    interpretation,
    year2024: meanFeature(y2024, key),
    year2025: meanFeature(y2025, key),
    year2026: meanFeature(y2026, key),
    delta2026Vs2024: Number.isFinite(meanFeature(y2026, key)) && Number.isFinite(meanFeature(y2024, key))
      ? meanFeature(y2026, key) - meanFeature(y2024, key) : null,
    delta2026Vs2025: Number.isFinite(meanFeature(y2026, key)) && Number.isFinite(meanFeature(y2025, key))
      ? meanFeature(y2026, key) - meanFeature(y2025, key) : null,
  }));
  return comparisons;
}

function finalClassification(ruleResults, validationChecks) {
  if (Object.values(validationChecks).some((value) => value === false)) {
    return {
      classification: 'invalid',
      reason: 'A data alignment, future-information, cluster reproduction, or frozen-parameter check failed.',
      perScenario: [],
    };
  }
  const perScenario = ruleResults.map((item) => {
    const stable = item.rules.filter((rule) => rule.stableAcross2025And2026);
    const anyHeld = item.rules.some((rule) => rule.validation.some((year) => year.status === 'direction_held'));
    return {
      scenario: item.scenario,
      stableRuleNames: stable.map((rule) => rule.name),
      anyValidationDirectionHeld: anyHeld,
      classification: stable.length ? 'mechanism_supported' : anyHeld ? 'weak_mechanism' : 'no_identifiable_mechanism',
    };
  });
  const commonStable = ruleResults.length > 0
    && ruleResults.every((item) => item.rules.some((rule) => rule.stableAcross2025And2026))
    ? ruleResults[0].rules.filter((rule) => rule.stableAcross2025And2026)
      .map((rule) => rule.name)
      .filter((name) => ruleResults.every((item) => item.rules.some((rule) => rule.name === name && rule.stableAcross2025And2026)))
    : [];
  const classification = commonStable.length
    ? 'mechanism_supported'
    : perScenario.some((item) => item.classification === 'weak_mechanism')
      ? 'weak_mechanism'
      : 'no_identifiable_mechanism';
  return {
    classification,
    reason: classification === 'mechanism_supported'
      ? 'At least one fixed pre-crash rule formed in 2024 and held for both scenarios in 2025 and 2026.'
      : classification === 'weak_mechanism'
        ? 'Some fixed pre-crash splits show explanatory power in a subset of years or scenarios, but no common cross-year mechanism is established.'
        : 'No fixed pre-crash split formed in 2024 and held directionally through both 2025 and 2026 for either curve variant.',
    commonStableRuleNames: commonStable,
    perScenario,
  };
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `"${stringValue.replace(/"/g, '""')}"`;
}

const CSV_COLUMNS = [
  'scenario', 'year', 'clusterId', 'startDate', 'endDate', 'crashDays', 'featureAsOfDate', 'featureObservationCount',
  'filled', 'fillCount', 'outcomeClass', 'marginalEndingBtc', 'fullEndingBtc', 'withoutEndingBtc', 'clusterTopRank',
  'v3TrendScore', 'bearLock', 'baselineTargetExposure', 'priceVsMA200', 'ma200Slope30', 'ema15', 'ema30', 'ema15VsEma30',
  'drawdown365', 'ma200Deviation', 'rv30', 'volatilityCap', 'preCrash7dReturn', 'preCrash30dReturn',
  'preCrash7dRealizedVol', 'consecutiveDown3', 'consecutiveDown5', 'consecutiveDown7', 'preCrash30dHighDrawdown',
  'preCrash90dHighDrawdown', 'fundingLastRate', 'fundingMean7dAvailable', 'fundingMedian7dAvailable',
  'fundingPositiveShare7d', 'fundingEvents7dAvailable', 'fundingExpectedSlots7d', 'fundingCoverageRatio7d', 'fundingStatus7d',
];

function renderCsv(rows) {
  return `${[CSV_COLUMNS.join(','), ...rows.map((row) => CSV_COLUMNS.map((column) => csvEscape(row[column])).join(','))].join('\n')}\n`;
}

function fmt(value, digits = 4) {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

function pct(value, digits = 1) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : 'n/a';
}

function featureTableRows(comparisons) {
  return comparisons.map((item) => `| ${item.label} | ${item.profitable.n} / ${fmt(item.profitable.mean)} / ${fmt(item.profitable.median)} | ${item.losing.n} / ${fmt(item.losing.mean)} / ${fmt(item.losing.median)} | ${item.missingFilled} |`).join('\n');
}

function yearTableRows(yearSummaries, scenario) {
  return yearSummaries.map((item) => {
    const f = item.featureDistributions;
    return `| ${item.year} | ${item.allClusterCount} | ${item.filledClusterCount} | ${item.profitableClusterCount} | ${item.losingClusterCount} | ${fmt(f.v3TrendScore.mean, 2)} | ${pct(f.bearLock.trueRate)} | ${fmt(f.baselineTargetExposure.mean, 3)} | ${pct(f.priceVsMA200.mean)} | ${pct(f.ma200Slope30.mean)} | ${pct(f.rv30.mean)} | ${pct(f.preCrash7dReturn.mean)} | ${pct(f.preCrash30dReturn.mean)} | ${pct(f.consecutiveDown7.trueRate)} | ${pct(f.preCrash30dHighDrawdown.mean)} | ${pct(f.preCrash90dHighDrawdown.mean)} |`;
  }).join('\n');
}

function ruleTableRows(rules) {
  return rules.map((rule) => {
    const formation = rule.formation2024;
    const y2025 = rule.validation.find((item) => item.year === 2025);
    const y2026 = rule.validation.find((item) => item.year === 2026);
    return `| ${rule.label} | ${formation.preferredGroup || 'none'} | ${fmt(formation.meanGapConditionMinusOther)} | ${y2025?.status || 'n/a'} | ${y2026?.status || 'n/a'} | ${rule.stableAcross2025And2026 ? 'yes' : 'no'} |`;
  }).join('\n');
}

function renderRegimeExplanation(result) {
  const comparisons = result.regimeComparison;
  const lookup = (key) => comparisons.find((item) => item.key === key);
  const statements = [];
  const trend = lookup('v3TrendScore');
  const bear = lookup('bearLock');
  const exposure = lookup('baselineTargetExposure');
  const slope = lookup('ma200Slope30');
  const rv = lookup('rv30');
  const pre7 = lookup('preCrash7dReturn');
  const down7 = lookup('consecutiveDown7');
  const dd90 = lookup('preCrash90dHighDrawdown');
  if (trend && trend.year2026 < Math.min(trend.year2024, trend.year2025)) statements.push('2026 crash 前 Trend Score 更低，长期/中期趋势组合更偏空。');
  if (bear && bear.year2026 > Math.max(bear.year2024, bear.year2025)) statements.push('2026 crash 前 Bear Lock 覆盖率更高，且基线目标 exposure 更低，Curve 成交主要发生在空头覆盖/减仓路径。');
  if (exposure && exposure.year2026 < Math.min(exposure.year2024, exposure.year2025)) statements.push('2026 crash 前 baseline target exposure 更低，说明失效发生在已有下行 regime，而非高 exposure 下的普通回撤。');
  if (slope && slope.year2026 < Math.min(slope.year2024, slope.year2025)) statements.push('2026 crash 前 MA200 30D slope 更弱。');
  if (rv && rv.year2026 > Math.max(rv.year2024, rv.year2025)) statements.push('2026 crash 前 RV30 更高，进入 crash 时波动状态更差。');
  if (rv && rv.year2026 < Math.min(rv.year2024, rv.year2025)) statements.push('2026 crash 前 RV30 反而更低，不能把失效归因于单纯的波动率上升。');
  if (pre7 && pre7.year2026 < Math.min(pre7.year2024, pre7.year2025)) statements.push('2026 crash 前 7D return 更差，支持 continuation 而非单纯 panic reversal 的解释。');
  if (down7 && down7.year2026 > Math.max(down7.year2024, down7.year2025)) statements.push('2026 crash 前连续 7 日下跌比例更高。');
  if (dd90 && dd90.year2026 < Math.min(dd90.year2024, dd90.year2025)) statements.push('2026 crash 前相对 90D high 的回撤更深。');
  if (!statements.length) statements.push('预设特征没有给出单一、方向一致的 2026 regime 解释。');
  return statements;
}

function renderFundingGapSummary(result) {
  const coverage = result.fundingCoverage || {};
  const internal = coverage.internalArchiveGapMonths || [];
  const oos = coverage.missingOosMonths || [];
  const reasons = Object.entries(coverage.gapReasons || {})
    .map(([month, reason]) => `${month}: ${Object.values(reason).join('; ')}`);
  const lines = [];
  if (internal.length) lines.push(`内部月度归档缺口：${internal.join(', ')}；这些月份每月缺少月末 08:00 / 16:00 两个 slot。`);
  if (oos.length) lines.push(`OOS 整月缺口：${oos.join(', ')}；这些月份没有可用 Funding 事件，不能按 0 计入。`);
  if (reasons.length) lines.push(`缺口原因：${reasons.join(' | ')}`);
  return lines.length ? lines : ['没有发现 Funding 缺口。'];
}

function renderReport(result) {
  const scenarioBlocks = result.scenarios.map((scenario) => `### ${scenario.scenario}

填充 cluster：${scenario.rows.filter((row) => row.filled).length}；maker fill：${scenario.rows.reduce((total, row) => total + row.fillCount, 0)}；盈利：${scenario.featureComparisons.find((item) => item.key === 'v3TrendScore')?.profitable.n ?? 0}；亏损：${scenario.featureComparisons.find((item) => item.key === 'v3TrendScore')?.losing.n ?? 0}。

| feature | profitable n / mean / median | losing n / mean / median | missing filled |
|---|---:|---:|---:|
${featureTableRows(scenario.featureComparisons)}

## ${scenario.scenario} 固定规则 walk-forward

| rule | 2024 preferred group | 2024 mean gap | 2025 | 2026 | held both |
|---|---|---:|---|---|---|
${ruleTableRows(scenario.walkForwardRules)}
`).join('\n');
  const yearBlock = result.scenarios.map((scenario) => `### ${scenario.scenario}

| year | all clusters | filled | profitable | losing | Trend Score | Bear Lock rate | baseline exposure | price vs MA200 | MA200 slope | RV30 | pre 7D return | pre 30D return | 7D down rate | 30D high DD | 90D high DD |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${yearTableRows(scenario.yearSummary, scenario.scenario)}
`).join('\n');
  return `# BTC V3 Exposure Curve V4 第四阶段机制研究

> Research-only. 本报告不修改 main、不修改 V3 生产策略、不部署生产环境。

## 最终判断

最终分类：**${result.finalClassification.classification}**。

${result.finalClassification.reason}

2026 失效的主要事前证据：

${renderRegimeExplanation(result).map((line) => `- ${line}`).join('\n')}

## 研究边界

- 仅复用第三阶段已经冻结的 curve_mild / curve_aggressive 结果和 cluster LOO marginal ending BTC；没有重新调 threshold、bonus、费用或撮合路径。
- 特征只使用 crash cluster 开始日前最后一个 fully closed BTCUSD Index daily close，以及该时间之前已覆盖的 Funding。
- 2024 只用于形成固定 hypothesis；2025、2026 不重新选规则或阈值。
- 42 个 OOS crash cluster 中，mild 覆盖 ${result.scenarios.find((item) => item.scenario === 'curve_mild').rows.filter((row) => row.filled).length} 个 cluster、记录 ${result.scenarios.find((item) => item.scenario === 'curve_mild').rows.reduce((total, row) => total + row.fillCount, 0)} 次 maker fill；aggressive 覆盖 ${result.scenarios.find((item) => item.scenario === 'curve_aggressive').rows.filter((row) => row.filled).length} 个 cluster、记录 ${result.scenarios.find((item) => item.scenario === 'curve_aggressive').rows.reduce((total, row) => total + row.fillCount, 0)} 次 maker fill。无填充 cluster 不被伪装成盈利或亏损。

## 数据路径和完整性

- 继续使用第三阶段 1H 优先 execution / mark 数据；本次 execution interval = **${result.dataQuality.execution.intervalUsed}**，fallback months = **${result.dataQuality.execution.fallbackMonths.join(', ') || 'none'}**。
- Crash cluster 定义沿用第三阶段：BTCUSD_PERP execution daily 或 BTCUSD Index daily close-to-close / low-to-open 达到 -5%，最多允许一个非 crash 日间隔。
- Funding 只读官方已覆盖事件，状态 **${result.fundingCoverage.status}**，覆盖率 **${pct(result.fundingCoverage.eventCoverageRatio, 2)}**（${result.fundingCoverage.availableEvents}/${result.fundingCoverage.expectedEvents}）；缺口没有当作 0。

${renderFundingGapSummary(result).map((line) => `- ${line}`).join('\n')}

## 盈亏 crash 特征对比

下面的 mean / median 是 cluster-level pre-crash feature；marginal ending BTC 的盈利/亏损标签来自第三阶段完整动态 LOO，不是简单扣最终 PnL。

${scenarioBlocks}

## 2024 / 2025 / 2026 regime 对比

${yearBlock}

## 固定候选规则与 walk-forward

候选规则和阈值在运行前固定：Bear Lock on；Trend Score <= 1；MA200 slope < 0；baseline exposure >= 1.0；RV30 >= ${CONFIG.targetAnnualVol.toFixed(2)}（V3 target annual vol）；以及价格/EMA/先行收益/连续下跌/365D drawdown 的符号或 V3 cheap threshold。2024 中每条规则只选择 condition / other 中 mean incremental BTC 较高者作为 hypothesis；该组在 2025 和 2026 原样验证。

${result.scenarios.map((scenario) => `- ${scenario.scenario} stable rules: ${scenario.walkForwardRules.filter((rule) => rule.stableAcross2025And2026).map((rule) => rule.name).join(', ') || 'none'}`).join('\n')}

## 结论解释

${result.finalClassification.classification === 'mechanism_supported'
    ? '至少有一个简单、事前可知、跨 2025 和 2026 仍保持方向的 regime filter，可以支持机制假设。仍不等于生产规则授权。'
    : result.finalClassification.classification === 'weak_mechanism'
      ? '部分特征对某一年或某个 curve 有解释力，但跨年份不稳定，不能据此设计执行过滤器。'
      : '没有发现简单、事前可识别且跨年份稳定的 regime filter。Exposure Curve 的有效性更像少数 crash / V 型反转与路径的组合，而不是已被识别的稳定机制。'}

建议：**${result.finalClassification.classification === 'mechanism_supported' ? '继续独立 Forward Test，同时保留历史研究' : '继续历史研究与独立 Forward Test 并行；不得直接转入 V3.2 执行规则'}**。

## 输出

- 每个 cluster / scenario 的完整特征、Outcome 和 Funding coverage：research/btc-v3-exposure-curve-v4-clusters.csv
- 结构化结果和全部分布：research/btc-v3-exposure-curve-v4-result.json
`;
}

async function main() {
  if (!fs.existsSync(STAGE3_RESULT_PATH)) throw new Error(`Missing frozen Stage 3 result: ${STAGE3_RESULT_PATH}`);
  const stage3Result = JSON.parse(fs.readFileSync(STAGE3_RESULT_PATH, 'utf8'));
  const market = await loadMarketData();
  const period = {
    name: PERIOD.name,
    startTime: Math.max(PERIOD.startTime, market.actualStartTime),
    endTime: Math.min(PERIOD.endTime, market.actualEndTime),
  };
  const rows = buildClusterRows(market, stage3Result, period);
  const clusterIds = new Set(rows.map((row) => row.clusterId));
  const stage3ClusterIds = new Set(stage3Result.crashClusters.map((cluster) => cluster.id));
  const frozenDefinitions = Object.fromEntries(stage3Result.curves.map((curve) => [curve.scenario, curve.definition]));
  const definitions = {
    curve_mild: { thresholdLabel: '[-5%, -10%, -15%]', strength: 'mild', levels: [{ drop: -0.05, bonus: 0.05 }, { drop: -0.1, bonus: 0.1 }, { drop: -0.15, bonus: 0.2 }] },
    curve_aggressive: { thresholdLabel: '[-5%, -10%, -15%]', strength: 'aggressive', levels: [{ drop: -0.05, bonus: 0.1 }, { drop: -0.1, bonus: 0.25 }, { drop: -0.15, bonus: 0.4 }] },
  };
  const frozenParametersMatch = SCENARIO_NAMES.every((scenario) => JSON.stringify(frozenDefinitions[scenario]) === JSON.stringify({ type: 'curve', thresholdGroup: 'g2', ...definitions[scenario] }));
  const validationChecks = {
    stage3ResultPresent: stage3Result.researchVersion === 'btc-v3-exposure-curve-v3',
    clusterSetReproduced: clusterIds.size === stage3ClusterIds.size && [...stage3ClusterIds].every((id) => clusterIds.has(id)),
    frozenParametersMatch,
    onlyPreCrashInputs: rows.every((row) => Number.isFinite(row.featureAsOfTime) && row.featureAsOfTime < Date.parse(`${row.startDate}T00:00:00Z`)),
    noFundingImputation: rows.every((row) => row.fundingStatus7d !== 'imputed'),
  };
  const scenarios = SCENARIO_NAMES.map((scenario) => {
    const scenarioRows = rows.filter((row) => row.scenario === scenario);
    const comparisons = featureComparisons(scenarioRows);
    const summary = yearRegimeSummary(scenarioRows);
    const walkForward = walkForwardRules(scenarioRows);
    return {
      scenario,
      rows: scenarioRows,
      featureComparisons: comparisons,
      yearSummary: summary,
      walkForwardRules: walkForward,
    };
  });
  const regimeDifferences = regimeComparison(yearRegimeSummary(rows.filter((row) => row.scenario === 'curve_mild')));
  const classification = finalClassification(scenarios.map((scenario) => ({ scenario: scenario.scenario, rules: scenario.walkForwardRules })), validationChecks);
  const result = {
    generatedAt: new Date().toISOString(),
    researchVersion: 'btc-v3-exposure-curve-v4',
    strategyVersion: CONFIG.version,
    researchOnly: true,
    productionChanged: false,
    mainModified: false,
    productionStrategyModified: false,
    deployed: false,
    dataWindow: {
      requestedStartDate: dateOnly(PERIOD.startTime),
      requestedEndDate: dateOnly(PERIOD.endTime),
      actualEndDate: dateOnly(period.endTime),
    },
    dataQuality: stage3Result.dataQuality,
    fundingCoverage: stage3Result.fundingCoverage,
    frozenStage3: {
      resultPath: 'research/btc-v3-exposure-curve-v3-result.json',
      researchVersion: stage3Result.researchVersion,
      finalClassification: stage3Result.finalClassification.classification,
      curveDefinitions: frozenDefinitions,
    },
    assumptions: {
      featureTiming: 'All market features use the last fully closed BTCUSD Index daily observation before cluster start; Funding uses only events with fundingTime before cluster start.',
      crashClusterSource: 'Stage 3 frozen crash clusters, reproduced from the same 1H execution/index data.',
      outcomeSource: 'Stage 3 frozen dynamic leave-one-crash-out marginal ending BTC.',
      hypothesisFormation: 'Candidate predicates and thresholds are fixed before the run. 2024 chooses condition/other by mean incremental BTC only; 2025 and 2026 are frozen validation.',
      continuousThresholds: {
        baselineExposure: '1.0, an existing V3 base target boundary',
        rv30: CONFIG.targetAnnualVol,
        drawdown365: CONFIG.cheapDrawdown,
        trendScore: '<=1 versus >1, fixed score semantics',
      },
      featureDefinitions: FEATURE_DEFINITIONS,
      ruleSpecs: RULE_SPECS.map((rule) => ({ name: rule.name, label: rule.label, feature: rule.key })),
    },
    validationChecks,
    clusterCount: stage3Result.crashClusters.length,
    regimeComparison: regimeDifferences,
    scenarios: scenarios.map((scenario) => ({
      scenario: scenario.scenario,
      featureComparisons: scenario.featureComparisons,
      yearSummary: scenario.yearSummary,
      walkForwardRules: scenario.walkForwardRules,
      rows: scenario.rows,
    })),
    finalClassification: classification,
    outputFiles: {
      result: 'research/btc-v3-exposure-curve-v4-result.json',
      report: 'research/btc-v3-exposure-curve-v4-report.md',
      clusters: 'research/btc-v3-exposure-curve-v4-clusters.csv',
    },
  };
  const researchDir = path.join(__dirname, '..', 'research');
  const resultPath = path.join(researchDir, 'btc-v3-exposure-curve-v4-result.json');
  const reportPath = path.join(researchDir, 'btc-v3-exposure-curve-v4-report.md');
  const clustersPath = path.join(researchDir, 'btc-v3-exposure-curve-v4-clusters.csv');
  fs.mkdirSync(researchDir, { recursive: true });
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  fs.writeFileSync(reportPath, renderReport(result));
  fs.writeFileSync(clustersPath, renderCsv(rows));
  console.log(JSON.stringify({
    resultPath,
    reportPath,
    clustersPath,
    classification: classification.classification,
    clusterCount: stage3Result.crashClusters.length,
    rows: rows.length,
    validationChecks,
    stableRules: scenarios.map((scenario) => ({ scenario: scenario.scenario, rules: scenario.walkForwardRules.filter((rule) => rule.stableAcross2025And2026).map((rule) => rule.name) })),
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
  });
}

module.exports = {
  FEATURE_DEFINITIONS,
  RULE_SPECS,
  featureSnapshot,
  fundingFeatures,
  featureComparisons,
  yearRegimeSummary,
  walkForwardRules,
  finalClassification,
  renderCsv,
  renderReport,
};
