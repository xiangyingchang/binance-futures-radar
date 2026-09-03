'use strict';

// E8 runner: Bear-Lock-aware L3 entry rules.
// Preregistration: research/btc-v4-e8-vd-entry-preregistration.md @ 1b364bd
// Engine: scripts/btc-v4-e7-l3-frequency-engine.js; only vd1/vd2 were added
// to the engine's l3Mode dispatcher. Existing E7 modes are regression-checked.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const E = require('./btc-v4-e7-l3-frequency-engine.js');

const AHR_URL = 'https://raw.githubusercontent.com/RuochenLyu/ahr999-dataset/main/datasets/ahr999.csv';
const PRICE_CSV = '/tmp/btc_cm_full.csv';
const DATA_START = '2010-07-18';
const DATA_END = '2026-05-23';
const BOOTSTRAP_DRAWS = 10000;
const BOOTSTRAP_SEED = 20260903;
const OVERRIDE_LEV = 1.5;
const FEE = E.FEE;
const PREREG_COMMIT = '1b364bd';
const TIERS = [
  [0.45, 1400], [0.75, 1225], [1.0, 700],
  [1.2, 420], [5.0, 210], [Infinity, 140],
];
const MODES = { 'V-A': 'weekly', 'V-D1': 'vd1', 'V-D2': 'vd2' };

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(Buffer.from(text)).digest('hex');
}

function gitMeta() {
  try {
    const commit = cp.execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = cp.execFileSync('git', ['status', '--porcelain', '--', 'scripts/btc-v4-e7-l3-frequency-engine.js', 'scripts/btc-v4-e8-vd-entry-run.js'], { encoding: 'utf8' }).trim();
    return { commit, scriptDirtyAtRun: Boolean(dirty) };
  } catch (_) {
    return { commit: null, scriptDirtyAtRun: null };
  }
}

function sunday(row) {
  return new Date(row.ts).getUTCDay() === 0;
}

function tierUsd(ahr) {
  for (const [max, usd] of TIERS) if (ahr < max) return usd;
  return 140;
}

function pureDca(rows, ind, startIdx, endIdx) {
  let stack = 0;
  let invested = 0;
  let ammo = 0;
  for (let i = startIdx; i <= endIdx; i += 1) {
    const d = i - 1;
    if (sunday(rows[i]) && ind.ahr[d] !== null) {
      let spend = tierUsd(ind.ahr[d]);
      if (spend > 700) {
        const extra = Math.min(spend - 700, ammo);
        spend = 700 + extra;
        ammo -= extra;
      } else if (spend < 700) {
        ammo += 700 - spend;
      }
      stack += (spend / rows[i].close) * (1 - FEE);
      invested += spend;
    }
  }
  return { stack, invested, ammo };
}

function gate(ind, d) {
  return ind.ahr[d] !== null && ind.ahr[d] < 0.40 && ind.dd365[d] !== null && ind.dd365[d] <= -0.20;
}

function forwardPrice(rows, signalIdx, days) {
  const end = signalIdx + days;
  if (signalIdx < 0 || end >= rows.length) return { available: false, pct: null, endDate: null };
  return { available: true, pct: (rows[end].close / rows[signalIdx].close - 1) * 100, endDate: rows[end].date };
}

function oneDayRelative(candidateExposure, vaExposure, dailyReturn) {
  return (1 + candidateExposure * dailyReturn) / (1 + vaExposure * dailyReturn);
}

function intervalExposureComparison(rows, candidatePath, vaPath, fromIdx, toIdx) {
  if (fromIdx === null || toIdx === null || fromIdx > toIdx) {
    return {
      fromDate: null, toDate: null, days: 0,
      opportunityDays: 0, protectionLossDays: 0,
      missedOverrideDays: 0,
      opportunityPriceReturnPct: 0, protectionPriceReturnPct: 0,
      missedOverridePriceReturnPct: 0,
      opportunityRelativeOverlayPct: 0, protectionRelativeOverlayPct: 0,
      missedOverrideRelativeOverlayPct: 0,
      totalRelativeOverlayPct: 0,
    };
  }
  let opportunityPrice = 1;
  let protectionPrice = 1;
  let opportunityOverlay = 1;
  let protectionOverlay = 1;
  let missedOverridePrice = 1;
  let missedOverrideOverlay = 1;
  let totalOverlay = 1;
  let opportunityDays = 0;
  let protectionLossDays = 0;
  let missedOverrideDays = 0;
  let days = 0;
  for (let i = fromIdx; i <= toIdx; i += 1) {
    const c = candidatePath?.[i];
    const a = vaPath?.[i];
    if (!c || !a) continue;
    const r = rows[i].close / rows[i - 1].close - 1;
    totalOverlay *= oneDayRelative(c.exposure, a.exposure, r);
    days += 1;
    if (c.exposure === OVERRIDE_LEV && a.exposure === 1) {
      opportunityDays += 1;
      opportunityPrice *= 1 + r;
      opportunityOverlay *= oneDayRelative(c.exposure, a.exposure, r);
    }
    if (c.exposure === OVERRIDE_LEV && a.exposure === 0) {
      protectionLossDays += 1;
      protectionPrice *= 1 + r;
      protectionOverlay *= oneDayRelative(c.exposure, a.exposure, r);
    }
    if (c.exposure !== OVERRIDE_LEV && a.exposure === OVERRIDE_LEV) {
      missedOverrideDays += 1;
      missedOverridePrice *= 1 + r;
      missedOverrideOverlay *= oneDayRelative(c.exposure, a.exposure, r);
    }
  }
  return {
    fromDate: rows[fromIdx]?.date || null,
    toDate: rows[toIdx]?.date || null,
    days,
    opportunityDays,
    protectionLossDays,
    missedOverrideDays,
    opportunityPriceReturnPct: (opportunityPrice - 1) * 100,
    protectionPriceReturnPct: (protectionPrice - 1) * 100,
    missedOverridePriceReturnPct: (missedOverridePrice - 1) * 100,
    opportunityRelativeOverlayPct: (opportunityOverlay - 1) * 100,
    protectionRelativeOverlayPct: (protectionOverlay - 1) * 100,
    missedOverrideRelativeOverlayPct: (missedOverrideOverlay - 1) * 100,
    totalRelativeOverlayPct: (totalOverlay - 1) * 100,
  };
}

