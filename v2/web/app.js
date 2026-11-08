/**
 * 中转站经营看板 · v2 前端核心控制逻辑
 * Tabler 1.7.3 仪表盘节奏版
 * 零构建、原生 ES Module、无外部网络依赖。
 */

// ============================================================================
// 常量与时间基准 (UTC+8 北京时间)
// ============================================================================

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const TZ_OFFSET_MS = 8 * 3600000;

/** 全局运行状态 */
const state = {
  meta: null,
  range: null,
  rangeType: '7d', // '24h' | '7d' | '30d' | 'all'
  chartInstance: null,
  profitGranularity: 'day', // 'day' | 'hour'
  profitSite: 'all',
  profitData: null,
  profitChart: null,
  overviewData: null,
  currTrendData: null,
  prevTrendData: null,
  isLoading: false,
  // 两张经营表现表的原始行数据：切换列时按新列集合重画，不必重新请求
  channelRows: [],
  groupRows: [],
};

// ============================================================================
// 主题控制 (Tabler data-bs-theme="dark" / "light" 自适应与手动切换)
// ============================================================================

const THEME_KEY = 'relay-ledger-theme';
/** 改名前的键，只用于一次性迁移老用户的偏好 */
const LEGACY_THEME_KEY = 'madfu-theme';

/**
 * 读本地偏好：先读新键，缺失时回退旧键并写回新键（只迁移一次）。
 * 存储不可用（隐私模式）时返回 null，调用方按默认处理。
 */
function readMigratedKey(key, legacyKey = null) {
  let current = null;
  try {
    current = localStorage.getItem(key);
    if (current !== null || !legacyKey) return current;
    const legacy = localStorage.getItem(legacyKey);
    if (legacy === null) return null;
    localStorage.setItem(key, legacy);
    return legacy;
  } catch {
    return null;
  }
}

