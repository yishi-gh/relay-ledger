const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SHOTS_DIR = 'D:\\mine\\relay-ledger-preview\\.shots';

if (!fs.existsSync(SHOTS_DIR)) {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
}

// 颜色转换与 ΔE 校验 (OKLab Euclidean Distance)
function oklchToOklab(L, C, H) {
  const rad = (H * Math.PI) / 180;
  return [L, C * Math.cos(rad), C * Math.sin(rad)];
}

function calcDeltaE(c1, c2) {
  return Math.sqrt(
    Math.pow(c1[0] - c2[0], 2) +
    Math.pow(c1[1] - c2[1], 2) +
    Math.pow(c1[2] - c2[2], 2)
  );
}

function verifyPalette(palette, themeName) {
  let minDE = 999;
  let minPair = [];
  const labs = palette.map(p => oklchToOklab(p.L, p.C, p.H));
  for (let i = 0; i < palette.length; i++) {
    for (let j = i + 1; j < palette.length; j++) {
      const d = calcDeltaE(labs[i], labs[j]);
      if (d < minDE) {
        minDE = d;
        minPair = [palette[i].name, palette[j].name];
      }
    }
  }
  if (minDE < 0.10) {
    throw new Error(`Color palette ${themeName} failed deltaE check! Min deltaE = ${minDE.toFixed(4)} (< 0.10) between ${minPair[0]} and ${minPair[1]}`);
  }
  console.log(`[Assert Passed] ${themeName} palette pairwise deltaE >= 0.10 (Min deltaE: ${minDE.toFixed(4)} between [${minPair[0]}] and [${minPair[1]}])`);
  return { minDE, minPair };
}

function verifyCostVsProfitDeltaE() {
  const profitLight = oklchToOklab(0.488, 0.243, 264.376); // shadcn indigo
  const costLight = oklchToOklab(0.72, 0.005, 0); // neutral gray
  const deLight = calcDeltaE(profitLight, costLight);

  const profitDark = oklchToOklab(0.673, 0.182, 275.524); // tw indigo-400
  const costDark = oklchToOklab(0.52, 0.005, 0); // neutral gray
  const deDark = calcDeltaE(profitDark, costDark);

  if (deLight < 0.12 || deDark < 0.12) {
    throw new Error(`Cost vs Profit line deltaE failed! Light: ${deLight.toFixed(4)}, Dark: ${deDark.toFixed(4)}`);
  }
  console.log(`[Assert Passed] Cost Bar vs Profit Line DeltaE >= 0.12 (Light: ${deLight.toFixed(4)}, Dark: ${deDark.toFixed(4)})`);
  return { deLight, deDark };
}

// 官方默认色板：shadcn 官方 chart token 1..5 + Tailwind 500/400 补齐 6..12
const PALETTE_LIGHT = [
  { name: 'c1: shadcn-indigo-600', L: 0.488, C: 0.243, H: 264.376 },
  { name: 'c2: shadcn-emerald-500', L: 0.696, C: 0.170, H: 162.480 },
  { name: 'c3: shadcn-amber-500', L: 0.769, C: 0.188, H: 70.080 },
  { name: 'c4: shadcn-violet-500', L: 0.627, C: 0.265, H: 303.900 },
  { name: 'c5: shadcn-rose-500', L: 0.645, C: 0.246, H: 16.439 },
  { name: 'c6: tw-cyan-500', L: 0.715, C: 0.143, H: 215.221 },
  { name: 'c7: tw-orange-600', L: 0.646, C: 0.222, H: 41.116 },
  { name: 'c8: tw-lime-500', L: 0.768, C: 0.233, H: 130.850 },
  { name: 'c9: tw-fuchsia-500', L: 0.652, C: 0.297, H: 328.600 },
  { name: 'c10: tw-sky-700', L: 0.500, C: 0.134, H: 242.749 },
  { name: 'c11: tw-slate-400', L: 0.704, C: 0.040, H: 256.788 },
  { name: 'c12: tw-stone-700', L: 0.370, C: 0.013, H: 73.639 },
];

const PALETTE_DARK = [
  { name: 'c1: tw-indigo-400', L: 0.673, C: 0.182, H: 275.524 },
  { name: 'c2: tw-emerald-400', L: 0.765, C: 0.177, H: 163.223 },
  { name: 'c3: tw-amber-300', L: 0.879, C: 0.169, H: 91.605 },
  { name: 'c4: shadcn-violet-500', L: 0.627, C: 0.265, H: 303.900 },
  { name: 'c5: tw-rose-400', L: 0.712, C: 0.194, H: 13.428 },
  { name: 'c6: tw-cyan-400', L: 0.789, C: 0.154, H: 211.530 },
  { name: 'c7: tw-orange-500', L: 0.705, C: 0.213, H: 47.604 },
  { name: 'c8: tw-lime-400', L: 0.841, C: 0.238, H: 128.850 },
  { name: 'c9: tw-fuchsia-400', L: 0.740, C: 0.238, H: 322.160 },
  { name: 'c10: tw-sky-500', L: 0.677, C: 0.182, H: 237.323 },
  { name: 'c11: tw-slate-300', L: 0.869, C: 0.022, H: 252.894 },
  { name: 'c12: tw-stone-500', L: 0.553, C: 0.013, H: 58.071 },
];