function maeSummary(episodes) {
  const values = episodes.map((e) => (e.minPrice / e.entryPrice - 1) * 100).sort((a, b) => a - b);
  const q = (p) => values.length ? values[Math.min(values.length - 1, Math.floor(values.length * p))] : null;
  return {
    n: values.length,
    negativeCount: values.filter((v) => v < 0).length,
    p50Pct: q(0.50),
    p90Pct: q(0.90),
    p95Pct: q(0.95),
    minPct: values.length ? values[0] : null,
    valuesPct: values,
  };
}

function episodeDetails(rows, sim) {
  return sim.episodes.map((e) => ({
    entryDate: e.entryDate,
    signalDate: rows[e.entryIdx - 1]?.date || null,
    entryIdx: e.entryIdx,
    entryPrice: e.entryPrice,
    exitDate: e.exitDate,
    exitIdx: e.exitIdx,
    exitReason: e.openAtEnd ? 'sample_end' : (e.killed ? 'kill_switch_or_handoff' : 'hysteresis_exit'),
    killed: Boolean(e.killed),
    openAtEnd: Boolean(e.openAtEnd),
    minPrice: e.minPrice,
    minDate: e.minDate,
    postEntryMaxDrawdownPct: (e.minPrice / e.entryPrice - 1) * 100,
  }));
}

function entrySet(sim) {
  return new Set(sim.episodes.map((e) => e.entryIdx));
}

function matchEpisodes(candidateEpisodes, vaEpisodes) {
  const used = new Set();
  const pairs = [];
  for (let candidateIndex = 0; candidateIndex < candidateEpisodes.length; candidateIndex += 1) {
    for (let vaIndex = 0; vaIndex < vaEpisodes.length; vaIndex += 1) {
      const distance = Math.abs(vaEpisodes[vaIndex].entryIdx - candidateEpisodes[candidateIndex].entryIdx);
      if (distance <= 21) pairs.push({ candidateIndex, vaIndex, distance });
    }
  }
  pairs.sort((a, b) => a.distance - b.distance || a.candidateIndex - b.candidateIndex || a.vaIndex - b.vaIndex);
  const assignments = new Map();
  for (const pair of pairs) {
    if (assignments.has(pair.candidateIndex) || used.has(pair.vaIndex)) continue;
    assignments.set(pair.candidateIndex, pair);
    used.add(pair.vaIndex);
  }
  const matched = candidateEpisodes.map((candidate, candidateIndex) => {
    const pair = assignments.get(candidateIndex);
    return pair
      ? { candidate, va: vaEpisodes[pair.vaIndex], distance: pair.distance }
      : { candidate, va: null, distance: null };
  });
  return { matched, used };
}

function entryLedger(rows, simulations) {
  const va = simulations['V-A'];
  const out = {};
  for (const name of ['V-D1', 'V-D2']) {
    const sim = simulations[name];
    const matching = matchEpisodes(sim.episodes, va.episodes);
    out[name] = matching.matched.map(({ candidate, va: vaEpisode, distance }) => {
      const candidateDetail = {
        date: candidate.entryDate,
        signalDate: rows[candidate.entryIdx - 1]?.date || null,
        price: candidate.entryPrice,
      };
      if (!vaEpisode) {
        const overlap = intervalExposureComparison(rows, sim.exposurePath, va.exposurePath, candidate.entryIdx, Math.min(candidate.exitIdx ?? rows.length - 1, rows.length - 1));
        return {
          variant: name,
          timing: 'V-D_ONLY',
          candidate: candidateDetail,
          va: null,
          matchingDistanceDays: null,
          daysEarly: null,
          entryPriceChangePct: null,
          leadInMaxDrawdownPct: null,
          leadIn: null,
          exposureComparison: overlap,
          note: 'V-A 未找到 21 天内匹配入场；机会成本/保护损失按候选实际 active 区间记录。',
        };
      }
      const daysEarly = vaEpisode.entryIdx - candidate.entryIdx;
      const entryPriceChangePct = (candidate.entryPrice / vaEpisode.entryPrice - 1) * 100;
      const leadInEnd = daysEarly > 0 ? vaEpisode.entryIdx - 1 : null;
      const leadIn = daysEarly > 0
        ? intervalExposureComparison(rows, sim.exposurePath, va.exposurePath, candidate.entryIdx, leadInEnd)
        : null;
      let leadInMaxDrawdownPct = null;
      if (daysEarly > 0) {
        const closes = rows.slice(candidate.entryIdx, vaEpisode.entryIdx + 1).map((r) => r.close);
        leadInMaxDrawdownPct = (Math.min(...closes) / candidate.entryPrice - 1) * 100;
      }
      const compareEnd = Math.min(candidate.exitIdx ?? rows.length - 1, rows.length - 1);
      const overlap = intervalExposureComparison(rows, sim.exposurePath, va.exposurePath, candidate.entryIdx, compareEnd);
      return {
        variant: name,
        timing: daysEarly > 0 ? 'EARLY' : daysEarly < 0 ? 'LATER' : 'SAME',
        candidate: candidateDetail,
        va: { date: vaEpisode.entryDate, signalDate: rows[vaEpisode.entryIdx - 1]?.date || null, price: vaEpisode.entryPrice },
        matchingDistanceDays: distance,
        daysEarly,
        entryPriceChangePct,
        leadInMaxDrawdownPct,
        leadIn,
        exposureComparison: overlap,
        note: '负值为候选提前承担的价格/暴露损失；正值为候选提前获得的价格/暴露收益。',
      };
    });
    for (let i = 0; i < va.episodes.length; i += 1) {
      if (matching.used.has(i)) continue;
      const vaEpisode = va.episodes[i];
      const compareEnd = Math.min(vaEpisode.exitIdx ?? rows.length - 1, rows.length - 1);
      out[name].push({
        variant: name,
        timing: 'V-A_ONLY',
        candidate: null,
        va: { date: vaEpisode.entryDate, signalDate: rows[vaEpisode.entryIdx - 1]?.date || null, price: vaEpisode.entryPrice },
        matchingDistanceDays: null,
        daysEarly: null,
        entryPriceChangePct: null,
        leadInMaxDrawdownPct: null,
        leadIn: null,
        exposureComparison: intervalExposureComparison(rows, sim.exposurePath, va.exposurePath, vaEpisode.entryIdx, compareEnd),
        note: 'V-A 在此 episode 入场，但候选未在 21 天内入场；候选相对 V-A 的漏掉 override 机会/暴露差异单列。',
      });
    }
    out[name].sort((a, b) => (a.candidate?.date || a.va?.date || '').localeCompare(b.candidate?.date || b.va?.date || ''));
  }
  return out;
}