export function isDarkMode() {
  const bsTheme = document.documentElement.getAttribute('data-bs-theme');
  if (bsTheme === 'dark') return true;
  if (bsTheme === 'light') return false;
  const theme = document.documentElement.dataset.theme;
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyTheme(theme) {
  if (theme === 'dark' || theme === 'light') {
    document.documentElement.setAttribute('data-bs-theme', theme);
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  } else {
    document.documentElement.removeAttribute('data-bs-theme');
    delete document.documentElement.dataset.theme;
    localStorage.removeItem(THEME_KEY);
    localStorage.removeItem(LEGACY_THEME_KEY);
  }
  refreshChartsTheme();
}

function refreshChartsTheme() {
  if (state.chartInstance && state.range) {
    fetchJson('/api/trend', { from: state.range.from, to: state.range.to, granularity: trendGranularity(state.rangeType) })
      .then(renderTrend)
      .catch(() => {});
  }
  if (state.profitData) {
    renderProfit(state.profitData);
  }
  if (state.overviewData) {
    renderOverview(state.overviewData, state.currTrendData, state.prevTrendData);
  }
}

// ============================================================================
// 格式化函数族 (纯函数、严格遵循口径与空值约定)
// ============================================================================

/**
 * 毫秒时间戳所在北京自然日的 00:00 毫秒时间戳
 */
export function beijingDayStart(ms) {
  return Math.floor((ms + TZ_OFFSET_MS) / DAY_MS) * DAY_MS - TZ_OFFSET_MS;
}

/**
 * 格式化北京时间 YYYY-MM-DD HH:mm (可自选秒)
 */
export function formatBeijingTime(ms, includeSec = false) {
  if (ms == null || ms === '') return '—';
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const d = new Date(n + TZ_OFFSET_MS);
  const pad = (v) => String(v).padStart(2, '0');
  const y = d.getUTCFullYear();
  const m = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const mm = pad(d.getUTCMinutes());
  if (!includeSec) {
    return `${y}-${m}-${day} ${hh}:${mm}`;
  }
  const ss = pad(d.getUTCSeconds());
  return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
}

/**
 * 计算相对新鲜度
 */
export function formatFreshness(ms) {
  if (ms == null || ms === '') return '—';
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const diff = Date.now() - n;
  if (diff < 0) return '刚刚';
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return '刚刚';
  if (hours < 24) return `约 ${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `距今 ${days} 天前`;
}

/**
 * 金额自适应格式化 (USD 两位或小额四位)；严格区分 null 与 0
 */
export function formatUsd(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '$0.00';
  const abs = Math.abs(n);
  const prefix = n < 0 ? '−$' : '$';
  if (abs < 0.01) {
    return prefix + abs.toFixed(4);
  }
  return prefix + abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * 金额固定两位小数（盈利面板口径）；null 显示 —
 */
export function formatUsdFixed(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const prefix = n < 0 ? '−$' : '$';
  return prefix + Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * 整数千分位格式化 (用于请求数)
 */
export function formatInt(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

/**
 * Token 数按中文万/亿单位格式化
 */
export function formatTokenCn(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`;
  if (abs >= 1e4) return `${(n / 1e4).toFixed(2)} 万`;
  return Math.round(n).toLocaleString('zh-CN');
}

/**
 * 分离数值与单位，用于 KPI 卡数字大、单位小的层级排版
 */
export function formatTokenParts(v) {
  if (v == null || v === '') return { num: '—', unit: '' };
  const n = Number(v);
  if (!Number.isFinite(n)) return { num: '—', unit: '' };
  const abs = Math.abs(n);
  if (abs >= 1e8) return { num: (n / 1e8).toFixed(2), unit: '亿' };
  if (abs >= 1e4) return { num: (n / 1e4).toFixed(2), unit: '万' };
  return { num: Math.round(n).toLocaleString('zh-CN'), unit: '' };
}

/**
 * 百分比格式化 (保留一位小数)
 */
export function formatPct(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return (n * 100).toFixed(1) + '%';
}

/**
 * 毫秒 / 秒自适应格式化
 */
export function formatLatency(ms) {
  if (ms == null || ms === '') return '—';
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(1)} s`;
}

/**
 * 吞吐格式化：输出 token / 秒，保留一位小数
 */
export function formatTps(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return '—';
  return n.toFixed(1);
}

/**
 * 指标色阶：只返回语义类名，数字文本由调用方保留
 */
export function cacheTone(v) {
  if (v == null) return '';
  if (v >= 0.80) return 'metric-good';
  if (v >= 0.50) return 'metric-warn';
  return 'metric-bad';
}

export function latencyP50Tone(ms) {
  if (ms == null) return '';
  if (ms <= 5000) return 'metric-good';
  if (ms <= 15000) return 'metric-warn';
  return 'metric-bad';
}

export function latencyP95Tone(ms) {
  if (ms == null) return '';
  if (ms <= 20000) return 'metric-good';
  if (ms <= 60000) return 'metric-warn';
  return 'metric-bad';
}

/**
 * 按色阶包裹数值文本；无色阶时原样输出，不加空 span
 */
function toneText(text, tone) {
  return tone ? `<span class="${tone}">${text}</span>` : text;
}

/**
 * HTML 转义，防止 XSS
 */
export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * 环比 / 同比计算芯片渲染
 */
export function renderCompareChip(curr, prev) {
  if (curr == null || prev == null || !Number.isFinite(Number(curr)) || !Number.isFinite(Number(prev)) || Number(prev) <= 0) {
    return '<span class="badge bg-secondary-lt text-secondary">—</span>';
  }
  const c = Number(curr);
  const p = Number(prev);
  const diff = (c - p) / p;
  const pct = Math.abs(diff * 100).toFixed(1);
  if (Math.abs(diff) < 0.0005) {
    return '<span class="badge bg-secondary-lt text-secondary">0.0%</span>';
  }
  if (diff > 0) {
    return `<span class="badge bg-success-lt text-success fw-bold">↑ +${pct}%</span>`;
  }
  return `<span class="badge bg-danger-lt text-danger fw-bold">↓ -${pct}%</span>`;
}

/**
 * 状态徽章 HTML 渲染
 */
export function renderStatusBadge(status, labelOverride = null) {
  switch (status) {
    case 'complete':
      return `<span class="badge badge-success">${labelOverride || '已核算'}</span>`;
    case 'partial':
      return `<span class="badge badge-amber">${labelOverride || '部分数据'}</span>`;
    case 'unavailable':
      return `<span class="badge badge-amber">${labelOverride || '待接快照'}</span>`;
    case 'unallocated':
      return `<span class="badge badge-info">${labelOverride || '共享未分摊'}</span>`;
    case 'unconfigured':
    default:
      return `<span class="badge badge-neutral">${labelOverride || '未配置'}</span>`;
  }
}

// ============================================================================
// API 数据交互层
// ============================================================================

async function fetchJson(endpoint, params = {}) {
  const url = new URL(endpoint, window.location.origin);
  for (const [key, val] of Object.entries(params)) {
    if (val !== undefined && val !== null && val !== '') {
      url.searchParams.set(key, String(val));
    }
  }
  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const errJson = await res.json();
      if (errJson?.error?.message) msg = errJson.error.message;
    } catch {
      // 保持原始 HTTP 状态
    }
    throw new Error(msg);
  }
  return res.json();
}

/**
 * 计算范围参数 { from, to }
 */
function computeRange(type, meta) {
  const maxT = meta?.max_t || Date.now();
  const minT = meta?.min_t || 0;
  if (type === '24h') {
    // 与 new-api 看板对齐：24 个整点桶（含当前未走完的小时），而非滚动 24 小时。
    // 起点 = 当前小时起点 − 23 小时，终点 = 最新日志时间。
    const hourStart = Math.floor(maxT / HOUR_MS) * HOUR_MS;
    return {
      from: hourStart - 23 * HOUR_MS,
      to: maxT,
    };
  }
  if (type === '30d') {
    return {
      from: beijingDayStart(maxT) - 29 * DAY_MS,
      to: maxT,
    };
  }
  if (type === 'all') {
    return {
      from: minT,
      to: maxT,
    };
  }
  // 默认近 7 天
  return {
    from: beijingDayStart(maxT) - 6 * DAY_MS,
    to: maxT,
  };
}

/**
 * 趋势图分桶：近 24 小时按小时，其余按天
 */
function trendGranularity(rangeType) {
  return rangeType === '24h' ? 'hour' : 'day';
}

/**
 * 查询区间的展示文案。
 *
 * 跨度 = 桶数 × 桶宽，不按 to - from 算：24h 预设是 24 个整点桶，
 * 7d / 30d 是 7 / 30 个日桶；终点取末桶结束时刻（开区间端点），比接口的 to 晚。
 * 「全部」没有固定桶数，退回真实 from → to 的毫秒差。
 */
export function formatRangeLabel(rangeInfo) {
  const from = Number(rangeInfo?.from);
  const to = Number(rangeInfo?.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return '';
  const rangeType = rangeInfo?.rangeType || '7d';
  const startText = formatBeijingTime(from).slice(5);

  if (rangeType === 'all') {
    const hours = Math.max(0, (to - from) / HOUR_MS);
    return `${startText} – ${formatBeijingTime(to).slice(5)} · ${hours.toFixed(1)} 小时`;
  }

  const step = rangeType === '24h' ? HOUR_MS : DAY_MS;
  const buckets = rangeType === '24h' ? 24 : rangeType === '30d' ? 30 : 7;
  const start = rangeType === '24h' ? Math.floor(from / HOUR_MS) * HOUR_MS : beijingDayStart(from);
  const endExclusive = start + buckets * step;
  const hours = (buckets * step) / HOUR_MS;
  const live = endExclusive > Date.now() ? '（末桶进行中）' : '';
  return `${formatBeijingTime(start).slice(5)} – ${formatBeijingTime(endExclusive).slice(5)} · ${hours} 小时${live}`;
}

/** 本轮请求实际使用的范围（与 loadAllData 的请求参数一致） */
function currentRangeInfo() {
  if (!state.range) return null;
  return { from: state.range.from, to: state.range.to, rangeType: state.rangeType };
}

/** 一次遍历所有数据卡的区间标签，避免每张卡各写一遍 */
function updateRangeLabels(rangeInfo = currentRangeInfo()) {
  const label = formatRangeLabel(rangeInfo);
  document.querySelectorAll('[data-range-label]').forEach((el) => {
    el.textContent = label;
  });
}

/**
 * 设置站点盈利粒度并同步按钮状态
 */
function setProfitGranularity(value) {
  state.profitGranularity = value === 'hour' ? 'hour' : 'day';
  document.querySelectorAll('#profit-granularity .seg-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.granularity === state.profitGranularity);
  });
}

// ============================================================================
// 迷你 Sparkline 与环形仪表渲染 (ECharts)
// ============================================================================

function renderSparkline(domId, dataPoints, type = 'line') {
  const container = document.getElementById(domId);
  if (!container || !window.echarts) return null;

  let chart = window.echarts.getInstanceByDom(container);
  if (!chart) {
    chart = window.echarts.init(container);
  }

  const dark = isDarkMode();
  const primaryColor = dark ? '#4299e1' : '#206bc4';
  const points = (dataPoints || []).map((v) => (v == null ? 0 : v));

  if (points.length === 0) {
    chart.clear();
    return chart;
  }

  const option = {
    animation: true,
    animationDuration: 300,
    grid: { top: 2, bottom: 2, left: 0, right: 0 },
    xAxis: { type: 'category', show: false, data: points.map((_, i) => i) },
    yAxis: { type: 'value', show: false, min: Math.min(...points) > 0 ? 0 : undefined },
    series: [
      type === 'bar'
        ? {
            type: 'bar',
            barMaxWidth: 8,
            itemStyle: {
              color: primaryColor,
              borderRadius: [2, 2, 0, 0],
            },
            data: points,
          }
        : {
            type: 'line',
            smooth: 0.35,
            showSymbol: false,
            lineStyle: { color: primaryColor, width: 2 },
            areaStyle: {
              color: dark
                ? new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [
                    { offset: 0, color: 'rgba(66, 153, 225, 0.28)' },
                    { offset: 1, color: 'rgba(66, 153, 225, 0.00)' },
                  ])
                : new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [
                    { offset: 0, color: 'rgba(32, 107, 196, 0.22)' },
                    { offset: 1, color: 'rgba(32, 107, 196, 0.00)' },
                  ]),
            },
            data: points,
          },
    ],
  };

  chart.setOption(option, true);
  return chart;
}

function renderDonutGauge(domId, rate) {
  const container = document.getElementById(domId);
  if (!container || !window.echarts) return null;

  let chart = window.echarts.getInstanceByDom(container);
  if (!chart) {
    chart = window.echarts.init(container);
  }

  const dark = isDarkMode();
  const validRate = Number.isFinite(rate) ? Math.max(0, Math.min(1, rate)) : 0;
  const pctStr = `${Math.round(validRate * 100)}%`;

  const activeColor = dark ? '#4299e1' : '#206bc4';
  const inactiveColor = dark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.06)';
  const textColor = dark ? '#f8fafc' : '#182433';

  const option = {
    animation: true,
    animationDuration: 350,
    series: [
      {
        type: 'pie',
        radius: ['68%', '86%'],
        center: ['50%', '50%'],
        avoidLabelOverlap: false,
        silent: true,
        label: {
          show: true,
          position: 'center',
          formatter: pctStr,
          fontSize: 16,
          fontWeight: 700,
          color: textColor,
          fontFamily: 'var(--tblr-font-sans-serif, system-ui)',
        },
        data: [
          {
            value: validRate,
            itemStyle: {
              color: activeColor,
              borderRadius: 3,
            },
          },
          {
            value: 1 - validRate,
            itemStyle: {
              color: inactiveColor,
            },
          },
        ],
      },
    ],
  };

  chart.setOption(option, true);
  return chart;
}

// ============================================================================
// DOM 渲染与模块装载
// ============================================================================

function setProgress(active) {
  const bar = document.getElementById('global-progress');
  if (!bar) return;
  if (active) {
    bar.classList.remove('done');
    bar.classList.add('active');
  } else {
    bar.classList.remove('active');
    bar.classList.add('done');
  }
}

/**
 * 渲染 KPI 卡片与财务行卡片
 */
function renderOverview(data, currTrend = null, prevTrend = null) {
  state.overviewData = data;
  state.currTrendData = currTrend;
  state.prevTrendData = prevTrend;

  const elRev = document.getElementById('kpi-revenue-val');
  const elTokens = document.getElementById('kpi-tokens-val');
  const elReq = document.getElementById('kpi-requests-val');
  const elCache = document.getElementById('kpi-cache-val');

  if (elRev) elRev.textContent = formatUsd(data?.revenue);
  if (elTokens) {
    const parts = formatTokenParts(data?.tokens?.total);
    if (parts.unit) {
      elTokens.innerHTML = `<span class="kpi-num">${parts.num}</span><span class="kpi-unit-suffix">${parts.unit}</span>`;
    } else {
      elTokens.textContent = parts.num;
    }
    elTokens.title = data?.tokens?.total == null ? '' : `${formatInt(data.tokens.total)} tokens`;
  }
  if (elReq) {
    if (data?.requests == null) {
      elReq.textContent = '—';
    } else {
      elReq.innerHTML = `<span class="kpi-num">${formatInt(data.requests)}</span><span class="kpi-unit-suffix">次</span>`;
    }
  }
  if (elCache) elCache.textContent = formatPct(data?.cache_rate);

  // Sparklines 与环比
  const currPoints = Array.isArray(currTrend?.points) ? currTrend.points : [];
  const prevPoints = Array.isArray(prevTrend?.points) ? prevTrend.points : [];

  const currRev = data?.revenue;
  const prevRev = prevPoints.length > 0 ? prevPoints.reduce((acc, p) => acc + (p.revenue || 0), 0) : null;
  const elRevPop = document.getElementById('kpi-revenue-pop');
  if (elRevPop) elRevPop.innerHTML = renderCompareChip(currRev, prevRev);
  renderSparkline('sparkline-revenue', currPoints.map((p) => p.revenue), 'line');

  const currQuota = currPoints.reduce((acc, p) => acc + (p.quota || 0), 0);
  const prevQuota = prevPoints.length > 0 ? prevPoints.reduce((acc, p) => acc + (p.quota || 0), 0) : null;
  const elTokensPop = document.getElementById('kpi-tokens-pop');
  if (elTokensPop) elTokensPop.innerHTML = renderCompareChip(currQuota, prevQuota);
  renderSparkline('sparkline-tokens', currPoints.map((p) => p.quota), 'line');

  const currReq = data?.requests;
  const prevReq = prevPoints.length > 0 ? prevPoints.reduce((acc, p) => acc + (p.requests || 0), 0) : null;
  const elReqPop = document.getElementById('kpi-requests-pop');
  if (elReqPop) elReqPop.innerHTML = renderCompareChip(currReq, prevReq);
  renderSparkline('sparkline-requests', currPoints.map((p) => p.requests), 'bar');

  const elCachePop = document.getElementById('kpi-cache-pop');
  if (elCachePop) elCachePop.innerHTML = '<span class="badge bg-secondary-lt text-secondary">—</span>';
  renderDonutGauge('sparkline-cache', data?.cache_rate);

  // 财务行卡片渲染
  const elUpstreamBadge = document.getElementById('kpi-upstream-badge');
  const elUpstreamSlot = document.getElementById('kpi-upstream-slot');
  const elUpstreamSub = document.getElementById('kpi-upstream-sub');
  const elUpstreamProgress = document.getElementById('kpi-upstream-progress');

  const elProfitBadge = document.getElementById('kpi-profit-badge');
  const elProfitSlot = document.getElementById('kpi-profit-slot');
  const elProfitSub = document.getElementById('kpi-profit-sub');
  const elProfitProgress = document.getElementById('kpi-profit-progress');

  const elMarginBadge = document.getElementById('kpi-margin-badge');
  const elMarginSlot = document.getElementById('kpi-margin-slot');
  const elMarginSub = document.getElementById('kpi-margin-sub');
  const elMarginProgress = document.getElementById('kpi-margin-progress');

  // 上游成本
  if (data?.upstream_cost == null) {
    if (elUpstreamBadge) {
      elUpstreamBadge.className = 'badge badge-amber';
      elUpstreamBadge.textContent = '待接快照';
    }
    if (elUpstreamSlot) {
      elUpstreamSlot.innerHTML = '<span class="h1 mb-0 fw-bold num text-secondary kpi-value" id="kpi-upstream-val">—</span>';
    }
    if (elUpstreamSub) elUpstreamSub.textContent = '待接入站点余额快照';
    if (elUpstreamProgress) elUpstreamProgress.style.width = '0%';
  } else {
    const isComplete = data.margin_status === 'complete';
    if (elUpstreamBadge) {
      elUpstreamBadge.className = isComplete ? 'badge badge-success' : 'badge badge-amber';
      elUpstreamBadge.textContent = isComplete ? '已核算' : '部分数据';
    }
    if (elUpstreamSlot) {
      elUpstreamSlot.innerHTML = `<span class="h1 mb-0 fw-bold num kpi-value" id="kpi-upstream-val">${formatUsd(data.upstream_cost)}</span>`;
    }
    if (elUpstreamSub) elUpstreamSub.textContent = '核算完成';
    if (elUpstreamProgress) elUpstreamProgress.style.width = '100%';
  }

  // 经营利润
  if (data?.margin == null) {
    if (elProfitBadge) {
      elProfitBadge.className = 'badge badge-amber';
      elProfitBadge.textContent = '待接快照';
    }
    if (elProfitSlot) {
      elProfitSlot.innerHTML = '<span class="h1 mb-0 fw-bold num text-secondary kpi-value" id="kpi-profit-val">—</span>';
    }
    if (elProfitSub) elProfitSub.textContent = '售出扣减上游支出';
    if (elProfitProgress) elProfitProgress.style.width = '0%';
  } else {
    if (elProfitBadge) {
      elProfitBadge.className = 'badge badge-success';
      elProfitBadge.textContent = '已核算';
    }
    if (elProfitSlot) {
      elProfitSlot.innerHTML = `<span class="h1 mb-0 fw-bold num kpi-value" id="kpi-profit-val">${formatUsd(data.margin)}</span>`;
    }
    if (elProfitSub) elProfitSub.textContent = '已核算净利润';
    if (elProfitProgress) elProfitProgress.style.width = '100%';
  }

  // 综合毛利率
  if (data?.margin == null || data?.revenue == null || data.revenue <= 0) {
    if (elMarginBadge) {
      elMarginBadge.className = 'badge badge-amber';
      elMarginBadge.textContent = '待接快照';
    }
    if (elMarginSlot) {
      elMarginSlot.innerHTML = '<span class="h1 mb-0 fw-bold num text-secondary kpi-value" id="kpi-margin-val">—</span>';
    }
    if (elMarginSub) elMarginSub.textContent = '核算利润占售出比例';
    if (elMarginProgress) elMarginProgress.style.width = '0%';
  } else {
    const marginRate = data.margin / data.revenue;
    if (elMarginBadge) {
      elMarginBadge.className = 'badge badge-success';
      elMarginBadge.textContent = '已核算';
    }
    if (elMarginSlot) {
      elMarginSlot.innerHTML = `<span class="h1 mb-0 fw-bold num kpi-value" id="kpi-margin-val">${formatPct(marginRate)}</span>`;
    }
    if (elMarginSub) elMarginSub.textContent = '核算毛利率';
    if (elMarginProgress) {
      elMarginProgress.style.width = `${Math.min(100, Math.max(0, Math.round(marginRate * 100)))}%`;
    }
  }
}

/**
 * 渲染趋势图 (ECharts 或优雅 SVG 降级)
 */
/**
 * 趋势图的售出柱按站点堆叠：直接复用「站点盈利」的售出序列与配色，
 * 桶标签必须逐一对齐，否则两份数据不混用（退回单色合计柱）。
 */
function buildTrendRevenueSeries(profitData, labels) {
  const sites = Array.isArray(profitData?.sites) ? profitData.sites : [];
  const buckets = Array.isArray(profitData?.buckets) ? profitData.buckets : [];
  if (!sites.length || !buckets.length) return null;
  // 按日期标签对齐，而不是按下标：趋势接口按 GROUP BY 只返回有数据的天，
  // 区间内没有请求的日期（例如 30 天窗口里建站之前的空白天）不会出现在 points 里。
  const indexByLabel = new Map(buckets.map((b, i) => [String(b.label), i]));
  const sourceIndex = labels.map((label) => indexByLabel.get(String(label)));
  if (sourceIndex.some((i) => i === undefined)) return null;
  const palette = isDarkMode() ? PROFIT_PALETTE_DARK : PROFIT_PALETTE_LIGHT;
  return sites.map((site, i) => ({
    name: site.name || site.account_id,
    type: 'bar',
    stack: 'revenue',
    yAxisIndex: 0,
    // 柱宽交给 ECharts 按类目自适应：7 天窗口柱子粗，30 天窗口自动变细。
    barCategoryGap: '38%',
    barMaxWidth: 64,
    itemStyle: {
      color: palette[i % palette.length],
      borderRadius: [2, 2, 0, 0],
    },
    data: sourceIndex.map((idx) => profitData.series?.revenue_by_site?.[site.account_id]?.[idx] ?? null),
  }));
}

function renderTrend(trendData) {
  const container = document.getElementById('trend-chart');
  const fallbackBox = document.getElementById('chart-fallback');
  if (!container) return;

  const points = Array.isArray(trendData?.points) ? trendData.points : [];

  if (!window.echarts) {
    renderSvgFallback(fallbackBox, points);
    container.style.display = 'none';
    if (fallbackBox) fallbackBox.hidden = false;
    return;
  }

  container.style.display = 'block';
  if (fallbackBox) fallbackBox.hidden = true;

  if (!state.chartInstance) {
    state.chartInstance = window.echarts.init(container);
  }

  const dark = isDarkMode();
  const textColor = dark ? '#9bb0cb' : '#667382';
  const splitLineColor = dark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.05)';
  const axisLineColor = dark ? '#2c3b4d' : '#e6e8eb';

  const xData = points.map((p) => p.bucket);
  const revenueData = points.map((p) => p.revenue);
  const requestsData = points.map((p) => p.requests);
  const stackedBars = buildTrendRevenueSeries(state.profitData, xData);

  const option = {
    animation: true,
    animationDuration: 350,
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross', label: { backgroundColor: dark ? '#2c3b4d' : '#475569' } },
      backgroundColor: dark ? 'rgba(24, 36, 51, 0.96)' : 'rgba(255, 255, 255, 0.96)',
      borderColor: dark ? '#2c3b4d' : '#e6e8eb',
      borderWidth: 1,
      padding: [8, 12],
      textStyle: { color: dark ? '#f8fafc' : '#182433', fontSize: 12 },
      formatter(params) {
        if (!params || !params.length) return '';
        const titleColor = dark ? '#f8fafc' : '#182433';
        const muted = dark ? '#cbd5e1' : '#667382';
        const bars = params.filter((p) => p.seriesType === 'bar' && Number(p.value) > 0);
        const others = params.filter((p) => p.seriesType !== 'bar');
        // 该时段总售出：各站点堆叠柱求和，放在标题右侧
        const total = bars.reduce((s, p) => s + (Number(p.value) || 0), 0);
        // 渠道按金额降序，零值排到最后
        const sortedBars = [...bars].sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0));
        const row = (item, valStr) => `<div style="display:flex;align-items:center;justify-content:space-between;gap:18px;margin-top:3px;">
            <span style="color:${muted}">${item.marker} ${item.seriesName}</span>
            <strong style="font-family:var(--tblr-font-monospace);font-variant-numeric:tabular-nums;">${valStr}</strong>
          </div>`;
        let out = `<div style="display:flex;align-items:baseline;justify-content:space-between;gap:20px;font-weight:600;margin-bottom:6px;color:${titleColor};">
            <span>${params[0].axisValue}</span>
            <span style="font-family:var(--tblr-font-monospace);font-variant-numeric:tabular-nums;">${formatUsd(total)}</span>
          </div>`;
        for (const item of sortedBars) out += row(item, formatUsd(item.value));
        for (const item of others) out += row(item, `${formatInt(item.value)} 次`);
        return out;
      },
    },
    grid: {
      top: stackedBars ? 54 : 32,
      left: 52,
      right: 52,
      bottom: 24,
    },
    legend: stackedBars
      ? {
          top: 2,
          left: 'center',
          itemWidth: 10,
          itemHeight: 10,
          itemGap: 12,
          textStyle: { color: textColor, fontSize: 11 },
        }
      : undefined,
    xAxis: {
      type: 'category',
      data: xData,
      axisLine: { lineStyle: { color: axisLineColor } },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: {
        color: textColor,
        fontSize: 11,
        formatter(v) {
          return v.length >= 10 ? v.slice(5) : v;
        },
      },
    },
    yAxis: [
      {
        type: 'value',
        name: stackedBars ? '' : '售出',
        nameTextStyle: { color: textColor, fontSize: 11, padding: [0, 0, 4, 0] },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: splitLineColor, type: 'dashed' } },
        axisLabel: {
          color: textColor,
          fontSize: 11,
          formatter(v) {
            return `$${v}`;
          },
        },
      },
      {
        type: 'value',
        name: stackedBars ? '' : '请求数',
        nameTextStyle: { color: textColor, fontSize: 11, padding: [0, 0, 4, 0] },
        position: 'right',
        splitLine: { show: false },
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: textColor,
          fontSize: 11,
          formatter(v) {
            return v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v;
          },
        },
      },
    ],
    series: [
      ...(stackedBars ?? [
        {
          name: '售出',
          type: 'bar',
          yAxisIndex: 0,
          barCategoryGap: '38%',
          barMaxWidth: 64,
          itemStyle: {
            color: dark ? '#4299e1' : '#206bc4',
            borderRadius: [4, 4, 0, 0],
          },
          data: revenueData,
        },
      ]),
      {
        name: '请求量 (次)',
        type: 'line',
        yAxisIndex: 1,
        smooth: 0.25,
        showSymbol: false,
        lineStyle: {
          color: '#2fb344',
          width: 2.2,
        },
        areaStyle: {
          color: dark
            ? new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [
                { offset: 0, color: 'rgba(47, 179, 68, 0.20)' },
                { offset: 1, color: 'rgba(47, 179, 68, 0.00)' },
              ])
            : new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [
                { offset: 0, color: 'rgba(47, 179, 68, 0.14)' },
                { offset: 1, color: 'rgba(47, 179, 68, 0.00)' },
              ]),
        },
        data: requestsData,
      },
    ],
  };

  state.chartInstance.setOption(option, true);
}

/**
 * SVG 占位与降级渲染
 */
function renderSvgFallback(fallbackBox, points) {
  if (!fallbackBox) return;
  if (!points || points.length === 0) {
    fallbackBox.innerHTML = `
      <div class="chart-fallback-title">暂无趋势数据</div>
      <div class="chart-fallback-sub text-secondary">选定时间范围内没有计费日志</div>
    `;
    return;
  }

  const maxRev = Math.max(...points.map((p) => p.revenue || 0), 1);
  const w = 480;
  const h = 140;
  const padX = 20;
  const padY = 15;
  const plotW = w - padX * 2;
  const plotH = h - padY * 2;
  const step = plotW / (points.length || 1);

  const bars = points.map((p, i) => {
    const barH = ((p.revenue || 0) / maxRev) * plotH;
    const x = padX + i * step + step * 0.2;
    const y = h - padY - barH;
    const bw = Math.max(step * 0.6, 6);
    return `<rect x="${x}" y="${y}" width="${bw}" height="${barH}" rx="2" fill="currentColor" opacity="0.75" />
            <text x="${x + bw / 2}" y="${h - 2}" font-size="9" text-anchor="middle" fill="#888">${p.bucket.slice(5)}</text>`;
  }).join('');

  fallbackBox.innerHTML = `
    <svg class="chart-fallback-svg" viewBox="0 0 ${w} ${h}">
      <line x1="${padX}" y1="${h - padY}" x2="${w - padX}" y2="${h - padY}" stroke="#cbd5e1" stroke-width="1" />
      ${bars}
    </svg>
    <div class="chart-fallback-title">基础数据概览</div>
    <div class="chart-fallback-sub text-secondary">未检测到 ECharts 组件库，展示基础静态占位</div>
  `;
}

/**
 * 逐桶汇总「有成本快照」的站点：售出、成本、利润用同一批站点，
 * 口径一致才不会让毛利率虚高；缺快照的站点数另存，供 tooltip 说明。
 */
function aggregateProfitPoints(siteIds, data, length) {
  const revenue = new Array(length).fill(null);
  const cost = new Array(length).fill(null);
  const profit = new Array(length).fill(null);
  const missing = new Array(length).fill(0);
  const series = data.series || {};
  for (let i = 0; i < length; i += 1) {
    let rev = 0;
    let cst = 0;
    let prf = 0;
    let used = 0;
    let missingCount = 0;
    for (const id of siteIds) {
      const r = series.revenue_by_site?.[id]?.[i];
      const c = series.cost_by_site?.[id]?.[i];
      if (r == null || c == null) {
        missingCount += 1;
        continue;
      }
      const p = series.profit_by_site?.[id]?.[i];
      rev += r;
      cst += c;
      prf += p == null ? r - c : p;
      used += 1;
    }
    if (used > 0) {
      revenue[i] = Math.round(rev * 1e6) / 1e6;
      cost[i] = Math.round(cst * 1e6) / 1e6;
      profit[i] = Math.round(prf * 1e6) / 1e6;
      missing[i] = missingCount;
    }
  }
  const margin = revenue.map((rev, i) => (
    rev != null && rev > 0 && profit[i] != null ? profit[i] / rev : null
  ));
  return { revenue, cost, profit, margin, missing };
}

const PROFIT_PALETTE_LIGHT = [
  '#206bc4', '#4299e1', '#2fb344', '#74b816',
  '#ae3ec9', '#d63939', '#f76707', '#4263eb',
];

const PROFIT_PALETTE_DARK = [
  '#4299e1', '#63b3ed', '#48bb78', '#9ae6b4',
  '#d6bcfa', '#feb2b2', '#fbd38d', '#799bfb',
];

function renderProfitStatus(site) {
  const status = site?.status;
  // 合计为 null 时说明「多少个小时能算」——空白徽标看不出是缺一天还是缺一小时
  const covered = Number(site?.covered_buckets);
  const total = Number(site?.bucket_count);
  const coverage = Number.isFinite(covered) && Number.isFinite(total) && total > 0
    ? `${covered}/${total} 小时可核算`
    : '';
  const withTitle = (label, cls) => {
    const text = coverage ? `${label} ${covered}/${total}` : label;
    return `<span class="badge ${cls}" title="${coverage || label}">${text}</span>`;
  };
  switch (status) {
    case 'complete':
      return '<span class="badge badge-success">已核算</span>';
    case 'partial':
      return withTitle('部分数据', 'badge-amber');
    case 'missing_balance':
      return withTitle('缺快照', 'badge-amber');
    case 'no_revenue':
      return '<span class="badge badge-neutral">无售出</span>';
    case 'no_cost':
      return '<span class="badge badge-neutral" title="该渠道没有上游账户，只统计售出">无成本源</span>';
    default:
      return '<span class="badge badge-neutral">—</span>';
  }
}

function renderProfitSiteOptions(sites) {
  const select = document.getElementById('profit-site');
  if (!select) return;
  if (state.profitSite !== 'all' && !sites.some((s) => s.account_id === state.profitSite)) {
    state.profitSite = 'all';
  }
  const html = ['<option value="all">全部站点</option>']
    .concat(sites.map((s) => `<option value="${escapeHtml(s.account_id)}">${escapeHtml(s.name || s.account_id)}</option>`))
    .join('');
  if (select.innerHTML !== html) select.innerHTML = html;
  select.value = state.profitSite;
}

function renderProfitTable(sites, data) {
  const tbody = document.getElementById('tbody-profit');
  if (!tbody) return;

  if (sites.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="table-empty text-center text-secondary py-4">所选区间内暂无启用的上游账户</td></tr>';
  } else {
    tbody.innerHTML = sites.map((s) => {
      const kindTag = s.kind ? `<span class="badge bg-secondary-lt ms-1">${escapeHtml(s.kind)}</span>` : '';
      const disabledTag = s.enabled === false
        ? '<span class="badge badge-amber ms-1">已停用</span>'
        : '';
      const channelCount = Array.isArray(s.channels) ? s.channels.length : 0;
      const channelMeta = channelCount > 0 ? `${channelCount} 个渠道` : '无映射渠道';
      // 成本无法核算时，没有记录到充值事件并不等于"没有充值"，显示 0.00 会误导
      const creditsCell = s.cost == null && !(s.credits > 0) ? '—' : formatUsdFixed(s.credits);
      return `
        <tr>
          <td>
            <div class="upstream-acc-cell">
              <div class="upstream-acc-main">
                <strong class="upstream-acc-name">${escapeHtml(s.name || s.account_id)}</strong>
                ${kindTag}
                ${disabledTag}
              </div>
              <span class="upstream-acc-meta text-secondary small">${channelMeta}</span>
            </div>
          </td>
          <td class="num font-semibold text-end">${formatUsdFixed(s.revenue)}</td>
          <td class="num text-end">${creditsCell}</td>
          <td class="num text-end">${formatUsdFixed(s.cost)}</td>
          <td class="num font-semibold text-end">${formatUsdFixed(s.profit)}</td>
          <td class="num text-end">${formatPct(s.margin)}</td>
          <td class="cell-center">${renderProfitStatus(s)}</td>
        </tr>
      `;
    }).join('');
  }

  const note = document.getElementById('profit-unmapped-note');
  if (note) {
    const unmapped = data?.unmapped;
    if (unmapped && Array.isArray(unmapped.channels) && unmapped.channels.length > 0) {
      const names = unmapped.channels
        .slice(0, 3)
        .map((c) => `${c.channel_name || `#${c.channel_id}`} ${formatUsdFixed(c.revenue)}`)
        .join('、');
      const more = unmapped.channels.length > 3 ? ` 等 ${unmapped.channels.length} 个渠道` : '';
      note.textContent = `未映射渠道售出：${formatUsdFixed(unmapped.revenue)}（${names}${more}，未计入站点盈利）`;
    } else {
      note.textContent = '未映射渠道售出：$0.00';
    }
  }
}

function renderProfitFallback(message) {
  const container = document.getElementById('profit-chart');
  const fallback = document.getElementById('profit-fallback');
  // 没有可核算区间时不必占满 320px 高度，收成一条提示。
  const box = container?.parentElement;
  if (box) box.style.height = '180px';
  if (fallback) {
    fallback.innerHTML = `
      <div class="chart-fallback-title">站点盈利</div>
      <div class="chart-fallback-sub text-secondary">${escapeHtml(message)}</div>
    `;
    fallback.hidden = false;
  }
  if (container) container.style.display = 'none';
}

/**
 * 渲染站点盈利混合图
 */
function renderProfitChart(data, visibleSites) {
  const container = document.getElementById('profit-chart');
  if (!container) return;

  const buckets = Array.isArray(data.buckets) ? data.buckets : [];
  const length = buckets.length;
  const selected = state.profitSite;

  if (!window.echarts) {
    renderProfitFallback('未检测到 ECharts 组件库，图表不可用；下方汇总表仍可查看。');
    return;
  }
  if (length === 0) {
    renderProfitFallback('所选时间范围内暂无盈利数据。');
    return;
  }

  const revenueChannels = (data.series?.revenue_by_channel || [])
    .filter((c) => selected === 'all' || c.account_id === selected);
  const siteIds = visibleSites.map((s) => s.account_id);
  // 只把「本区间内至少有一格成本」的站点纳入曲线：停用账户没有快照，
  // 计入分母会让整条线永远是缺口。其余站点缺哪一格，只在 tooltip 里说明。
  const activeIds = siteIds.filter((id) => (
    (data.series?.cost_by_site?.[id] || []).some((v) => v != null)
  ));
  const aggIds = activeIds.length > 0 ? activeIds : siteIds;
  if (revenueChannels.length === 0 && siteIds.length === 0) {
    renderProfitFallback('所选站点暂无可核算数据。');
    return;
  }

  const dark = isDarkMode();
  const textColor = dark ? '#9bb0cb' : '#667382';
  const splitLineColor = dark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.05)';
  const axisLineColor = dark ? '#2c3b4d' : '#e6e8eb';
  const costColor = dark ? '#334155' : '#cbd5e1';
  const costBorder = dark ? '#475569' : '#94a3b8';
  const profitColor = '#2fb344';
  const marginColor = dark ? '#d6bcfa' : '#ae3ec9';
  const palette = dark ? PROFIT_PALETTE_DARK : PROFIT_PALETTE_LIGHT;

  const { revenue: revenuePoints, cost: costPoints, profit: profitPoints, margin: marginPoints, missing: missingSites } = aggregateProfitPoints(aggIds, data, length);

  const series = [];
  // 「全部站点」时不画售出柱：上图「收入与请求趋势」已经按站点堆叠显示了同一份售出，
  // 这里只保留成本柱与利润/毛利率曲线，避免重复占位。选中单个站点时才展开该站点的渠道售出。
  if (selected !== 'all') {
    const channels = (data.series?.revenue_by_channel || [])
      .filter((c) => c.account_id === selected);
    channels.forEach((ch, i) => {
      series.push({
        name: ch.channel_name || `#${ch.channel_id}`,
        type: 'bar',
        stack: 'revenue',
        yAxisIndex: 0,
        barCategoryGap: '38%',
        barMaxWidth: 64,
        itemStyle: {
          color: palette[i % palette.length],
          borderRadius: [2, 2, 0, 0],
        },
        data: buckets.map((_, idx) => ch.points?.[idx] ?? null),
      });
    });
  }
  series.push({
    name: '成本',
    type: 'bar',
    yAxisIndex: 0,
    barCategoryGap: '38%',
    barMaxWidth: 64,
    itemStyle: {
      color: costColor,
      borderColor: costBorder,
      borderWidth: 1,
      borderRadius: [2, 2, 0, 0],
    },
    data: costPoints,
  });
  series.push({
    name: '利润',
    type: 'line',
    yAxisIndex: 0,
    smooth: 0.25,
    showSymbol: false,
    connectNulls: false,
    lineStyle: { color: profitColor, width: 2.2 },
    itemStyle: { color: profitColor },
    data: profitPoints,
  });
  series.push({
    name: '毛利率',
    type: 'line',
    yAxisIndex: 1,
    smooth: 0.25,
    showSymbol: true,
    symbolSize: 4,
    connectNulls: false,
    lineStyle: { color: marginColor, width: 1.8, type: 'dashed' },
    itemStyle: { color: marginColor },
    data: marginPoints.map((v) => (v == null ? null : Math.round(v * 1000) / 10)),
  });

  if (!series.some((s) => s.data.some((v) => v != null))) {
    renderProfitFallback('所选区间缺少可核算的成本：时段内没有完整的余额快照。售出见上方趋势图。');
    return;
  }

  container.style.display = 'block';
  const fallback = document.getElementById('profit-fallback');
  if (fallback) fallback.hidden = true;
  if (container.parentElement) container.parentElement.style.height = '320px';

  if (!state.profitChart) {
    state.profitChart = window.echarts.init(container);
  }

  const option = {
    animation: true,
    animationDuration: 350,
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross', label: { backgroundColor: dark ? '#2c3b4d' : '#475569' } },
      backgroundColor: dark ? 'rgba(24, 36, 51, 0.96)' : 'rgba(255, 255, 255, 0.96)',
      borderColor: dark ? '#2c3b4d' : '#e6e8eb',
      borderWidth: 1,
      padding: [8, 12],
      textStyle: { color: dark ? '#f8fafc' : '#182433', fontSize: 12 },
      formatter(params) {
        const all = params || [];
        const hasAny = all.some((p) => p.value != null && p.value !== '-');
        if (!hasAny) return '';
        let out = `<div style="font-weight:600;margin-bottom:6px;color:${dark ? '#f8fafc' : '#182433'};">${all[0].axisValue}</div>`;
        for (const item of all) {
          const isMargin = item.seriesName === '毛利率';
          const hasValue = item.value != null && item.value !== '-';
          const valStr = !hasValue
            ? '—'
            : isMargin
              ? `${Number(item.value).toFixed(1)}%`
              : formatUsdFixed(item.value);
          out += `<div style="display:flex;align-items:center;justify-content:space-between;gap:18px;margin-top:3px;">
            <span style="color:${dark ? '#cbd5e1' : '#667382'}">${item.marker} ${item.seriesName}</span>
            <strong style="font-family:var(--tblr-font-monospace);font-variant-numeric:tabular-nums;">${valStr}</strong>
          </div>`;
        }
        const bucketIndex = all[0].dataIndex;
        const marginNull = all.some((p) => p.seriesName === '毛利率' && (p.value == null || p.value === '-'));
        if (marginNull) {
          out += `<div style="margin-top:4px;color:${dark ? '#9bb0cb' : '#667382'};font-size:11px;">毛利率 —：该小时没有可核算的售出，或站点全部缺余额快照</div>`;
        }
        if (bucketIndex != null && missingSites[bucketIndex] > 0) {
          out += `<div style="margin-top:4px;color:${dark ? '#9bb0cb' : '#667382'};font-size:11px;">另有 ${missingSites[bucketIndex]} 个站点缺该时段余额快照，未计入</div>`;
        }
        return out;
      },
    },
    legend: {
      top: 4,
      left: 'center',
      itemWidth: 10,
      itemHeight: 10,
      itemGap: 12,
      textStyle: { color: textColor, fontSize: 11 },
    },
    grid: {
      top: 46,
      left: 52,
      right: 46,
      bottom: 26,
    },
    xAxis: {
      type: 'category',
      data: buckets.map((b) => b.label),
      axisLine: { lineStyle: { color: axisLineColor } },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: {
        color: textColor,
        fontSize: 11,
        formatter(v) {
          return v.length >= 10 ? v.slice(5) : v;
        },
      },
    },
    yAxis: [
      {
        type: 'value',
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: splitLineColor, type: 'dashed' } },
        axisLabel: {
          color: textColor,
          fontSize: 11,
          formatter(v) {
            return `$${v}`;
          },
        },
      },
      {
        type: 'value',
        position: 'right',
        splitLine: { show: false },
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: textColor,
          fontSize: 11,
          formatter(v) {
            return `${v}%`;
          },
        },
      },
    ],
    series,
  };

  state.profitChart.setOption(option, true);
  state.profitChart.resize();
}