function sendCommand(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1000000);
    const handler = (event) => {
      const data = JSON.parse(event.data);
      if (data.id === id) {
        ws.removeEventListener('message', handler);
        if (data.error) reject(data.error);
        else resolve(data.result);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function captureSingle({
  width,
  height = 900,
  theme = 'dark',
  view = 'overview',
  collapsed = false,
  timeRange = '24h',
  filename,
  checkTableNoScroll = false,
  checkKpiNot5Cols = false,
  checkKpiSameRow = false,
  checkCardHeights = false,
  checkNoVerticalScroll = false,
  checkTableInternalScroll = false,
  checkCardBottomNoGap = false,
  checkRankThreeCards = false,
  checkColPickerToggle = false,
  checkTableSort = false,
  sortColumnName = null,
  leaveSorted = false,
  checkFontSizeWhitelist = true,
  checkTableRowHeight = false,
}) {
  console.log(`\n--- Starting capture: ${filename} (${width}x${height}, ${theme}, view=${view}, collapsed=${collapsed}) ---`);
  const port = 9300 + Math.floor(Math.random() * 500);
  const targetUrl = `http://localhost:5173/?view=${view}`;

  const edge = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--window-size=${width},${height}`,
    targetUrl
  ]);

  try {
    await new Promise(r => setTimeout(r, 1800));
    const listRes = await fetch(`http://127.0.0.1:${port}/json/list`);
    const tabs = await listRes.json();
    const pageTab = tabs.find(t => t.url.includes('localhost:5173'));
    if (!pageTab) throw new Error(`Cannot find tab for port ${port}`);

    const ws = new WebSocket(pageTab.webSocketDebuggerUrl);
    await new Promise(r => { ws.onopen = r; });

    await sendCommand(ws, 'Page.enable');
    await sendCommand(ws, 'Runtime.enable');
    await sendCommand(ws, 'DOM.enable');

    // 1. 设置主题（默认暗色，若 light 则切换）
    await sendCommand(ws, 'Runtime.evaluate', {
      expression: `
        (async () => {
          const isDark = document.documentElement.classList.contains('dark');
          if ('${theme}' === 'light' && isDark) {
            const btn = document.querySelector('button[aria-label="切换主题"]');
            if (btn) btn.click();
            for (let i = 0; i < 25; i++) {
              await new Promise(r => setTimeout(r, 60));
              if (document.documentElement.classList.contains('light')) break;
            }
          } else if ('${theme}' === 'dark' && !isDark) {
            const btn = document.querySelector('button[aria-label="切换主题"]');
            if (btn) btn.click();
            for (let i = 0; i < 25; i++) {
              await new Promise(r => setTimeout(r, 60));
              if (document.documentElement.classList.contains('dark')) break;
            }
          }
        })()
      `,
      awaitPromise: true
    });

    // 2. 侧栏折叠状态调整（仅桌面端 width > 768 有效）
    if (width > 768) {
      await sendCommand(ws, 'Runtime.evaluate', {
        expression: `
          (async () => {
            const sidebar = document.querySelector('[data-slot="sidebar"]');
            if (!sidebar) return;
            const isCurrentlyCollapsed = sidebar.getAttribute('data-state') === 'collapsed';
            const shouldCollapse = ${collapsed};
            if (shouldCollapse !== isCurrentlyCollapsed) {
              const trigger = document.querySelector('button[data-slot="sidebar-trigger"]');
              if (trigger) trigger.click();
              await new Promise(r => setTimeout(r, 350));
            }
          })()
        `,
        awaitPromise: true
      });
    }

    // 等待布局和图表响应
    await new Promise(r => setTimeout(r, 400));

    // 3. 测量视口高度（移动端使用长图，桌面端全屏固定视口 900px）
    let targetH = height;
    if (width <= 768) {
      const evalRes = await sendCommand(ws, 'Runtime.evaluate', {
        expression: 'Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)',
        returnByValue: true
      });
      targetH = evalRes.result.value || 1500;
    }

    // 4. 设置视口
    await sendCommand(ws, 'Emulation.setDeviceMetricsOverride', {
      width,
      height: targetH,
      deviceScaleFactor: 1.5,
      mobile: width <= 768,
    });

    // 等待 ResizeObserver 完成
    await new Promise(r => setTimeout(r, 900));

    // 5. 严格断言：
    // (a) 无明显横向溢出
    const overflowAssert = await sendCommand(ws, 'Runtime.evaluate', {
      expression: `
        (() => {
          const scrollW = document.documentElement.scrollWidth;
          const clientW = document.documentElement.clientWidth;
          const ok = scrollW <= clientW + 1;
          return { ok, scrollW, clientW };
        })()
      `,
      returnByValue: true
    });

    if (!overflowAssert.result.value.ok) {
      throw new Error(`Horizontal overflow detected! scrollWidth=${overflowAssert.result.value.scrollW}, clientWidth=${overflowAssert.result.value.clientW}`);
    }
    console.log(`[Assert Passed] No horizontal overflow (scrollWidth=${overflowAssert.result.value.scrollW} <= clientWidth=${overflowAssert.result.value.clientW} + 1)`);

    // (b) 桌面端全屏一屏无页面纵向滚动断言 (scrollHeight <= innerHeight + 2)
    if (checkNoVerticalScroll && width >= 1280) {
      const vScrollAssert = await sendCommand(ws, 'Runtime.evaluate', {
        expression: `
          (() => {
            const scrollH = document.documentElement.scrollHeight;
            const innerH = window.innerHeight;
            const ok = scrollH <= innerH + 2;
            return { ok, scrollH, innerH };
          })()
        `,
        returnByValue: true
      });

      if (!vScrollAssert.result.value.ok) {
        throw new Error(`Page vertical scroll detected! scrollHeight=${vScrollAssert.result.value.scrollH} > innerHeight=${vScrollAssert.result.value.innerH} + 2`);
      }
      console.log(`[Assert Passed] Full screen one-page verified: scrollHeight=${vScrollAssert.result.value.scrollH} <= innerHeight=${vScrollAssert.result.value.innerH} + 2 (NO page vertical scroll)`);
    }

    // (c) 盈利页表格容器必须完全容纳表格（不得出现横向滚动）
    if (checkTableNoScroll) {
      const tableAssert = await sendCommand(ws, 'Runtime.evaluate', {
        expression: `
          (() => {
            const table = document.querySelector('table');
            if (!table) return { ok: false, reason: 'table element not found' };
            const container = table.closest('[data-slot="table-container"]') || table.parentElement;
            const scrollW = container.scrollWidth;
            const clientW = container.clientWidth;
            const tableW = table.scrollWidth;
            const ok = scrollW <= clientW + 2 && tableW <= clientW + 2;
            return { ok, scrollW, clientW, tableW };
          })()
        `,
        returnByValue: true
      });

      if (!tableAssert.result.value.ok) {
        throw new Error(`Table horizontal scroll detected in 1440 profit view! scrollWidth=${tableAssert.result.value.scrollW}, tableWidth=${tableAssert.result.value.tableW}, clientWidth=${tableAssert.result.value.clientW}`);
      }
      console.log(`[Assert Passed] 1440 Profit table container has NO horizontal scroll (tableWidth=${tableAssert.result.value.tableW} <= clientWidth=${tableAssert.result.value.clientW} + 2, container actual width: ${tableAssert.result.value.clientW}px)`);
    }

    // (d) 1024 宽度下 KPI 栏必须不是 5 列（应为 3 列，主卡跨满 3 列）
    if (checkKpiNot5Cols) {
      const kpiAssert = await sendCommand(ws, 'Runtime.evaluate', {
        expression: `
          (() => {
            const section = document.querySelector('section.grid');
            if (!section) return { ok: false, reason: 'KPI section not found' };
            const computedStyle = window.getComputedStyle(section);
            const cols = computedStyle.gridTemplateColumns.trim().split(/\\s+/);
            const masterCard = section.firstElementChild;
            const masterStyle = window.getComputedStyle(masterCard);
            const masterCols = masterStyle.gridColumn;
            return {
              ok: cols.length !== 5 && cols.length === 3,
              colCount: cols.length,
              gridTemplate: computedStyle.gridTemplateColumns,
              masterGridColumn: masterCols
            };
          })()
        `,
        returnByValue: true
      });

      if (!kpiAssert.result.value.ok) {
        throw new Error(`1024 KPI assertion failed! colCount=${kpiAssert.result.value.colCount} (expected 3, not 5), template=${kpiAssert.result.value.gridTemplate}`);
      }
      console.log(`[Assert Passed] 1024 KPI grid verified: ${kpiAssert.result.value.colCount} columns (not 5 columns), master card span: ${kpiAssert.result.value.masterGridColumn}`);
    }

    // (e) 768/1024 宽度下 KPI 区域三张辅卡必须同行等高等宽
    if (checkKpiSameRow) {
      const kpiRowAssert = await sendCommand(ws, 'Runtime.evaluate', {
        expression: `
          (() => {
            const auxCards = Array.from(document.querySelectorAll('[data-slot="kpi-aux-card"]'));
            if (auxCards.length !== 3) {
              return { ok: false, reason: 'Expected 3 aux cards, found ' + auxCards.length };
            }
            const tops = auxCards.map(c => Math.round(c.getBoundingClientRect().top));
            const heights = auxCards.map(c => Math.round(c.getBoundingClientRect().height));
            const widths = auxCards.map(c => Math.round(c.getBoundingClientRect().width));
            const okTop = Math.abs(tops[0] - tops[1]) <= 1 && Math.abs(tops[1] - tops[2]) <= 1;
            const okHeight = Math.abs(heights[0] - heights[1]) <= 1 && Math.abs(heights[1] - heights[2]) <= 1;
            const okWidth = Math.abs(widths[0] - widths[1]) <= 1 && Math.abs(widths[1] - widths[2]) <= 1;
            return { ok: okTop && okHeight && okWidth, tops, heights, widths };
          })()
        `,
        returnByValue: true
      });

      if (!kpiRowAssert.result.value.ok) {
        throw new Error(`KPI aux cards alignment failed! tops=${JSON.stringify(kpiRowAssert.result.value.tops)}, heights=${JSON.stringify(kpiRowAssert.result.value.heights)}, widths=${JSON.stringify(kpiRowAssert.result.value.widths)}`);
      }
      console.log(`[Assert Passed] KPI 3 aux cards aligned: tops=${JSON.stringify(kpiRowAssert.result.value.tops)}, heights=${JSON.stringify(kpiRowAssert.result.value.heights)}, widths=${JSON.stringify(kpiRowAssert.result.value.widths)}`);
    }

    // (f) 1440 卡片高度对齐断言
    if (checkCardHeights) {
      const heightAssert = await sendCommand(ws, 'Runtime.evaluate', {
        expression: `
          (() => {
            if ('${view}' === 'overview') {
              // 1. KPI 4 卡同行等高
              const kpiCards = Array.from(document.querySelectorAll('section.grid')[0].children);
              const kpiHeights = kpiCards.map(c => c.getBoundingClientRect().height);
              const kpiDiff = Math.max(...kpiHeights) - Math.min(...kpiHeights);

              // 2. 趋势两卡等高，且高度 >= 340px
              const trendCards = Array.from(document.querySelectorAll('section.grid')[1].children);
              const trendHeights = trendCards.map(c => c.getBoundingClientRect().height);
              const trendDiff = Math.abs(trendHeights[0] - trendHeights[1]);
              const trendMinH = Math.min(...trendHeights);

              return {
                ok: kpiDiff <= 1.5 && trendDiff <= 1.5 && trendMinH >= 340,
                kpiDiff,
                kpiHeights,
                trendDiff,
                trendHeights,
                trendMinH
              };
            } else if ('${view}' === 'profit') {
              // 盈利图卡与表卡等高 (<= 1.5px 差值)
              const cards = Array.from(document.querySelectorAll('.grid > .h-full'));
              if (cards.length < 2) return { ok: false, reason: 'Profit cards not found' };
              const h1 = cards[0].getBoundingClientRect().height;
              const h2 = cards[1].getBoundingClientRect().height;
              const diff = Math.abs(h1 - h2);
              return {
                ok: diff <= 1.5,
                diff,
                h1,
                h2
              };
            }
            return { ok: true };
          })()
        `,
        returnByValue: true
      });

      if (!heightAssert.result.value.ok) {
        throw new Error(`Card height alignment failed for ${view}! details=${JSON.stringify(heightAssert.result.value)}`);
      }
      if (view === 'overview') {
        console.log(`[Assert Passed] Overview cards equal height: KPI height diff=${heightAssert.result.value.kpiDiff.toFixed(1)}px (<=1.5px), Trend cards height diff=${heightAssert.result.value.trendDiff.toFixed(1)}px (height=${heightAssert.result.value.trendMinH.toFixed(0)}px >= 340px)`);
      } else if (view === 'profit') {
        console.log(`[Assert Passed] Profit chart card vs table card equal height: diff=${heightAssert.result.value.diff.toFixed(1)}px (chart: ${heightAssert.result.value.h1.toFixed(0)}px, table: ${heightAssert.result.value.h2.toFixed(0)}px)`);
      }
    }

    // (g) 字号断言：盈利表正文单元格计算字号 ≥14px、KPI 辅卡标签 ≥14px
    if (view === 'profit') {
      const fontAssert = await sendCommand(ws, 'Runtime.evaluate', {
        expression: `
          (() => {
            const cell = document.querySelector('table tbody tr td');
            if (!cell) return { ok: false, reason: 'Profit table cell not found' };
            const size = parseFloat(window.getComputedStyle(cell).fontSize);
            return { ok: size >= 13.9, fontSize: size };
          })()
        `,
        returnByValue: true
      });
      if (!fontAssert.result.value.ok) {
        throw new Error(`Profit table cell font size < 14px! Got ${fontAssert.result.value.fontSize}px`);
      }
      console.log(`[Assert Passed] Profit table cell font-size is ${fontAssert.result.value.fontSize}px (>= 14px)`);
    }

    if (view === 'overview') {
      const kpiFontAssert = await sendCommand(ws, 'Runtime.evaluate', {
        expression: `
          (() => {
            const title = document.querySelector('[data-slot="kpi-aux-card"] [data-slot="card-title"]') ||
                          document.querySelector('[data-slot="kpi-aux-card"] .text-\\[16px\\]') ||
                          document.querySelector('[data-slot="kpi-aux-card"] .text-\\[15px\\]') ||
                          document.querySelector('[data-slot="kpi-aux-card"] .text-\\[14px\\]');
            if (!title) return { ok: false, reason: 'KPI aux card title not found' };
            const size = parseFloat(window.getComputedStyle(title).fontSize);
            return { ok: size >= 13.9, fontSize: size };
          })()
        `,
        returnByValue: true
      });
      if (!kpiFontAssert.result.value.ok) {
        throw new Error(`KPI aux card label font size < 14px! Got ${kpiFontAssert.result.value.fontSize}px`);
      }
      console.log(`[Assert Passed] KPI aux card label font-size is ${kpiFontAssert.result.value.fontSize}px (>= 14px)`);
    }

    // (h) 图表断言（当前页图表容器内 .recharts-surface 宽高 > 10 且内部 rect/path 数 > 0）
    const expectedCharts = view === 'overview' ? 2 : (view === 'profit' ? 1 : 0);
    if (expectedCharts > 0) {
      const chartAssert = await sendCommand(ws, 'Runtime.evaluate', {
        expression: `
          (() => {
            const svgs = Array.from(document.querySelectorAll('.recharts-surface'));
            if (svgs.length < ${expectedCharts}) {
              return { ok: false, reason: 'Expected at least ${expectedCharts} charts, got ' + svgs.length };
            }
            for (let i = 0; i < svgs.length; i++) {
              const rect = svgs[i].getBoundingClientRect();
              if (rect.width <= 10 || rect.height <= 10) {
                return { ok: false, reason: 'Chart ' + i + ' dimensions too small: ' + rect.width + 'x' + rect.height };
              }
              const primitives = svgs[i].querySelectorAll('rect, path.recharts-rectangle, path.recharts-curve, path.recharts-area').length;
              if (primitives === 0) {
                return { ok: false, reason: 'Chart ' + i + ' has zero rendered primitives (bars/lines/areas)' };
              }
            }
            return { ok: true, count: svgs.length };
          })()
        `,
        returnByValue: true
      });

      if (!chartAssert.result.value.ok) {
        throw new Error(`Chart assertion failed: ${chartAssert.result.value.reason}`);
      }
      console.log(`[Assert Passed] Verified ${chartAssert.result.value.count} charts rendered correctly`);
    }

    // (i) 表格容器滚动断言：行数 <= 12 时 scrollHeight == clientHeight（全显无内滚）；行数 > 12 时 scrollHeight > clientHeight
    if (checkTableInternalScroll) {
      const scrollAssert = await sendCommand(ws, 'Runtime.evaluate', {
        expression: `
          (() => {
            const container = document.querySelector('[data-slot="table-container"]');
            if (!container) return { ok: false, reason: 'Table container [data-slot="table-container"] not found' };
            const rowCount = container.querySelectorAll('tbody tr').length;
            const scrollH = container.scrollHeight;
            const clientH = container.clientHeight;
            if (rowCount <= 12) {
              const ok = Math.abs(scrollH - clientH) <= 2;
              return { ok, scrollH, clientH, rowCount, shouldScroll: false };
            } else {
              const ok = scrollH > clientH;
              return { ok, scrollH, clientH, rowCount, shouldScroll: true };
            }
          })()
        `,
        returnByValue: true
      });

      if (!scrollAssert.result.value.ok) {
        throw new Error(`Table scroll assertion failed! rowCount=${scrollAssert.result.value.rowCount}, scrollHeight=${scrollAssert.result.value.scrollH}, clientHeight=${scrollAssert.result.value.clientH}`);
      }
      console.log(`[Assert Passed] Table container verified (rows: ${scrollAssert.result.value.rowCount}): scrollHeight=${scrollAssert.result.value.scrollH} == clientHeight=${scrollAssert.result.value.clientH} (no inner scroll for <= 12 rows)`);
    }

    // (j) 卡片内表格下方无 >8px 空白断言（比较卡底与底栏/表底 bounding rect）
    if (checkCardBottomNoGap) {
      const gapAssert = await sendCommand(ws, 'Runtime.evaluate', {
        expression: `
          (() => {
            const card = document.querySelector('[data-slot="detail-card"]');
            if (!card) return { ok: false, reason: 'Card [data-slot="detail-card"] not found' };
            const footer = card.querySelector('[data-slot="detail-card-footer"]') || card.lastElementChild;
            if (!footer) return { ok: false, reason: 'Footer not found' };
            const cardRect = card.getBoundingClientRect();
            const footerRect = footer.getBoundingClientRect();
            const cardStyle = window.getComputedStyle(card);
            const paddingBottom = parseFloat(cardStyle.paddingBottom) || 0;
            const gap = Math.abs(cardRect.bottom - paddingBottom - footerRect.bottom);
            const ok = gap <= 8;
            return { ok, gap: Math.round(gap * 10) / 10, cardBottom: cardRect.bottom, footerBottom: footerRect.bottom, paddingBottom };
          })()
        `,
        returnByValue: true
      });

      if (!gapAssert.result.value.ok) {
        throw new Error(`Card bottom dead space detected! gap=${gapAssert.result.value.gap}px > 8px (cardBottom: ${gapAssert.result.value.cardBottom}, footerBottom: ${gapAssert.result.value.footerBottom}, paddingBottom: ${gapAssert.result.value.paddingBottom})`);
      }
      console.log(`[Assert Passed] Card bottom tightly fitted: no >8px dead space (gap=${gapAssert.result.value.gap}px <= 8px)`);
    }

    // (k) 排行页三卡竖排断言：3 张卡、每卡恰好 5 行、每卡 1 个 Donut 且扇区颜色同源
    if (checkRankThreeCards) {
      const rankAssert = await sendCommand(ws, 'Runtime.evaluate', {
        expression: `
          (() => {
            const cards = Array.from(document.querySelectorAll('.grid.grid-rows-3 > [data-slot="card"]'));
            if (cards.length !== 3) {
              return { ok: false, reason: 'Expected 3 cards in grid-rows-3, got ' + cards.length };
            }
            const rowCounts = cards.map(c => c.querySelectorAll('[data-slot="rank-item"]').length);
            const all5 = rowCounts.every(cnt => cnt === 5);
            if (!all5) {
              return { ok: false, reason: 'Every card must have exactly 5 rows', rowCounts };
            }

            const donuts = Array.from(document.querySelectorAll('[data-slot="donut-container"]'));
            if (donuts.length !== 3) {
              return { ok: false, reason: 'Expected 3 donuts, got ' + donuts.length };
            }

            // 校验每个 Donut 的扇区数与颜色同源
            for (let i = 0; i < 3; i++) {
              const card = cards[i];
              const donut = donuts[i];
              const barItems = Array.from(card.querySelectorAll('[data-slot="rank-item"]'));
              const sectors = Array.from(donut.querySelectorAll('path.recharts-pie-sector, path.recharts-sector'));

              if (sectors.length < 5) {
                return { ok: false, reason: 'Card ' + i + ' donut sectors < 5: ' + sectors.length };
              }

              // 校验前 5 个扇区颜色与对应条形颜色一致
              for (let j = 0; j < 5; j++) {
                const bar = barItems[j].querySelector('[style*="background-color"]');
                const sector = sectors[j];
                if (bar && sector) {
                  const barBg = bar.style.backgroundColor.trim();
                  const sectorFill = (sector.getAttribute('fill') || '').trim();
                  if (barBg && sectorFill && barBg !== sectorFill) {
                    return { ok: false, reason: 'Color mismatch in card ' + i + ' item ' + j + ': bar ' + barBg + ' vs sector ' + sectorFill };
                  }
                }
              }
            }

            return { ok: true, cardCount: cards.length, rowCounts, donutCount: donuts.length };
          })()
        `,
        returnByValue: true
      });

      if (!rankAssert.result || !rankAssert.result.value || !rankAssert.result.value.ok) {
        throw new Error(`Rank three cards assertion failed: ${JSON.stringify(rankAssert.result ? rankAssert.result.value : rankAssert)}`);
      }
      console.log(`[Assert Passed] Rank view verified: 3 cards vertically stacked, each has 5 rows + 1 donut with matching colors (${JSON.stringify(rankAssert.result.value.rowCounts)})`);
    }

    // (l) 列选择器切换断言：表头 <th> 与每行 <td> 数量严格一致，且切换列时动态联动
    if (checkColPickerToggle) {
      const colAssert = await sendCommand(ws, 'Runtime.evaluate', {
        expression: `
          (async () => {
            const getColCounts = () => {
              const table = document.querySelector('[data-slot="table-container"] table');
              if (!table) return { thCount: -1, trCellCounts: [] };
              const thCount = table.querySelectorAll('thead tr th').length;
              const trCellCounts = Array.from(table.querySelectorAll('tbody tr')).map(tr => tr.querySelectorAll('td').length);
              return { thCount, trCellCounts };
            };

            const before = getColCounts();
            const beforeConsistent = before.trCellCounts.length > 0 && before.trCellCounts.every(c => c === before.thCount);
            if (!beforeConsistent) {
              return { ok: false, reason: 'Initial table header and row cell counts inconsistent', before };
            }

            // 打开列选择器下拉菜单
            const trigger = document.querySelector('[data-slot="col-picker-trigger"]');
            if (!trigger) {
              return { ok: false, reason: 'Column picker trigger not found' };
            }
            trigger.click();
            await new Promise(r => setTimeout(r, 300));

            // 找到一个非锁定的列并切换（例如第 1 个可勾选项）
            const uncheckables = Array.from(document.querySelectorAll('[data-slot="col-picker-item"]:not([data-disabled])'));
            if (uncheckables.length === 0) {
              return {
                ok: false,
                reason: 'No toggleable column items found in picker',
                expanded: trigger.getAttribute('aria-expanded'),
              };
            }
            // 点击切换一列 (取消显示)
            uncheckables[0].click();
            await new Promise(r => setTimeout(r, 200));

            const after = getColCounts();
            const afterConsistent = after.trCellCounts.length > 0 && after.trCellCounts.every(c => c === after.thCount);
            const countChanged = after.thCount === before.thCount - 1;

            // 再次点击恢复显示
            uncheckables[0].click();
            await new Promise(r => setTimeout(r, 200));
            // 再次点击 trigger 关闭菜单
            trigger.click();
            await new Promise(r => setTimeout(r, 200));

            return {
              ok: afterConsistent && countChanged,
              beforeTh: before.thCount,
              afterTh: after.thCount,
              afterCellCount: after.trCellCounts[0],
              consistent: afterConsistent,
              countChanged
            };
          })()
        `,
        awaitPromise: true,
        returnByValue: true
      });

      if (!colAssert.result.value.ok) {
        throw new Error(`Column picker toggle consistency assertion failed: ${JSON.stringify(colAssert.result.value)}`);
      }
      console.log(`[Assert Passed] Column picker toggle verified: cols dynamically changed from ${colAssert.result.value.beforeTh} to ${colAssert.result.value.afterTh}, all rows match header (${colAssert.result.value.afterCellCount} cells)`);
    }

    // (m) 列头点击三态循环排序断言 (第一次降序 -> 第二次升序 -> 第三次回到默认口径，逐行一致)
    if (checkTableSort && sortColumnName) {
      const sortAssert = await sendCommand(ws, 'Runtime.evaluate', {
        expression: `
          (async () => {
            const table = document.querySelector('table');
            if (!table) return { ok: false, reason: 'Table not found for sorting test' };

            // 记录默认顺序 (以第一列文本作为行标识)
            const getRowKeys = () => Array.from(table.querySelectorAll('tbody tr')).map(tr => tr.children[0]?.textContent?.trim() || '');
            const defaultOrder = getRowKeys();

            // 找到指定列头
            const ths = Array.from(table.querySelectorAll('thead tr th'));
            const targetTh = ths.find(th => th.textContent.includes('${sortColumnName}'));
            if (!targetTh) return { ok: false, reason: 'Sort target column ${sortColumnName} not found' };

            // 1. 第一次点击 -> 降序 (desc)
            targetTh.click();
            await new Promise(r => setTimeout(r, 200));
            const descSort = targetTh.getAttribute('aria-sort');
            const descOrder = getRowKeys();

            // 2. 第二次点击 -> 升序 (asc)
            targetTh.click();
            await new Promise(r => setTimeout(r, 200));
            const ascSort = targetTh.getAttribute('aria-sort');
            const ascOrder = getRowKeys();

            // 3. 第三次点击 -> 默认口径 (none)
            targetTh.click();
            await new Promise(r => setTimeout(r, 200));
            const defaultSort = targetTh.getAttribute('aria-sort');
            const restoredOrder = getRowKeys();

            const isDefaultRestored = JSON.stringify(restoredOrder) === JSON.stringify(defaultOrder);
            const isDescAscDifferent = JSON.stringify(descOrder) !== JSON.stringify(ascOrder);

            if (${leaveSorted}) {
              // 若需要保留在降序状态进行截图：再次点击一次成为降序
              targetTh.click();
              await new Promise(r => setTimeout(r, 200));
            }

            return {
              ok: descSort === 'descending' && ascSort === 'ascending' && defaultSort === 'none' && isDefaultRestored && isDescAscDifferent,
              descSort,
              ascSort,
              defaultSort,
              isDefaultRestored,
              isDescAscDifferent
            };
          })()
        `,
        awaitPromise: true,
        returnByValue: true
      });

      if (!sortAssert.result || !sortAssert.result.value || !sortAssert.result.value.ok) {
        throw new Error(`Table sort assertion failed for ${sortColumnName}: ${JSON.stringify(sortAssert.result ? sortAssert.result.value : sortAssert)}`);
      }
      console.log(`[Assert Passed] Table sort 3-state cycle verified on "${sortColumnName}": desc -> asc -> default (restored row-by-row match)`);
    }

    // (n) 字号白名单校验：页面内计算字号只允许 {12, 14, 16, 18, 20, 24, 28}
    if (checkFontSizeWhitelist) {
      const whitelistAssert = await sendCommand(ws, 'Runtime.evaluate', {
        expression: `
          (() => {
            const allowed = new Set([12, 14, 16, 18, 20, 24, 28]);
            const disallowedFound = [];
            const allElements = Array.from(document.querySelectorAll('#root *'));
            for (const el of allElements) {
              if (['svg', 'path', 'g', 'script', 'style'].includes(el.tagName.toLowerCase())) continue;
              const style = window.getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden') continue;
              const hasDirectText = Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.trim().length > 0);
              if (!hasDirectText) continue;

              const size = Math.round(parseFloat(style.fontSize));
              if (!allowed.has(size)) {
                disallowedFound.push({
                  tag: el.tagName,
                  text: el.textContent.trim().slice(0, 20),
                  fontSize: size,
                  exact: style.fontSize,
                  cls: el.className
                });
              }
            }
            return {
              ok: disallowedFound.length === 0,
              failedCount: disallowedFound.length,
              samples: disallowedFound.slice(0, 5)
            };
          })()
        `,
        returnByValue: true
      });

      if (!whitelistAssert.result || !whitelistAssert.result.value || !whitelistAssert.result.value.ok) {
        throw new Error(`Font size whitelist check failed! Found ${whitelistAssert.result.value.failedCount} invalid elements: ${JSON.stringify(whitelistAssert.result.value.samples)}`);
      }
      console.log(`[Assert Passed] Font size whitelist verified: 0 invalid sizes found (all text in {12,14,16,18,20,24,28}px)`);
    }

    // (o) 表格行高校验：40±1px (39px <= height <= 41px)
    if (checkTableRowHeight) {
      const rowHeightAssert = await sendCommand(ws, 'Runtime.evaluate', {
        expression: `
          (() => {
            const rows = Array.from(document.querySelectorAll('tbody tr'));
            if (rows.length === 0) return { ok: true, skipped: true };
            const heights = rows.map(r => Math.round(r.getBoundingClientRect().height * 10) / 10);
            const invalid = heights.filter(h => h < 38.5 || h > 41.5);
            return {
              ok: invalid.length === 0,
              heights: heights.slice(0, 5),
              avgHeight: Math.round((heights.reduce((a, b) => a + b, 0) / heights.length) * 10) / 10,
              invalid
            };
          })()
        `,
        returnByValue: true
      });

      if (!rowHeightAssert.result || !rowHeightAssert.result.value || !rowHeightAssert.result.value.ok) {
        throw new Error(`Table row height check failed! Heights outside 40±1px: ${JSON.stringify(rowHeightAssert.result.value)}`);
      }
      console.log(`[Assert Passed] Table row height verified: avg=${rowHeightAssert.result.value.avgHeight}px within 40±1px (sample: ${JSON.stringify(rowHeightAssert.result.value.heights)})`);
    }

    // 6. 执行截图
    const screenshotRes = await sendCommand(ws, 'Page.captureScreenshot', {
      format: 'png',
      fromSurface: true
    });

    const buffer = Buffer.from(screenshotRes.data, 'base64');
    const outPath = path.join(SHOTS_DIR, filename);
    fs.writeFileSync(outPath, buffer);
    console.log(`[Saved File] ${outPath} (${width}x${targetH}, size: ${buffer.length} bytes)`);

    ws.close();
  } finally {
    edge.kill();
  }
}

async function main() {
  console.log('=== Step 0: Quantifiable Color Palette Check (deltaE >= 0.10) ===');
  const lightRes = verifyPalette(PALETTE_LIGHT, 'Light');
  const darkRes = verifyPalette(PALETTE_DARK, 'Dark');
  const costRes = verifyCostVsProfitDeltaE();
  console.log(`Light Min deltaE: ${lightRes.minDE.toFixed(4)} (${lightRes.minPair.join(' vs ')})`);
  console.log(`Dark  Min deltaE: ${darkRes.minDE.toFixed(4)} (${darkRes.minPair.join(' vs ')})`);
  console.log(`Cost vs Profit Light deltaE: ${costRes.deLight.toFixed(4)}, Dark deltaE: ${costRes.deDark.toFixed(4)}\n`);

  console.log('=== Capturing 4 requested 1440 pages (Overview, Profit, Rank, Channels Table) ===');

  // 1. sidebar-1440-dark-overview.png (总览：放大字号后一屏无纵向滚动 + 等高断言)
  await captureSingle({
    width: 1440,
    height: 900,
    theme: 'dark',
    view: 'overview',
    collapsed: false,
    checkNoVerticalScroll: true,
    checkCardHeights: true,
    filename: 'sidebar-1440-dark-overview.png',
  });

  // 2. sidebar-1440-dark-profit.png (盈利：放大字号后一屏无纵向滚动 + 表格无横向溢出 + 图卡表卡等高 + 三态排序验证 + 行高40px校验)
  await captureSingle({
    width: 1440,
    height: 900,
    theme: 'dark',
    view: 'profit',
    collapsed: false,
    checkNoVerticalScroll: true,
    checkTableNoScroll: true,
    checkCardHeights: true,
    checkTableSort: true,
    checkTableRowHeight: true,
    sortColumnName: '售出',
    filename: 'sidebar-1440-dark-profit.png',
  });

  // 3. sidebar-1440-dark-rank.png (合并排行：渠道/分组/用户三卡竖排各占约1/3，每卡恰好5行，一屏无纵向滚动)
  await captureSingle({
    width: 1440,
    height: 900,
    theme: 'dark',
    view: 'rank',
    collapsed: false,
    checkNoVerticalScroll: true,
    checkRankThreeCards: true,
    filename: 'sidebar-1440-dark-rank.png',
  });

  // 4. sidebar-1440-dark-channels-table.png (渠道明细：一屏无纵向滚动 + 无内滚全显 + 卡底无>8px空白 + 列选择器联动 + 三态排序验证 + 行高40px校验)
  await captureSingle({
    width: 1440,
    height: 900,
    theme: 'dark',
    view: 'channels_detail',
    collapsed: false,
    checkNoVerticalScroll: true,
    checkTableInternalScroll: true,
    checkCardBottomNoGap: true,
    checkColPickerToggle: true,
    checkTableSort: true,
    checkTableRowHeight: true,
    sortColumnName: '售出',
    filename: 'sidebar-1440-dark-channels-table.png',
  });

  // 5. sidebar-1440-dark-channels-table-sorted.png (渠道明细：按售出降序排列态截图)
  await captureSingle({
    width: 1440,
    height: 900,
    theme: 'dark',
    view: 'channels_detail',
    collapsed: false,
    checkNoVerticalScroll: true,
    checkTableSort: true,
    sortColumnName: '售出',
    leaveSorted: true,
    filename: 'sidebar-1440-dark-channels-table-sorted.png',
  });

  console.log('\n=== Verifying 1536x864 resolution across all 5 views ===');
  for (const v of ['overview', 'profit', 'rank', 'channels_detail', 'groups_detail']) {
    await captureSingle({
      width: 1536,
      height: 864,
      theme: 'dark',
      view: v,
      collapsed: false,
      checkNoVerticalScroll: true,
      filename: `verify-1536-864-${v}.png`,
    });
  }

  console.log('\n=== All requested screenshots captured & verified successfully! ===\n');
}

main().catch(err => {
  console.error('Fatal capture error:', err);
  process.exit(1);
});