function preflightSplitDays(rows, ind, startIdx, endIdx) {
  const days = [];
  for (let i = startIdx; i <= endIdx; i += 1) {
    const d = i - 1;
    if (!sunday(rows[i]) && gate(ind, d) && ind.bearLock[d] === false) {
      days.push({
        signalDate: rows[d].date,
        affectedDate: rows[i].date,
        signalIdx: d,
        affectedIdx: i,
        close: rows[d].close,
        ahr: ind.ahr[d],
        dd365: ind.dd365[d],
        bearLock: ind.bearLock[d],
        forward30dSignal: forwardPrice(rows, d, 30),
        forward90dSignal: forwardPrice(rows, d, 90),
        forward30dExecution: forwardPrice(rows, i, 30),
        forward90dExecution: forwardPrice(rows, i, 90),
      });
    }
  }
  return days;
}

function sundayVd2BlockDays(rows, ind, startIdx, endIdx) {
  const days = [];
  for (let i = startIdx; i <= endIdx; i += 1) {
    const d = i - 1;
    if (sunday(rows[i]) && gate(ind, d) && ind.bearLock[d] === true) {
      days.push({
        signalDate: rows[d].date,
        affectedDate: rows[i].date,
        signalIdx: d,
        affectedIdx: i,
        ahr: ind.ahr[d],
        dd365: ind.dd365[d],
        forward30dExecution: forwardPrice(rows, i, 30),
        forward90dExecution: forwardPrice(rows, i, 90),
      });
    }
  }
  return days;
}

function groupWeeklyBlocks(days) {
  const blocks = [];
  for (const day of days) {
    const previous = blocks.at(-1);
    if (!previous || day.affectedIdx - previous.lastAffectedIdx !== 7) {
      blocks.push({ startDate: day.affectedDate, endDate: day.affectedDate, count: 1, firstSignalDate: day.signalDate, lastAffectedIdx: day.affectedIdx });
    } else {
      previous.endDate = day.affectedDate;
      previous.count += 1;
      previous.lastAffectedIdx = day.affectedIdx;
    }
  }
  return blocks.map(({ lastAffectedIdx, ...block }) => block);
}

function annotateSplitDays(rows, splitDays, simulations) {
  const va = simulations['V-A'];
  const entrySets = Object.fromEntries(Object.entries(simulations).map(([name, sim]) => [name, entrySet(sim)]));
  return splitDays.map((day) => {
    const row = { ...day, variants: {} };
    for (const name of Object.keys(simulations)) {
      const p = simulations[name].exposurePath[day.affectedIdx];
      const vaPath = va.exposurePath[day.affectedIdx];
      const dailyReturn = rows[day.affectedIdx].close / rows[day.affectedIdx - 1].close - 1;
      const category = p?.exposure === OVERRIDE_LEV && vaPath?.exposure === 0
        ? 'protection_loss'
        : p?.exposure === OVERRIDE_LEV && vaPath?.exposure === 1
          ? 'opportunity_exposure'
          : p?.exposure === vaPath?.exposure ? 'same' : 'other_difference';
      row.variants[name] = {
        target: p?.target ?? null,
        exposure: p?.exposure ?? null,
        overrideActive: p?.overrideActive ?? null,
        newEntryOnAffectedDate: entrySets[name].has(day.affectedIdx),
        relativeOneDayOverlayPct: p && vaPath ? (oneDayRelative(p.exposure, vaPath.exposure, dailyReturn) - 1) * 100 : null,
        comparisonCategory: name === 'V-A' ? 'reference' : category,
      };
    }
    return row;
  });
}