/**
 * 渲染整块站点盈利（筛选、表格、图表与磁贴联动）
 */
function renderProfit(data) {
  state.profitData = data;
  const sites = Array.isArray(data?.sites) ? data.sites : [];
  renderProfitSiteOptions(sites);
  const visibleSites = state.profitSite === 'all'
    ? sites
    : sites.filter((s) => s.account_id === state.profitSite);
  renderProfitTable(visibleSites, data);
  renderProfitChart(data, visibleSites);

  // 快照覆盖度更新 (财务行第 4 张卡)
  // no_cost（如 opencode go）没有上游账户，永远不可能有快照，不能计入分母
  const upstreamSites = sites.filter((s) => s.status !== 'no_cost');
  const totalSites = upstreamSites.length;
  const completeSites = upstreamSites.filter((s) => s.status === 'complete').length;
  const missingCount = upstreamSites.filter((s) => s.status === 'missing_balance').length;
  const pct = totalSites > 0 ? Math.round((completeSites / totalSites) * 100) : 0;

  const elIntegrityVal = document.getElementById('kpi-integrity-val');
  const elIntegrityBadge = document.getElementById('kpi-integrity-badge');
  const elIntegritySub = document.getElementById('kpi-integrity-sub');
  const elIntegrityProgress = document.getElementById('kpi-integrity-progress');

  if (elIntegrityVal) elIntegrityVal.textContent = `${pct}%`;
  if (elIntegrityBadge) elIntegrityBadge.textContent = `${completeSites} / ${totalSites} 站点`;
  if (elIntegritySub) {
    elIntegritySub.textContent = missingCount > 0 ? `${missingCount} 个站点待接入快照` : '全部站点快照已就绪';
  }
  if (elIntegrityProgress) elIntegrityProgress.style.width = `${pct}%`;

  // 磁贴 1: 上游站点数
  const elTileSites = document.getElementById('tile-upstream-sites');
  if (elTileSites) elTileSites.textContent = `${totalSites} 个`;

  // 磁贴 3: 未映射售出
  const elTileUnmapped = document.getElementById('tile-unmapped-rev');
  if (elTileUnmapped) elTileUnmapped.textContent = formatUsdFixed(data?.unmapped?.revenue || 0);
}

/**
 * 渲染上游账户表格
 */
function renderUpstreams(accounts) {
  const tbody = document.getElementById('tbody-upstreams');
  const countBadge = document.getElementById('upstream-count-badge');
  if (!tbody) return;

  const rawList = Array.isArray(accounts) ? accounts : [];
  // 排序：可核算的按余额从低到高（低余额先看），余额未知的次之，
  // 已禁用与没有上游账户（external）的垫底——它们不参与成本核算，不该占前排。
  const balanceOf = (acc) => {
    const v = acc.closing_balance ?? acc.opening_balance;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const rankOf = (acc) => {
    if (acc.enabled === false || acc.external) return 2;
    return balanceOf(acc) === null ? 1 : 0;
  };
  const list = [...rawList].sort((a, b) => {
    const ra = rankOf(a);
    const rb = rankOf(b);
    if (ra !== rb) return ra - rb;
    if (ra === 0) {
      const diff = balanceOf(a) - balanceOf(b);
      if (diff !== 0) return diff;
    }
    return String(a.name || a.id).localeCompare(String(b.name || b.id), 'zh-Hans-CN');
  });
  if (countBadge) {
    countBadge.textContent = `${list.length} 个账户`;
  }

  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="table-empty text-center text-secondary py-4">暂无配置的上游账户</td></tr>';
    return;
  }

  tbody.innerHTML = list.map((acc) => {
    const kindTag = acc.kind ? `<span class="badge bg-secondary-lt ms-1">${escapeHtml(acc.kind)}</span>` : '';
    const channelsCount = Array.isArray(acc.channels) ? acc.channels.length : 0;
    const channelMeta = channelsCount > 0 ? `${channelsCount} 个渠道` : '无映射渠道';

    const currentBalance = acc.closing_balance ?? acc.opening_balance ?? null;
    const balanceStr = formatUsd(currentBalance);
    // 支出无法核算时，缺少事件不等于 0 充值
    const creditsStr = acc.consumption == null && !(acc.credits > 0) ? '—' : formatUsd(acc.credits);
    const reported = acc.reported_consumption ?? null;
    const reportedStr = formatUsd(reported);
    const derivedStr = formatUsd(acc.consumption);
    const marginPctStr = formatPct(acc.margin_pct);

    let statusText = '待接入';
    if (acc.status === 'complete') statusText = '已核算';
    else if (acc.status === 'partial') statusText = '部分数据';
    else if (acc.status === 'unavailable') statusText = '待接快照';
    else if (acc.status === 'unconfigured') statusText = '未配置';
    const statusBadge = renderStatusBadge(acc.status, statusText);
    // 停用账户仍在列表里（排在末尾），必须显式标出来，否则会被当成采集故障
    const enabledBadge = acc.enabled === false
      ? '<span class="badge bg-secondary-lt text-secondary">已禁用</span>'
      : '<span class="badge bg-success-lt">启用</span>';

    const lastSync = acc.last_sync ?? null;
    const lastSyncStr = formatBeijingTime(lastSync);

    return `
      <tr>
        <td>
          <div class="upstream-acc-cell">
            <div class="upstream-acc-main">
              <strong class="upstream-acc-name">${escapeHtml(acc.name || acc.id)}</strong>
              ${kindTag}
            </div>
            <span class="upstream-acc-meta text-secondary small">${channelMeta}</span>
          </div>
        </td>
        <td class="cell-center">${enabledBadge}</td>
        <td class="num text-end">${balanceStr}</td>
        <td class="num text-end">${creditsStr}</td>
        <td class="num text-secondary text-end">${reportedStr}</td>
        <td class="num font-semibold text-end">${derivedStr}</td>
        <td class="num text-end">${marginPctStr}</td>
        <td class="cell-center">${statusBadge}</td>
        <td class="cell-center font-monospace text-secondary small">${lastSyncStr}</td>
      </tr>
    `;
  }).join('');
}