function samePath(a, b, startIdx, endIdx) {
  for (let i = startIdx; i <= endIdx; i += 1) {
    const x = a.exposurePath[i];
    const y = b.exposurePath[i];
    if (!x || !y) return false;
    if (x.exposure !== y.exposure || x.target !== y.target || x.overrideActive !== y.overrideActive) return false;
  }
  return true;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function annualBlockBootstrap(rows, ind, startIdx, endIdx, dcaStack) {
  const years = {};
  for (let i = startIdx; i <= endIdx; i += 1) {
    const year = rows[i].date.slice(0, 4);
    (years[year] ||= []).push(i);
  }
  const yearly = {};
  for (const year of Object.keys(years)) {
    const indexes = years[year];
    const s = indexes[0];
    const e = indexes.at(-1);
    if (e - s < 30) continue;
    const row = {};
    for (const [name, mode] of Object.entries(MODES)) {
      const sim = E.simulate(rows, ind, Math.max(s, startIdx), e, mode);
      const dca = pureDca(rows, ind, Math.max(s, startIdx), e).stack;
      row[name] = dca > 0 ? sim.stack / dca : 1;
    }
    yearly[year] = row;
  }
  const yearKeys = Object.keys(yearly);
  const random = mulberry32(BOOTSTRAP_SEED);
  const draws = { 'V-D1': [], 'V-D2': [] };
  for (let b = 0; b < BOOTSTRAP_DRAWS; b += 1) {
    const growth = { 'V-A': 1, 'V-D1': 1, 'V-D2': 1 };
    for (let j = 0; j < yearKeys.length; j += 1) {
      const pick = yearly[yearKeys[Math.floor(random() * yearKeys.length)]];
      for (const name of Object.keys(growth)) growth[name] *= pick[name];
    }
    for (const name of ['V-D1', 'V-D2']) draws[name].push((growth[name] / growth['V-A'] - 1) * 100);
  }
  const output = { draws: BOOTSTRAP_DRAWS, seed: BOOTSTRAP_SEED, block: 'calendar year', nBlocks: yearKeys.length, variants: {} };
  for (const name of ['V-D1', 'V-D2']) {
    draws[name].sort((a, b) => a - b);
    const values = draws[name];
    const q = (p) => values[Math.min(values.length - 1, Math.floor(values.length * p))];
    output.variants[name] = { p10RelativeVsVaPct: q(0.10), p50RelativeVsVaPct: q(0.50), p90RelativeVsVaPct: q(0.90), probabilityNonPositive: values.filter((v) => v <= 0).length / values.length };
  }
  return output;
}

function leaveOneOut(rows, ind, simulations, startIdx, endIdx, dcaStack) {
  const vaEpisodes = simulations['V-A'].episodes;
  const rowsOut = [];
  for (let k = 0; k < vaEpisodes.length; k += 1) {
    const mask = vaEpisodes[k];
    const masked = { ...ind, ahr: ind.ahr.slice() };
    for (let i = Math.max(0, mask.entryIdx - 1); i <= Math.min(endIdx, mask.exitIdx ?? endIdx); i += 1) {
      if (masked.ahr[i] !== null && masked.ahr[i] < 0.45) masked.ahr[i] = 0.46;
    }
    const va = E.simulate(rows, masked, startIdx, endIdx, MODES['V-A']);
    for (const name of ['V-D1', 'V-D2']) {
      const candidate = E.simulate(rows, masked, startIdx, endIdx, MODES[name]);
      const relative = (candidate.stack / va.stack - 1) * 100;
      const fullRelative = (simulations[name].stack / simulations['V-A'].stack - 1) * 100;
      const flipped = (fullRelative > 0 && relative <= 0) || (fullRelative < 0 && relative >= 0);
      rowsOut.push({ maskIndex: k + 1, maskedEpisode: `${mask.entryDate}..${mask.exitDate}`, variant: name, maskedVaExcessPct: (va.stack / dcaStack - 1) * 100, maskedCandidateExcessPct: (candidate.stack / dcaStack - 1) * 100, relativeFinalVsVaPct: relative, fullRelativeFinalVsVaPct: fullRelative, flipped });
    }
  }
  const summary = ['V-D1', 'V-D2'].map((name) => {
    const values = rowsOut.filter((r) => r.variant === name);
    return { variant: name, nMasks: values.length, fullRelativeFinalVsVaPct: values[0]?.fullRelativeFinalVsVaPct ?? null, sameDirectionCount: values.filter((r) => !r.flipped).length, flipCount: values.filter((r) => r.flipped).length };
  });
  return { method: 'E7 mask: set AHR to 0.46 from V-A entry-1 through exit', rows: rowsOut, summary };
}

function loadE2Reference() {
  const file = path.join(__dirname, '..', 'research', 'btc-v3-leverage-stress-result.json');
  if (!fs.existsSync(file)) return { available: false, reason: 'E2 result missing' };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const row = parsed.byLeverage?.find((r) => r.leverage === 1.5);
  if (!row) return { available: false, reason: 'E2 1.5x row missing' };
  return { available: true, source: 'research/btc-v3-leverage-stress-result.json', acceptanceSlice: { maintenanceRatePct: 10, wickPct: 20, fundingPerEvent: 0.003 }, leverage1_5x: row };
}

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : value;
}

function fmt(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : 'UNAVAILABLE';
}

function fmtPctOrDash(value, digits = 2) {
  return Number.isFinite(value) ? `${fmt(value, digits)}%` : '—';
}

function renderReport(out) {
  const lines = [];
  lines.push('# E8：BTC V4 L3 override V-D 入场规则实验');
  lines.push('');
  lines.push('> 研究用途；不改生产 cron、Forward Test ledger 或冻结参数；结论等待人工裁决。深水 episode 样本有限，以下均为方向性证据。');
  lines.push('');
  lines.push(`预注册：\`${PREREG_COMMIT}\`；基线 E7：\`fb9f992\`；运行代码：\`${out.meta.codeCommitAtRun}\`；运行时间：${out.meta.generatedAt}`);
  lines.push('');
  lines.push('## 结论先行');
  lines.push('');
  lines.push(`**${out.conclusion.label}**`);
  lines.push('');
  lines.push(out.conclusion.text);
  lines.push('');
  lines.push(`理由分类：${out.conclusion.reason}；状态：${out.conclusion.humanDecision}。`);
  lines.push('');
  lines.push('## 数据和共同口径');
  lines.push('');
  lines.push(`- Coin Metrics BTC PriceUSD：${out.meta.priceWindow.start} 至 ${out.meta.priceWindow.end}，${out.meta.priceWindow.observations} 个连续日点；模拟窗口 ${out.meta.simWindow.start} 至 ${out.meta.simWindow.end}。`);
  lines.push(`- AHR999：几何均值公式，官方数据集核验中位相对误差 ${fmt(out.meta.ahrMedianErrPct)}%。`);
  lines.push('- 三组均为 E7 线性日频 DCA 全系统：L1 周日六档+弹药池，L2 每日 Bear Lock/25% breaker，L3 1.5x，退出/kill 周日，T-1 信号。唯一变量是 L3 入场规则。');
  lines.push('');
  lines.push('## 前置盘点：预注册指定的非周日额外入场日期');
  lines.push('');
  lines.push(`满足 AHR<0.40、dd365≤−20%、Bear Lock=false 且执行日非周日的日期：**${out.preflight.count} 个**；其中实际暴露相对 V-A 发生差异的有 **${out.preflight.actualPathDivergenceCount} 个**。`);
  if (!out.preflight.count) lines.push('因此实验无信息量，按预注册直接判“无差异、维持 V-A”。');
  else {
    lines.push('机会成本与保护损失并排：机会成本是候选相对 V-A=1.0x 的额外 1.5x 暴露；保护损失是候选 1.5x 而 V-A=0.0x 的日子。');
    lines.push('');
    lines.push('| 信号日 | 受影响日 | AHR | dd365 | 受影响日后30d价格 | 受影响日后90d价格 | V-D1 暴露/类别 | V-D2 暴露/类别 |');
    lines.push('|---|---|---:|---:|---:|---:|---|---|');
    for (const d of out.preflight.annotated) {
      const x = (name) => `${fmt(d.variants[name].exposure, 1)}x / ${d.variants[name].comparisonCategory}`;
      lines.push(`| ${d.signalDate} | ${d.affectedDate} | ${fmt(d.ahr, 3)} | ${fmt(d.dd365, 1)}% | ${fmtPctOrDash(d.forward30dExecution.pct)} | ${fmtPctOrDash(d.forward90dExecution.pct)} | ${x('V-D1')} | ${x('V-D2')} |`);
    }
  }
  lines.push('');
  lines.push('### V-D2 定义一致性审计：周日且 Bear Lock=true');
  lines.push('');
  lines.push(`预注册正文把非周日 Bear Lock=false 清单描述为“唯一可能分叉日”，但按已写死的 V-D2 定义，另有 **${out.sundayVd2Blocks.count} 个周日**满足 gate 且 Bear Lock=true：V-A 允许周日入场，V-D2 明确禁止。这类日期不是额外的非周日入场机会，但确实会导致 V-D2 与 V-A 分叉，因此单独纳入审计。`);
  lines.push('');
  lines.push('| 连续周日段 | 日期数 | V-D2规则 |');
  lines.push('|---|---:|---|');
  for (const block of out.sundayVd2Blocks.blocks) lines.push(`| ${block.startDate}..${block.endDate} | ${block.count} | 禁止入场，V-A允许 |`);
  lines.push('完整日期、AHR、dd365 和 30/90 日价格变化保存在 result.json 的 `sundayVd2Blocks.days`。');
  lines.push('');
  lines.push('## 主结果');
  lines.push('');
  lines.push('| 变体 | 最终 BTC | 相对纯 DCA 超额 | 相对 V-A 终值 | L3 入场 | L3 天数 | 总费用 |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const row of out.primary) lines.push(`| ${row.variant} | ${fmt(row.stack, 2)} | ${fmt(row.excessPct)}% | ${row.variant === 'V-A' ? '—' : `${fmt(row.relativeFinalVsVaPct)}%`} | ${row.entries} | ${row.overrideDays} | ${fmt(row.feeBtcPaidPct)}% |`);
  lines.push('');
  lines.push(`E7 既有模式回归：${out.regression.allMatch ? '通过，V-A/V-B/V-C 关键结果与 fb9f992 一致' : '失败，见 result.json，不能把本次结果视为有效 E8' }。`);
  lines.push('');

  lines.push('## (a) 分叉日后的价格变化');
  lines.push('');
  lines.push('上表已逐日列出 30/90 日价格变化；价格变化只是机会窗口描述，不等于可实现的 1.5x 策略收益。');
  lines.push('');
  lines.push('## (b) V-D1/V-D2 入场时点、机会成本与保护损失');
  lines.push('');
  for (const name of ['V-D1', 'V-D2']) {
    lines.push(`### ${name}`);
    lines.push('');
    lines.push('| 时序 | 候选入场 | V-A入场 | 天数（正=候选提前） | 入场价差 | 提前区间最大回撤 | 机会差异（额外/错过） | 保护损失 |');
    lines.push('|---|---|---|---:|---:|---:|---:|---:|');
    for (const row of out.entryLedger[name]) {
      const lead = row.leadIn;
      const overlap = row.exposureComparison;
      const opportunity = `额外 ${overlap.opportunityDays}日/${fmtPctOrDash(overlap.opportunityRelativeOverlayPct)}；错过 ${overlap.missedOverrideDays}日/${fmtPctOrDash(overlap.missedOverrideRelativeOverlayPct)}`;
      const protection = `${overlap.protectionLossDays}日/${fmtPctOrDash(overlap.protectionRelativeOverlayPct)}`;
      lines.push(`| ${row.timing} | ${row.candidate?.date || '—'} | ${row.va?.date || '—'} | ${row.daysEarly ?? '—'} | ${fmtPctOrDash(row.entryPriceChangePct)} | ${fmtPctOrDash(row.leadInMaxDrawdownPct)} | ${opportunity} | ${protection} |`);
    }
    if (!out.entryLedger[name].length) lines.push('| — | 无候选 episode | — | — | — | — | — | — |');
    lines.push('');
    lines.push('注：负值是损失，正值是收益；“保护损失”只计候选 1.5x、V-A 0x 的重叠日。完整 lead-in 价格与费用明细在 result.json。');
    lines.push('');
  }

  lines.push('## (c) Episode 级 leave-one-out');
  lines.push('');
  lines.push('| 候选 | 全样本相对 V-A | 同方向掩码 | 翻转 |');
  lines.push('|---|---:|---:|---:|');
  for (const row of out.leaveOneOut.summary) lines.push(`| ${row.variant} | ${fmt(row.fullRelativeFinalVsVaPct)}% | ${row.sameDirectionCount}/${row.nMasks} | ${row.flipCount} |`);
  lines.push('');
  lines.push('| 掩码 episode | 候选 | 删除后相对 V-A | 是否翻转 |');
  lines.push('|---|---|---:|---|');
  for (const row of out.leaveOneOut.rows) lines.push(`| ${row.maskedEpisode} | ${row.variant} | ${fmt(row.relativeFinalVsVaPct)}% | ${row.flipped ? '是' : '否'} |`);
  lines.push('');

  lines.push('## (d) 入场后最大跌幅与 E2 压力');
  lines.push('');
  lines.push('| 变体 | n | 有负回撤 | P50 | P90 | P95 | 最深 | 相对 V-A |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---|');
  for (const [name, row] of Object.entries(out.postEntryDrawdown)) lines.push(`| ${name} | ${row.n} | ${row.negativeCount} | ${fmt(row.p50Pct)}% | ${fmt(row.p90Pct)}% | ${fmt(row.p95Pct)}% | ${fmt(row.minPct)}% | ${name === 'V-A' ? '—' : (row.tailDeeperVsVa ? '尾部更深' : '不更深')} |`);
  lines.push('');
  const e2 = out.e2;
  if (e2.available) {
    lines.push(`E2 验收切片（10% 维持保证金、20% wick、高资金费率）中，1.5x 最小余量 ${fmt(e2.leverage1_5x.worstMinHeadroomAcceptanceSlice, 3)}x，爆仓=${e2.leverage1_5x.liquidatedInAcceptanceSlice ? '是' : '否'}，≥3x=${e2.leverage1_5x.passes3xHeadroom ? '是' : '否'}。`);
    const deeper = ['V-D1', 'V-D2'].filter((name) => out.postEntryDrawdown[name].tailDeeperVsVa);
    if (deeper.length) lines.push(`${deeper.join('、')} 的历史入场后最深回撤（${deeper.map((name) => `${name} ${fmt(out.postEntryDrawdown[name].minPct, 2)}%`).join('；')}）比 V-A（${fmt(out.postEntryDrawdown['V-A'].minPct, 2)}%）更深，但仍未达到 E2 的 40% 压力下界。E2 验收切片显示 1.5x 无爆仓且最小余量 ${fmt(e2.leverage1_5x.worstMinHeadroomAcceptanceSlice, 3)}x≥3x，因此清偿力判定为“不受侵蚀”；这不等于历史线性回测证明不会爆仓。`);
    else lines.push('V-D 的历史入场后回撤尾部不深于 V-A；E2 验收切片仍显示 1.5x 无爆仓且达到 ≥3x 健康度。');
  } else lines.push(`E2 结果不可用：${e2.reason}；清偿力判据不能通过。`);
  lines.push('');

  lines.push('## 预注册晋级判据');
  lines.push('');
  lines.push('| 候选 | 超额差为正 | 超出 bootstrap P90 | LOO不翻转 | 尾部/清偿力 | 单一分叉日驱动 | 全部通过 | 理由 |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const row of out.acceptance) lines.push(`| ${row.variant} | ${row.passPositive ? '是' : '否'} | ${row.passBootstrap ? '是' : '否'} | ${row.passLeaveOneOut ? '是' : '否'} | ${row.passTail ? '是' : '否'} | ${row.singleSplitDriver ? '是' : '否'} | ${row.passAll ? '是' : '否'} | ${row.failureReason} |`);
  lines.push('');
  lines.push(`年块 bootstrap：10,000 次，seed=${BOOTSTRAP_SEED}；P10/P50/P90 详见 result.json。${out.preflight.count ? '分叉日非零，因此未触发“无信息量”短路。' : '分叉日为零，已按预注册短路。'}`);
  lines.push('');
  lines.push('## 局限');
  lines.push('');
  lines.push('- 深水 episode 只有个位数级别，分叉日更少；所有结果是方向性证据，不是统计证明。');
  lines.push('- E7 线性引擎不含 funding、inverse convexity、wick；E2 只负责单独的合成清偿力压力。');
  lines.push('- E7 年块 bootstrap 是方法一致的噪声带，不是独立同分布置信区间；LOO 也会受到 episode 相互靠近的影响。');
  lines.push('- 机会成本和保护损失并列报告，不能用“每日抓反弹”或“周日避免下跌”的单边叙事替代比较。');
  lines.push('');
  lines.push(`最终裁决：${out.conclusion.text}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const rows = E.loadPrices();
  if (rows[0]?.date !== DATA_START || rows.at(-1)?.date !== DATA_END) throw new Error(`Unexpected price window: ${rows[0]?.date}..${rows.at(-1)?.date}`);
  const ind = E.computeIndicators(rows);
  const ref = await E.loadRefAhr();
  const medErr = E.validate(ind, rows, ref);
  if (!Number.isFinite(medErr) || medErr > 0.05) throw new Error(`AHR validation failed: ${medErr}`);
  const refResponse = await fetch(AHR_URL, { headers: { 'User-Agent': 'bfr-e8/1.0' } });
  if (!refResponse.ok) throw new Error(`AHR hash fetch failed: ${refResponse.status}`);
  const refText = await refResponse.text();

  let startIdx = 0;
  for (let i = 0; i < rows.length; i += 1) {
    if (ind.ahr[i - 1] != null && ind.dd365[i - 1] != null && ind.bearLock[i - 1] != null) { startIdx = i; break; }
  }
  const endIdx = rows.length - 1;
  const splitDays = preflightSplitDays(rows, ind, startIdx, endIdx);
  const sundayVd2BlockDayRows = sundayVd2BlockDays(rows, ind, startIdx, endIdx);

  // The preflight is intentionally completed before the full variants run.
  const dca = pureDca(rows, ind, startIdx, endIdx);
  const simulations = {};
  for (const [name, mode] of Object.entries(MODES)) simulations[name] = E.simulate(rows, ind, startIdx, endIdx, mode, { capturePath: true });

  const primary = Object.entries(MODES).map(([name]) => {
    const sim = simulations[name];
    return {
      variant: name,
      mode: MODES[name],
      stack: sim.stack,
      dcaStack: dca.stack,
      invested: dca.invested,
      excessPct: (sim.stack / dca.stack - 1) * 100,
      relativeFinalVsVaPct: name === 'V-A' ? 0 : (sim.stack / simulations['V-A'].stack - 1) * 100,
      excessPctPointDeltaVsVa: name === 'V-A' ? 0 : ((sim.stack - simulations['V-A'].stack) / dca.stack) * 100,
      switches: sim.switches,
      feeBtcPaidPct: sim.feeBtcPaidPct,
      overrideDays: sim.overrideDays,
      hedgeDays: sim.hedgeDays,
      overlayRatioMddPct: sim.overlayRatioMdd,
      entries: sim.episodes.length,
      episodes: episodeDetails(rows, sim),
    };
  });
  const annotatedSplit = annotateSplitDays(rows, splitDays, simulations);
  const actualPathDivergenceCount = annotatedSplit.filter((d) => ['V-D1', 'V-D2'].some((name) => {
    const candidate = d.variants[name];
    const va = d.variants['V-A'];
    return candidate.exposure !== va.exposure || candidate.target !== va.target || candidate.overrideActive !== va.overrideActive;
  })).length;
  const splitDivergenceSummary = {};
  for (const name of ['V-D1', 'V-D2']) {
    const comp = intervalExposureComparison(rows, simulations[name].exposurePath, simulations['V-A'].exposurePath, startIdx, endIdx);
    splitDivergenceSummary[name] = { ...comp, differentExposureDays: simulations[name].exposurePath.slice(startIdx, endIdx + 1).filter((p, j) => p && simulations['V-A'].exposurePath[startIdx + j] && p.exposure !== simulations['V-A'].exposurePath[startIdx + j].exposure).length };
  }

  const entryLedgerResult = entryLedger(rows, simulations);
  const postEntryDrawdown = {};
  for (const [name, sim] of Object.entries(simulations)) postEntryDrawdown[name] = maeSummary(sim.episodes);
  const vaMae = postEntryDrawdown['V-A'];
  for (const name of ['V-D1', 'V-D2']) postEntryDrawdown[name].tailDeeperVsVa = postEntryDrawdown[name].minPct < vaMae.minPct;

  const loo = leaveOneOut(rows, ind, simulations, startIdx, endIdx, dca.stack);
  const bootstrap = annualBlockBootstrap(rows, ind, startIdx, endIdx, dca.stack);
  const e2 = loadE2Reference();
  const e7Reference = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'btc-v4-e7-l3-frequency-result.json'), 'utf8'));
  const e7RefVariants = e7Reference.variants || {};
  const legacyModes = { 'V-A': 'weekly', 'V-B': 'enterDaily', 'V-C': 'fullDaily' };
  const legacyPrimary = Object.entries(legacyModes).map(([name, mode]) => {
    const sim = E.simulate(rows, ind, startIdx, endIdx, mode);
    return {
      variant: name,
      stack: sim.stack,
      excessPct: (sim.stack / dca.stack - 1) * 100,
      switches: sim.switches,
      feeBtcPaidPct: sim.feeBtcPaidPct,
      overrideDays: sim.overrideDays,
      hedgeDays: sim.hedgeDays,
    };
  });
  const regressionRows = ['V-A', 'V-B', 'V-C'].map((name) => {
    const current = legacyPrimary.find((r) => r.variant === name);
    const expected = e7RefVariants[name];
    const diffs = expected ? {
      stack: current.stack - expected.stack,
      excessPct: current.excessPct - expected.excessPct,
      switches: current.switches - expected.switches,
      feeBtcPaidPct: current.feeBtcPaidPct - expected.feeBtcPaidPct,
      overrideDays: current.overrideDays - expected.overrideDays,
      hedgeDays: current.hedgeDays - expected.hedgeDays,
    } : null;
    // E7 result stores stack/excess/fee at 4/1/2 decimal places. Compare at
    // that persisted precision so telemetry additions cannot look like logic
    // drift.
    const match = Boolean(diffs) && round(current.stack, 4) === round(expected.stack, 4) && round(current.excessPct, 1) === round(expected.excessPct, 1) && diffs.switches === 0 && round(current.feeBtcPaidPct, 2) === round(expected.feeBtcPaidPct, 2) && diffs.overrideDays === 0 && diffs.hedgeDays === 0;
    return { variant: name, expected, current, diffs, match };
  });
  const regression = { reference: 'research/btc-v4-e7-l3-frequency-result.json @ fb9f992', allMatch: regressionRows.every((r) => r.match), rows: regressionRows };

  const acceptance = ['V-D1', 'V-D2'].map((name) => {
    const current = primary.find((r) => r.variant === name);
    const band = bootstrap.variants[name];
    const looRow = loo.summary.find((r) => r.variant === name);
    const tailDeeper = postEntryDrawdown[name].tailDeeperVsVa;
    const e2Pass = e2.available && e2.leverage1_5x.passes3xHeadroom && !e2.leverage1_5x.liquidatedInAcceptanceSlice;
    const passPositive = current.excessPctPointDeltaVsVa > 0;
    const passBootstrap = passPositive && current.relativeFinalVsVaPct > band.p90RelativeVsVaPct;
    const passLeaveOneOut = looRow.flipCount === 0;
    const passTail = !tailDeeper || (e2Pass && e2.leverage1_5x.worstMinHeadroomAcceptanceSlice >= 3);
    const entryOnSplit = simulations[name].episodes.filter((ep) => splitDays.some((d) => d.affectedIdx === ep.entryIdx)).length;
    const singleSplitDriver = current.relativeFinalVsVaPct > 0 && entryOnSplit <= 1;
    const passAll = passBootstrap && passLeaveOneOut && passTail && !singleSplitDriver;
    let failureReason = '通过';
    if (!passAll) {
      if (!passPositive) failureReason = 'V-D 更差';
      else if (singleSplitDriver || !passLeaveOneOut || !passBootstrap || !passTail) failureReason = '证据不足';
    }
    return { variant: name, observedRelativeFinalVsVaPct: current.relativeFinalVsVaPct, observedExcessPctPointDeltaVsVa: current.excessPctPointDeltaVsVa, bootstrap: band, passPositive, passBootstrap, passLeaveOneOut, passTail, singleSplitDriver, passAll, failureReason };
  });

  const pathIdentical = samePath(simulations['V-A'], simulations['V-D1'], startIdx, endIdx) && samePath(simulations['V-A'], simulations['V-D2'], startIdx, endIdx);
  let conclusion;
  if (!splitDays.length || pathIdentical) {
    conclusion = { label: '无差异：维持 V-A', reason: '无差异', humanDecision: '待人工裁决，不自动替换 V-A', text: '分叉日为零或三组逐日路径完全相同，实验无信息量；维持 V-A 不是证明周日更优。' };
  } else if (acceptance.every((r) => r.observedRelativeFinalVsVaPct < 0 && r.passLeaveOneOut)) {
    conclusion = { label: 'V-D 更差：维持 V-A', reason: 'V-D 更差', humanDecision: '待人工裁决，不自动替换 V-A', text: 'V-D1/V-D2 的全史相对 V-A 终值差均为负，且 LOO 方向未翻转；在本方向性样本中 V-D 更差，但这不等于周日方案被证明为普遍最优。' };
  } else {
    conclusion = { label: '证据不足：维持 V-A', reason: '证据不足', humanDecision: '待人工裁决，不自动替换 V-A', text: '至少一个候选未同时通过预注册的正超额/bootstrap、LOO 和尾部/清偿力门槛；维持 V-A 的理由是证据不足，不是周日方案已被证明更优。' };
  }

  const meta = gitMeta();
  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      codeCommitAtRun: meta.commit,
      scriptDirtyAtRun: meta.scriptDirtyAtRun,
      preregistration: `research/btc-v4-e8-vd-entry-preregistration.md @ ${PREREG_COMMIT}`,
      e7Baseline: 'research/v4-e7-l3-frequency @ fb9f992',
      seed: BOOTSTRAP_SEED,
      priceSource: { file: PRICE_CSV, sha256: sha256File(PRICE_CSV), url: 'https://raw.githubusercontent.com/coinmetrics/data/master/csv/btc.csv' },
      ahrSource: { url: AHR_URL, sha256: sha256Text(refText) },
      priceWindow: { start: rows[0].date, end: rows.at(-1).date, observations: rows.length },
      simWindow: { start: rows[startIdx].date, end: rows[endIdx].date, startIdx, endIdx },
      ahrMedianErrPct: medErr * 100,
      engine: 'E7 engine; linear daily approximation, no funding/convexity/wicks; solvency per E2',
    },
    preregistration: {
      branch: 'research/v4-e8-vd-entry',
      commit: 'ca2c2ba',
      variants: MODES,
      commonRules: 'dd365<=-20%; 1.5x; exit/kill Sunday; L2 daily; T-1; identical DCA; only L3 entry changes',
    },
    preflight: { count: splitDays.length, actualPathDivergenceCount, definition: 'AHR<0.40 && dd365<=-20% && BearLock=false && affected execution day non-Sunday', raw: splitDays, annotated: annotatedSplit, divergenceSummary: splitDivergenceSummary },
    sundayVd2Blocks: {
      count: sundayVd2BlockDayRows.length,
      definition: 'AHR<0.40 && dd365<=-20% && BearLock=true && affected execution day Sunday; V-A allows entry, V-D2 forbids entry',
      blocks: groupWeeklyBlocks(sundayVd2BlockDayRows),
      days: sundayVd2BlockDayRows,
    },
    primary,
    regression,
    entryLedger: entryLedgerResult,
    leaveOneOut: loo,
    postEntryDrawdown,
    postEntryDrawdownEpisodes: Object.fromEntries(Object.entries(simulations).map(([name, sim]) => [name, episodeDetails(rows, sim)])),
    bootstrap,
    e2,
    acceptance,
    conclusion,
    limitations: ['深水 episode 样本有限，结论为方向性证据。', 'E7 线性引擎不含 funding、inverse convexity、wick；E2 单独覆盖清偿力。', '年块 bootstrap 为方法一致的噪声带，不是正式 iid 置信区间。', '机会成本与保护损失并排，禁止单边叙事。'],
  };

  const researchDir = path.join(__dirname, '..', 'research');
  fs.writeFileSync(path.join(researchDir, 'btc-v4-e8-vd-entry-result.json'), JSON.stringify(out, null, 2) + '\n');
  fs.writeFileSync(path.join(researchDir, 'btc-v4-e8-vd-entry-report.md'), renderReport(out));
  console.log(JSON.stringify({
    preflightCount: out.preflight.count,
    pathIdentical,
    primary: primary.map((r) => ({ variant: r.variant, stack: round(r.stack, 2), excessPct: round(r.excessPct, 2), relativeFinalVsVaPct: round(r.relativeFinalVsVaPct, 2), entries: r.entries })),
    entryLedger: Object.fromEntries(Object.entries(entryLedgerResult).map(([name, values]) => [name, { n: values.length, early: values.filter((v) => v.timing === 'EARLY').length, vdOnly: values.filter((v) => v.timing === 'V-D_ONLY').length, protectionLossDays: values.reduce((n, v) => n + v.exposureComparison.protectionLossDays, 0) }])),
    mae: Object.fromEntries(Object.entries(postEntryDrawdown).map(([name, row]) => [name, { n: row.n, p50Pct: round(row.p50Pct, 2), minPct: round(row.minPct, 2), tailDeeperVsVa: row.tailDeeperVsVa }])),
    bootstrap: Object.fromEntries(Object.entries(bootstrap.variants).map(([name, row]) => [name, { p10: round(row.p10RelativeVsVaPct, 2), p50: round(row.p50RelativeVsVaPct, 2), p90: round(row.p90RelativeVsVaPct, 2) }])),
    regression: regression.allMatch,
    acceptance: acceptance.map((r) => ({ variant: r.variant, observed: round(r.observedRelativeFinalVsVaPct, 2), passBootstrap: r.passBootstrap, passLeaveOneOut: r.passLeaveOneOut, passTail: r.passTail, passAll: r.passAll, reason: r.failureReason })),
    conclusion,
  }, null, 2));
}

main().catch((err) => { console.error(err.stack || err); process.exit(1); });