/**
 * 渠道/分组两张表的列模型
 * 表头与单元格由同一份定义生成：列选择器只切换 key 集合，
 * 不用 display:none 隐藏 <td>（那样表头与数据会错位）。
 */
const CHANNEL_COLUMNS = [
  {
    key: 'channel',
    label: '渠道',
    locked: true,
    cell: (c) => `<td>
          <div class="channel-pill">
            <span class="channel-id font-monospace text-secondary small">#${c.channel_id}</span>
            <span class="channel-name fw-medium">${escapeHtml(c.channel_name || '未命名渠道')}</span>
          </div>
        </td>`,
  },
  {
    key: 'revenue',
    label: '售出',
    headClass: 'num text-end',
    cell: (c) => `<td class="num font-semibold text-end">${formatUsd(c.revenue)}</td>`,
  },
  {
    key: 'tokens',
    label: 'Token',
    headClass: 'num text-end',
    cell: (c) => `<td class="num text-secondary text-end" title="${c.tokens_total == null ? '' : formatInt(c.tokens_total)}">${formatTokenCn(c.tokens_total)}</td>`,
  },
  {
    key: 'per-1e8',
    label: '额度/亿Token',
    headClass: 'num text-end',
    headTitle: '该渠道售出额最高模型的每 1 亿 Token 售出额',
    cell: (c) => renderTopModelCell(c.top_model),
  },
  {
    key: 'tps',
    label: 'TPS',
    headClass: 'num text-end',
    headTitle: '输出 token / 秒（区间累计输出 token ÷ 累计请求耗时）',
    cell: (c) => `<td class="num text-end">${c.archive_only === true ? '—' : formatTps(c.tps)}</td>`,
  },
  {
    key: 'requests',
    label: '请求数',
    headClass: 'num text-end',
    cell: (c) => `<td class="num text-end">${formatInt(c.requests)}</td>`,
  },
  {
    key: 'cache',
    label: '缓存率',
    headClass: 'num text-end',
    cell: (c) => `<td class="num text-end">${toneText(formatPct(c.cache_rate), cacheTone(c.cache_rate))}</td>`,
  },
  {
    key: 'p50',
    label: '延迟 p50',
    headClass: 'num text-end',
    cell: (c) => `<td class="num text-secondary text-end">${toneText(formatLatency(c.latency_p50), latencyP50Tone(c.latency_p50))}</td>`,
  },
  {
    key: 'p95',
    label: '延迟 p95',
    headClass: 'num text-end',
    cell: (c) => `<td class="num text-secondary text-end">${toneText(formatLatency(c.latency_p95), latencyP95Tone(c.latency_p95))}</td>`,
  },
  {
    key: 'last',
    label: '最后请求',
    cell: (c) => `<td class="font-monospace text-secondary small">${formatBeijingTime(c.last_t)}</td>`,
  },
  {
    key: 'upstream',
    label: '上游账户',
    cell: (c) => `<td>${channelOwnerTag(c)}</td>`,
  },
];

const GROUP_COLUMNS = [
  {
    key: 'group',
    label: '分组',
    locked: true,
    cell: (g) => `<td>${g.group_name === '' ? '<span class="text-secondary">未分组</span>' : escapeHtml(g.group_name)}</td>`,
  },
  {
    key: 'revenue',
    label: '售出',
    headClass: 'num text-end',
    cell: (g) => `<td class="num font-semibold text-end">${formatUsd(g.revenue)}</td>`,
  },
  {
    key: 'tokens',
    label: 'Token',
    headClass: 'num text-end',
    cell: (g) => `<td class="num text-secondary text-end" title="${g.tokens == null ? '' : formatInt(g.tokens)}">${formatTokenCn(g.tokens)}</td>`,
  },
  {
    key: 'per-1e8',
    label: '额度/亿Token',
    headClass: 'num text-end',
    headTitle: '该分组售出额最高模型的每 1 亿 Token 售出额',
    cell: (g) => renderTopModelCell(g.top_model),
  },
  {
    key: 'tps',
    label: 'TPS',
    headClass: 'num text-end',
    headTitle: '输出 token / 秒（区间累计输出 token ÷ 累计请求耗时）',
    cell: (g) => `<td class="num text-end">${formatTps(g.tps)}</td>`,
  },
  {
    key: 'requests',
    label: '请求数',
    headClass: 'num text-end',
    cell: (g) => `<td class="num text-end">${formatInt(g.requests)}</td>`,
  },
  {
    key: 'cache',
    label: '缓存率',
    headClass: 'num text-end',
    cell: (g) => `<td class="num text-end">${toneText(formatPct(g.cache_rate), cacheTone(g.cache_rate))}</td>`,
  },
  {
    key: 'p50',
    label: '延迟 p50',
    headClass: 'num text-end',
    cell: (g) => `<td class="num text-secondary text-end">${toneText(formatLatency(g.p50), latencyP50Tone(g.p50))}</td>`,
  },
  {
    key: 'p95',
    label: '延迟 p95',
    headClass: 'num text-end',
    cell: (g) => `<td class="num text-secondary text-end">${toneText(formatLatency(g.p95), latencyP95Tone(g.p95))}</td>`,
  },
  {
    key: 'last',
    label: '最后请求',
    cell: (g) => `<td class="font-monospace text-secondary small">${formatBeijingTime(g.last_t)}</td>`,
  },
  {
    key: 'channels',
    label: '渠道数',
    headClass: 'num text-end',
    cell: (g) => {
      const names = Array.isArray(g.channel_names) ? g.channel_names : [];
      return `<td class="num text-end" title="${escapeHtml(names.join('、'))}">${formatInt(g.channels)}</td>`;
    },
  },
];

const COL_STORAGE = {
  channels: 'relay-ledger-cols-channels',
  groups: 'relay-ledger-cols-groups',
};

/** 改名前的列选择键，只用于一次性迁移 */
const LEGACY_COL_STORAGE = {
  'relay-ledger-cols-channels': 'madfu-cols-channels',
  'relay-ledger-cols-groups': 'madfu-cols-groups',
};

/**
 * 读取某张表的可见列：与列模型取交集并保持模型顺序。
 * 锁定列（渠道/分组名与售出）始终保留，否则表就没有意义了。
 */
function readColumnKeys(columns, storageKey) {
  const all = columns.map((c) => c.key);
  let saved = null;
  try {
    const raw = readMigratedKey(storageKey, LEGACY_COL_STORAGE[storageKey]);
    if (raw) saved = JSON.parse(raw);
  } catch {
    saved = null;
  }
  const valid = new Set(all);
  const keep = new Set(Array.isArray(saved) ? saved.filter((k) => valid.has(k)) : all);
  for (const c of columns) if (c.locked) keep.add(c.key);
  return all.filter((k) => keep.has(k));
}

function writeColumnKeys(storageKey, keys) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(keys));
  } catch {
    // 隐私模式下写入失败：本次仍按已选列渲染，只是刷新后不保留
  }
}

function paintTableHead(table, columns, keys) {
  const tr = table && table.querySelector('thead tr');
  if (!tr) return;
  const byKey = new Map(columns.map((c) => [c.key, c]));
  tr.innerHTML = keys.map((k) => {
    const col = byKey.get(k);
    if (!col) return '';
    const cls = col.headClass ? ` class="${col.headClass}"` : '';
    const title = col.headTitle ? ` title="${escapeHtml(col.headTitle)}"` : '';
    return `<th data-col="${k}"${cls}${title}>${escapeHtml(col.label)}</th>`;
  }).join('');
}

function paintTableBody(tbody, columns, keys, rows, emptyText) {
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const cols = keys.map((k) => byKey.get(k)).filter(Boolean);
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${Math.max(cols.length, 1)}" class="table-empty text-center text-secondary py-4">${emptyText}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r) => `<tr>${cols.map((c) => c.cell(r)).join('')}</tr>`).join('');
}

/**
 * 卡头右侧的列选择器：按钮 + 多选面板，选择存 localStorage。
 * onChange 由调用方提供，用来按新的列集合重画表头与表格。
 */
function mountColumnPicker(hostId, columns, storageKey, onChange) {
  const host = document.getElementById(hostId);
  if (!host || host.dataset.mounted === '1') return;
  host.dataset.mounted = '1';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-sm btn-outline-secondary col-picker-btn';
  button.setAttribute('aria-expanded', 'false');
  button.innerHTML = '列 <span class="col-picker-count" data-count></span>';

  const list = document.createElement('div');
  list.className = 'col-picker-list';

  const foot = document.createElement('div');
  foot.className = 'col-picker-foot';
  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.className = 'col-picker-all';
  allBtn.textContent = '全部显示';
  foot.appendChild(allBtn);

  const menu = document.createElement('div');
  menu.className = 'col-picker-menu';
  menu.hidden = true;
  menu.append(list, foot);

  host.append(button, menu);

  const updateCount = () => {
    const keys = readColumnKeys(columns, storageKey);
    const el = button.querySelector('[data-count]');
    if (el) el.textContent = `${keys.length}/${columns.length}`;
  };

  const paintList = () => {
    const active = new Set(readColumnKeys(columns, storageKey));
    list.innerHTML = columns.map((c) => `
      <label class="col-picker-item${c.locked ? ' is-locked' : ''}">
        <input type="checkbox" data-key="${c.key}"${active.has(c.key) ? ' checked' : ''}${c.locked ? ' disabled' : ''}>
        <span>${escapeHtml(c.label)}</span>
      </label>
    `).join('');
  };

  const close = () => {
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  };

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) {
      paintList();
      menu.hidden = false;
      button.setAttribute('aria-expanded', 'true');
    } else {
      close();
    }
  });
  menu.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => { if (!menu.hidden) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) close(); });

  list.addEventListener('change', () => {
    const keys = [...list.querySelectorAll('input[data-key]')]
      .filter((el) => el.checked || el.disabled)
      .map((el) => el.dataset.key);
    writeColumnKeys(storageKey, keys);
    updateCount();
    onChange();
  });

  allBtn.addEventListener('click', () => {
    writeColumnKeys(storageKey, columns.map((c) => c.key));
    paintList();
    updateCount();
    onChange();
  });

  updateCount();
}

/** 上游账户列：把 margin_status 翻成徽标 */
function channelOwnerTag(c) {
  const name = escapeHtml(c.upstream_account || '');
  switch (c.margin_status) {
    case 'unconfigured':
      return '<span class="badge badge-neutral">未配置上游</span>';
    case 'unallocated':
      return `<span class="badge badge-info" title="上游账户供多渠道共享">${name} (共享未分摊)</span>`;
    case 'unavailable':
      return `<span class="badge badge-amber" title="缺少余额快照">${name} (待接快照)</span>`;
    case 'disabled_account':
      return `<span class="badge badge-amber" title="上游账户已停用">${name} (已停用)</span>`;
    case 'partial':
      return `<span class="badge badge-amber">${name} (部分数据)</span>`;
    default:
      return `<span class="badge badge-success">${name} (${c.margin_status})</span>`;
  }
}

/**
 * 额度/亿Token 单元格：主行数值、次行模型名；没有模型维度（归档行）显示 —
 */
function renderTopModelCell(topModel) {
  if (!topModel) return '<td class="num text-end text-secondary">—</td>';
  const n = Number(topModel.per_1e8);
  const value = topModel.per_1e8 == null || !Number.isFinite(n) ? '—' : n.toFixed(2);
  return `<td class="num text-end top-model-cell">
      <div>${value}</div>
      <div class="top-model-name">${escapeHtml(topModel.model)}</div>
    </td>`;
}

/**
 * 渲染渠道经营表现表
 */
function renderChannels(channelRows) {
  const tbody = document.getElementById('tbody-channels');
  const table = document.getElementById('table-channels');
  const countBadge = document.getElementById('channel-count-badge');
  if (!tbody || !table) return;

  const list = Array.isArray(channelRows) ? channelRows : [];
  state.channelRows = list;

  if (countBadge) countBadge.textContent = `${list.length} 个渠道`;

  // 磁贴 2: 在售渠道数
  const elTileChannels = document.getElementById('tile-channels-count');
  if (elTileChannels) elTileChannels.textContent = `${list.length} 个`;

  const keys = readColumnKeys(CHANNEL_COLUMNS, COL_STORAGE.channels);
  paintTableHead(table, CHANNEL_COLUMNS, keys);
  paintTableBody(tbody, CHANNEL_COLUMNS, keys, list, '所选区间内暂无渠道计费记录');
}

/**
 * 渲染分组经营表现表
 */
function renderGroups(groupRows) {
  const tbody = document.getElementById('tbody-groups');
  const table = document.getElementById('table-groups');
  const countBadge = document.getElementById('group-count-badge');
  if (!tbody || !table) return;

  const list = Array.isArray(groupRows) ? groupRows : [];
  state.groupRows = list;

  if (countBadge) countBadge.textContent = `${list.length} 个分组`;

  const keys = readColumnKeys(GROUP_COLUMNS, COL_STORAGE.groups);
  paintTableHead(table, GROUP_COLUMNS, keys);
  paintTableBody(tbody, GROUP_COLUMNS, keys, list, '所选区间内暂无分组计费记录');
}

/**
 * 渲染数据质量与任务状态区
 */
function renderQuality(qData) {
  const elSourceTime = document.getElementById('q-source-time');
  const elSourceFreshness = document.getElementById('q-source-freshness');
  const elSourceRows = document.getElementById('q-source-rows');
  const elErrorRows = document.getElementById('q-error-rows');
  const elErrorSub = document.getElementById('q-error-sub');
  const elSchema = document.getElementById('q-schema-status');
  const elChecked = document.getElementById('q-checked-time');
  const elJobsSummary = document.getElementById('q-jobs-summary');
  const elSourceBadge = document.getElementById('q-source-badge');
  const elTaskBadge = document.getElementById('q-task-badge');
  const elCollectErrors = document.getElementById('q-collect-errors');
  const jobsEmptyCallout = document.getElementById('jobs-empty-callout');
  const jobsTableWrap = document.getElementById('jobs-table-wrap');
  const tbodyJobs = document.getElementById('tbody-jobs');

  // 磁贴 4: 数据新鲜度
  const elTileFreshness = document.getElementById('tile-freshness');
  if (elTileFreshness) elTileFreshness.textContent = formatFreshness(qData.source_last_t);

  // 1. 源库最新日志与新鲜度
  if (elSourceTime) elSourceTime.textContent = formatBeijingTime(qData.source_last_t, false);
  if (elSourceFreshness) elSourceFreshness.textContent = formatFreshness(qData.source_last_t);

  // 2. 日志总行数
  if (elSourceRows) elSourceRows.textContent = qData.source_rows != null ? formatInt(qData.source_rows) : '—';

  // 3. 错误日志
  if (elErrorRows) {
    if (qData.error_rows == null) {
      elErrorRows.textContent = '—';
    } else if (qData.error_rows === 0) {
      elErrorRows.textContent = '0 条';
      elErrorRows.className = 'quality-val num text-success';
    } else {
      elErrorRows.textContent = `${formatInt(qData.error_rows)} 条`;
      elErrorRows.className = 'quality-val num text-danger fw-bold';
    }
  }
  if (elErrorSub) elErrorSub.textContent = '';

  // 4. Schema 状态
  if (elSchema) {
    if (qData.schema_ok === true) {
      elSchema.innerHTML = '<span class="badge badge-success">正常</span>';
    } else if (qData.schema_ok === false) {
      elSchema.innerHTML = '<span class="badge badge-danger">字段缺失</span>';
    } else {
      elSchema.innerHTML = '<span class="badge badge-neutral">—</span>';
    }
  }

  // 5. 检查时间
  if (elChecked) elChecked.textContent = formatBeijingTime(qData.checked_at, false);

  // 6. 源库总徽章
  if (elSourceBadge) {
    if (qData.schema_ok && (qData.source_rows || 0) > 0) {
      elSourceBadge.className = 'badge badge-success';
      elSourceBadge.textContent = '源库就绪';
    } else {
      elSourceBadge.className = 'badge badge-amber';
      elSourceBadge.textContent = '源库待核对';
    }
  }

  // 7. 任务运行监控
  const jobRuns = Array.isArray(qData.job_runs) ? qData.job_runs : [];

  if (jobRuns.length === 0) {
    if (elJobsSummary) elJobsSummary.innerHTML = '<span class="badge badge-neutral">未接入任务</span>';
    if (elTaskBadge) {
      elTaskBadge.className = 'badge badge-neutral';
      elTaskBadge.textContent = '采集待接入';
    }
    if (jobsEmptyCallout) jobsEmptyCallout.hidden = false;
    if (jobsTableWrap) jobsTableWrap.hidden = true;
    const elCollectTimeEmpty = document.getElementById('collect-time');
    if (elCollectTimeEmpty) elCollectTimeEmpty.textContent = '—';
  } else {
    const now = Date.now();
    let failedCount = 0;
    let stalledCount = 0;
    let runningCount = 0;
    let latestRunTime = 0;

    for (const j of jobRuns) {
      const isFailed = j.status === 'failed' || j.status === 'error';
      const isFinished = Boolean(j.finished_at);
      const isStalled = !isFinished && j.started_at && (now - j.started_at > 15 * 60 * 1000);
      const isRunning = !isFinished && !isStalled;

      if (isFailed) failedCount += 1;
      else if (isStalled) stalledCount += 1;
      else if (isRunning) runningCount += 1;

      const runT = j.finished_at || j.started_at || 0;
      if (runT > latestRunTime) latestRunTime = runT;
    }

    // 顶部「上次采集」取最近一次站点日志采集：数据截止看业务，管道健康单独看这里。
    const elCollectTime = document.getElementById('collect-time');
    if (elCollectTime) {
      const logsRuns = jobRuns.filter((j) => j.job === 'collect-site-logs');
      const latestCollect = (logsRuns.length ? logsRuns : jobRuns).reduce(
        (acc, j) => Math.max(acc, j.finished_at || j.started_at || 0),
        0,
      );
      elCollectTime.textContent = latestCollect ? formatBeijingTime(latestCollect, false) : '—';
    }

    if (failedCount > 0) {
      if (elJobsSummary) elJobsSummary.innerHTML = `<span class="badge badge-danger">${failedCount} 个失败</span>`;
      if (elTaskBadge) {
        elTaskBadge.className = 'badge badge-danger';
        elTaskBadge.textContent = `${failedCount} 个任务失败`;
      }
    } else if (stalledCount > 0) {
      if (elJobsSummary) elJobsSummary.innerHTML = `<span class="badge badge-amber">${stalledCount} 个停滞</span>`;
      if (elTaskBadge) {
        elTaskBadge.className = 'badge badge-amber';
        elTaskBadge.textContent = '采集已停滞';
      }
    } else if (runningCount > 0) {
      if (elJobsSummary) elJobsSummary.innerHTML = `<span class="badge badge-info">${runningCount} 个运行中</span>`;
      if (elTaskBadge) {
        elTaskBadge.className = 'badge badge-info';
        elTaskBadge.textContent = '采集中';
      }
    } else {
      const diffMs = Math.max(0, now - latestRunTime);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffMinutes = Math.floor(diffMs / 60000);

      if (diffHours >= 2) {
        const text = `已 ${diffHours} 小时未采集`;
        if (elJobsSummary) elJobsSummary.innerHTML = `<span class="badge badge-amber">${text}</span>`;
        if (elTaskBadge) {
          elTaskBadge.className = 'badge badge-amber';
          elTaskBadge.textContent = text;
        }
      } else {
        const timeText = diffMinutes < 1 ? '刚刚' : `${diffMinutes} 分钟前`;
        const text = `上次采集 ${timeText}`;
        if (elJobsSummary) elJobsSummary.innerHTML = `<span class="badge badge-success">${text}</span>`;
        if (elTaskBadge) {
          elTaskBadge.className = 'badge badge-success';
          elTaskBadge.textContent = text;
        }
      }
    }

    if (jobsEmptyCallout) jobsEmptyCallout.hidden = true;
    if (jobsTableWrap) jobsTableWrap.hidden = false;

    if (tbodyJobs) {
      tbodyJobs.innerHTML = jobRuns.slice(0, 5).map((j) => {
        const isFailed = j.status === 'failed' || j.status === 'error';
        const isFinished = Boolean(j.finished_at);
        const isStalled = !isFinished && j.started_at && (now - j.started_at > 15 * 60 * 1000);

        let statusBadge = '<span class="badge badge-success">成功</span>';
        if (isFailed) statusBadge = '<span class="badge badge-danger">失败</span>';
        else if (isStalled) statusBadge = '<span class="badge badge-amber">已停滞</span>';
        else if (!isFinished) statusBadge = '<span class="badge badge-info">执行中</span>';

        let durationStr = '—';
        if (j.started_at && j.finished_at) {
          const durMs = j.finished_at - j.started_at;
          durationStr = durMs < 1000 ? `${durMs} ms` : `${(durMs / 1000).toFixed(1)} s`;
        } else if (!isFinished && j.started_at) {
          durationStr = `已持续 ${Math.floor((now - j.started_at) / 60000)} 分钟`;
        }

        return `
          <tr>
            <td><strong>${escapeHtml(j.job || '未命名任务')}</strong></td>
            <td class="cell-center">${statusBadge}</td>
            <td class="font-monospace text-secondary small">${formatBeijingTime(j.started_at, false)}</td>
            <td class="text-secondary">${durationStr}</td>
            <td class="text-secondary">${escapeHtml(j.detail || '—')}</td>
          </tr>
        `;
      }).join('');
    }
  }

  // 8. 采集失败账户：有失败才显示，title 逐条列出名称、原因与时间
  if (elCollectErrors) {
    const errors = Array.isArray(qData.collect_errors) ? qData.collect_errors : [];
    if (errors.length > 0) {
      elCollectErrors.hidden = false;
      elCollectErrors.textContent = `采集失败 ${errors.length} 个`;
      elCollectErrors.title = errors.map((item) => {
        const name = item?.name || item?.account_id || '未知账户';
        const reason = item?.reason || 'unknown';
        return `${name} · ${reason} · ${formatBeijingTime(item?.at, false)}`;
      }).join('\n');
    } else {
      elCollectErrors.hidden = true;
      elCollectErrors.textContent = '';
      elCollectErrors.title = '';
    }
  }
}

// ============================================================================
// 错误隔离与分区重载
// ============================================================================

function renderSectionError(containerId, message, retryFn) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const errDiv = document.createElement('div');
  errDiv.className = 'alert alert-danger d-flex align-items-center justify-content-between p-2 my-2';
  errDiv.innerHTML = `
    <span>${escapeHtml(message)}</span>
    <button type="button" class="btn btn-sm btn-outline-danger ms-2">重试</button>
  `;
  const retryBtn = errDiv.querySelector('button');
  if (retryBtn && retryFn) {
    retryBtn.addEventListener('click', () => {
      errDiv.remove();
      retryFn();
    });
  }
  container.prepend(errDiv);
}

// ============================================================================
// 批量并行数据装载流水线
// ============================================================================

// 整点采集在每小时 +10 秒落库，单轮约 30 秒完成；
// 页面固定在采集落库之后刷新一次，其余时间不做轮询。
// 余额每 15 分钟采一次（:10 / :25 / :40 / :55），站点日志紧随其后（:00:45 / :15:45 / :30:45 / :45:45）；留到 :12 / :27 / :42 / :57，
// 成本与售出才是同一段区间。
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const REFRESH_OFFSET_MS = 12 * 60 * 1000;
const STALE_AFTER_MS = 10 * 60 * 1000;
let hourlyRefreshTimer = null;
let lastLoadedAt = 0;

function scheduleHourlyRefresh() {
  if (hourlyRefreshTimer) clearTimeout(hourlyRefreshTimer);
  const now = Date.now();
  let nextAt = Math.ceil((now - REFRESH_OFFSET_MS) / REFRESH_INTERVAL_MS) * REFRESH_INTERVAL_MS + REFRESH_OFFSET_MS;
  if (nextAt <= now) nextAt += REFRESH_INTERVAL_MS;
  hourlyRefreshTimer = setTimeout(() => {
    hourlyRefreshTimer = null;
    // 页面在后台时不拉数据，直接排到下一个刷新点
    if (document.visibilityState === 'visible') {
      loadAllData();
    } else {
      scheduleHourlyRefresh();
    }
  }, nextAt - now);
}

/**
 * 刷新所有数据区块（并行执行，错误互不阻塞）
 */
export async function loadAllData() {
  if (state.isLoading) return;
  state.isLoading = true;
  setProgress(true);

  const refreshBtn = document.getElementById('btn-refresh');
  if (refreshBtn) refreshBtn.classList.add('loading');

  const range = state.range;
  const rangeParams = {
    from: range.from,
    to: range.to,
  };
  const rangeInfo = { from: range.from, to: range.to, rangeType: state.rangeType };

  // 计算上一个等长周期的参数（用于 KPI 环比计算）
  const span = range.to - range.from;
  const prevParams = {
    from: Math.max(0, range.from - span),
    to: range.from,
    granularity: trendGranularity(state.rangeType),
  };

  try {
    const results = await Promise.allSettled([
      fetchJson('/api/overview', rangeParams),
      fetchJson('/api/trend', { ...rangeParams, granularity: trendGranularity(state.rangeType) }),
      fetchJson('/api/channels', rangeParams),
      fetchJson('/api/upstreams', rangeParams),
      fetchJson('/api/quality'),
      fetchJson('/api/profit', { ...rangeParams, granularity: state.profitGranularity }),
      fetchJson('/api/trend', prevParams), // 允许的一处新增数据请求：上周期趋势
      fetchJson('/api/groups', rangeParams),
    ]);

    updateRangeLabels(rangeInfo);

    const currTrend = results[1].status === 'fulfilled' ? results[1].value : { points: [] };
    const prevTrend = results[6].status === 'fulfilled' ? results[6].value : { points: [] };

    // 0: Overview
    if (results[0].status === 'fulfilled') {
      renderOverview(results[0].value, currTrend, prevTrend);
    } else {
      console.error('[Dashboard] Overview 加载失败:', results[0].reason);
      renderSectionError('card-revenue', '概览指标加载失败', () => loadAllData());
    }

    // 1: Trend
    if (results[1].status === 'fulfilled') {
      renderTrend(results[1].value);
    } else {
      console.error('[Dashboard] Trend 加载失败:', results[1].reason);
      renderTrend({ points: [] });
    }

    // 2: Channels
    if (results[2].status === 'fulfilled') {
      renderChannels(results[2].value?.rows || []);
    } else {
      console.error('[Dashboard] Channels 加载失败:', results[2].reason);
      const tbody = document.getElementById('tbody-channels');
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="11" class="table-error text-danger text-center py-4">渠道数据加载失败: ${escapeHtml(results[2].reason?.message || '未知错误')}</td></tr>`;
      }
    }

    // 3: Upstreams
    if (results[3].status === 'fulfilled') {
      renderUpstreams(results[3].value?.accounts || []);
    } else {
      console.error('[Dashboard] Upstreams 加载失败:', results[3].reason);
      const tbody = document.getElementById('tbody-upstreams');
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="8" class="table-error text-danger text-center py-4">上游数据加载失败: ${escapeHtml(results[3].reason?.message || '未知错误')}</td></tr>`;
      }
    }

    // 4: Quality
    if (results[4].status === 'fulfilled') {
      renderQuality(results[4].value);
    } else {
      console.error('[Dashboard] Quality 加载失败:', results[4].reason);
    }

    // 5: Profit
    if (results[5].status === 'fulfilled') {
      renderProfit(results[5].value);
    } else {
      console.error('[Dashboard] Profit 加载失败:', results[5].reason);
      renderProfitFallback(`盈利数据加载失败：${results[5].reason?.message || '未知错误'}`);
      const tbodyProfit = document.getElementById('tbody-profit');
      if (tbodyProfit) {
        tbodyProfit.innerHTML = `<tr><td colspan="7" class="table-error text-danger text-center py-4">盈利数据加载失败: ${escapeHtml(results[5].reason?.message || '未知错误')}</td></tr>`;
      }
    }

    // 7: Groups
    if (results[7].status === 'fulfilled') {
      renderGroups(results[7].value?.groups || []);
    } else {
      console.error('[Dashboard] Groups 加载失败:', results[7].reason);
      const tbodyGroups = document.getElementById('tbody-groups');
      if (tbodyGroups) {
        tbodyGroups.innerHTML = `<tr><td colspan="11" class="table-error text-danger text-center py-4">分组数据加载失败: ${escapeHtml(results[7].reason?.message || '未知错误')}</td></tr>`;
      }
    }

    // 趋势图的售出柱依赖盈利接口的按站点序列：profit 晚于 trend 返回，这里补一次重绘
    if (state.currTrendData) renderTrend(state.currTrendData);
  } finally {
    state.isLoading = false;
    setProgress(false);
    if (refreshBtn) refreshBtn.classList.remove('loading');
    lastLoadedAt = Date.now();
    scheduleHourlyRefresh();
  }
}

/**
 * 仅重新拉取站点盈利（切换日/小时粒度时使用）
 */
async function loadProfitOnly() {
  if (!state.range) return;
  try {
    const data = await fetchJson('/api/profit', {
      from: state.range.from,
      to: state.range.to,
      granularity: state.profitGranularity,
    });
    renderProfit(data);
    // 日/小时粒度切换后重写一次区间标签，避免残留
    updateRangeLabels();
  } catch (err) {
    console.error('[Dashboard] Profit 加载失败:', err);
    renderProfitFallback(`盈利数据加载失败：${err.message}`);
    const tbody = document.getElementById('tbody-profit');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="7" class="table-error text-danger text-center py-4">盈利数据加载失败: ${escapeHtml(err.message)}</td></tr>`;
    }
  }
}

// ============================================================================
// 交互事件绑定与应用入口
// ============================================================================

function bindEvents() {
  // 1. 范围预设切换
  const segButtons = document.querySelectorAll('#range-presets .seg-btn');
  segButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('active')) return;
      segButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      const rangeType = btn.dataset.range || '7d';
      state.rangeType = rangeType;
      state.range = computeRange(rangeType, state.meta);
      updateRangeLabels();
      setProfitGranularity(rangeType === '24h' ? 'hour' : 'day');
      loadAllData();
    });
  });

  // 2. 刷新按钮
  const refreshBtn = document.getElementById('btn-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      try {
        state.meta = await fetchJson('/api/meta');
        updateMetaDisplay(state.meta);
        state.range = computeRange(state.rangeType, state.meta);
        updateRangeLabels();
      } catch (err) {
        console.warn('刷新元信息失败，沿用现有范围:', err);
      }
      loadAllData();
    });
  }

  // 3. 主题切换按钮
  const themeToggleBtn = document.getElementById('btn-theme-toggle');
  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
      const nextTheme = isDarkMode() ? 'light' : 'dark';
      applyTheme(nextTheme);
    });
  }

  // 4. 系统深浅色切换监听
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!readMigratedKey(THEME_KEY, LEGACY_THEME_KEY)) {
        const nextTheme = e.matches ? 'dark' : 'light';
        document.documentElement.setAttribute('data-bs-theme', nextTheme);
        document.documentElement.dataset.theme = nextTheme;
        refreshChartsTheme();
      }
    });
  }

  // 5. 经营明细：渠道与上游账户已是两张并列卡片，无需标签切换

  // 6. 站点盈利：日/小时粒度切换
  const profitSegButtons = document.querySelectorAll('#profit-granularity .seg-btn');
  profitSegButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('active')) return;
      profitSegButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.profitGranularity = btn.dataset.granularity === 'hour' ? 'hour' : 'day';
      setProfitGranularity(state.profitGranularity);
      loadProfitOnly();
    });
  });

  // 7. 站点盈利：站点筛选（本地重绘，不重新请求）
  const profitSite = document.getElementById('profit-site');
  if (profitSite) {
    profitSite.addEventListener('change', () => {
      state.profitSite = profitSite.value || 'all';
      if (state.profitData) renderProfit(state.profitData);
    });
  }

  // 8. 数据质量区：展开/收起任务明细
  const toggleJobsBtn = document.getElementById('btn-toggle-jobs');
  const qualityDrawer = document.getElementById('quality-drawer');
  if (toggleJobsBtn && qualityDrawer) {
    toggleJobsBtn.addEventListener('click', () => {
      const isExpanded = toggleJobsBtn.getAttribute('aria-expanded') === 'true';
      toggleJobsBtn.setAttribute('aria-expanded', String(!isExpanded));
      qualityDrawer.hidden = isExpanded;
      toggleJobsBtn.classList.toggle('active', !isExpanded);
    });
  }

  // 9. 渠道/分组表的列选择器：选择存 localStorage，切换后按新列集合重画
  mountColumnPicker('cols-channels', CHANNEL_COLUMNS, COL_STORAGE.channels, () => {
    renderChannels(state.channelRows);
  });
  mountColumnPicker('cols-groups', GROUP_COLUMNS, COL_STORAGE.groups, () => {
    renderGroups(state.groupRows);
  });

  // 10. 窗口尺寸自适应监听
  window.addEventListener('resize', () => {
    try {
      state.chartInstance?.resize();
      state.profitChart?.resize();
      window.echarts?.getInstanceByDom(document.getElementById('sparkline-revenue'))?.resize();
      window.echarts?.getInstanceByDom(document.getElementById('sparkline-tokens'))?.resize();
      window.echarts?.getInstanceByDom(document.getElementById('sparkline-requests'))?.resize();
      window.echarts?.getInstanceByDom(document.getElementById('sparkline-cache'))?.resize();
    } catch {
      // 忽略隐藏状态 resize
    }
  });
}

function updateMetaDisplay(meta) {
  const cutoffTimeEl = document.getElementById('cutoff-time');
  if (cutoffTimeEl) {
    cutoffTimeEl.textContent = formatBeijingTime(meta.max_t);
  }

  // 品牌名来自实例配置（/api/meta 的 site_name）：仓库里不留任何站点专属字样。
  const brand = typeof meta.site_name === 'string' && meta.site_name
    ? meta.site_name
    : typeof meta.site === 'string' ? meta.site : '';
  if (!brand) return;
  const brandEl = document.getElementById('brand-name');
  if (brandEl) brandEl.textContent = brand;
  const footerEl = document.getElementById('footer-brand');
  if (footerEl) footerEl.textContent = `${brand} 经营看板`;
  document.title = `${brand} 经营看板`;
}

/**
 * 页面入口启动函数
 */
async function initApp() {
  const savedTheme = readMigratedKey(THEME_KEY, LEGACY_THEME_KEY);
  if (savedTheme === 'dark' || savedTheme === 'light') {
    document.documentElement.setAttribute('data-bs-theme', savedTheme);
    document.documentElement.dataset.theme = savedTheme;
  } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    document.documentElement.setAttribute('data-bs-theme', 'dark');
    document.documentElement.dataset.theme = 'dark';
  } else {
    document.documentElement.setAttribute('data-bs-theme', 'light');
    document.documentElement.dataset.theme = 'light';
  }

  bindEvents();
  // 从后台切回时，若数据已过期就补一次刷新（整点刷新在后台是被跳过的）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastLoadedAt > STALE_AFTER_MS) loadAllData();
  });
  try {
    state.meta = await fetchJson('/api/meta');
    updateMetaDisplay(state.meta);
    state.range = computeRange(state.rangeType, state.meta);
    updateRangeLabels();
    await loadAllData();
  } catch (err) {
    console.error('[Dashboard] 看板初始化失败:', err);
    const cutoffTimeEl = document.getElementById('cutoff-time');
    if (cutoffTimeEl) cutoffTimeEl.textContent = '无法连接服务';
    renderSectionError('card-revenue', `服务初始化异常: ${err.message}`, () => initApp());
  }
}

// DOM 就绪后启动
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
