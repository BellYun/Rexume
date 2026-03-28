#!/usr/bin/env node
/**
 * TBT 비교: pdfOptimized (baseline) vs pdfOpt14-PageCache (getPage 캐싱)
 *
 * 사용:
 *   node bench/tbt-opt14-pagecache.js
 *
 * 환경변수:
 *   RUNS=5           반복 횟수 (기본 5)
 *   CPU_THROTTLE=4   CPU 스로틀 배율 (기본 4)
 *   BASE_URL=http://localhost:3000
 *   PDF_URL=/sample4.pdf
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const RUNS = Number(process.env.RUNS || 5);
const CPU_THROTTLE = Number(process.env.CPU_THROTTLE || 4);
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const PDF_URL = process.env.PDF_URL || '/sample4.pdf';

const TEST_URLS = [
  {
    url: `${BASE_URL}/pdf-bench/optimized?url=${PDF_URL}`,
    name: 'Baseline (pdfOptimized)',
    shortName: 'baseline',
  },
  {
    url: `${BASE_URL}/pdf-bench/opt14?url=${PDF_URL}`,
    name: 'Opt14 (getPage 캐싱)',
    shortName: 'opt14-pagecache',
  },
];

const outDir = path.join(__dirname, 'results');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

// ── 단일 측정 ─────────────────────────────────────────────────────────
async function measure(testUrl, versionName, run) {
  process.stdout.write(`  [${run}/${RUNS}] ${versionName} ... `);

  const isDocker = fs.existsSync('/.dockerenv');
  const launchOptions = {
    headless: 'new',
    defaultViewport: { width: 1920, height: 1080 },
    args: ['--disable-dev-shm-usage', '--no-sandbox', '--crash-dumps-dir=/tmp'],
    protocolTimeout: 120000,
  };
  if (isDocker) {
    launchOptions.executablePath = '/usr/bin/chromium';
  } else if (fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')) {
    launchOptions.executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }

  const browser = await puppeteer.launch(launchOptions);
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);

  const client = await page.target().createCDPSession();
  await client.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });

  await page.evaluateOnNewDocument(() => {
    window.__metrics = {
      longTasks: [],
      firstContentfulPaint: null,
      firstCanvasTime: null,
      canvasCount: 0,
      getPageCallCount: 0,
    };

    // LongTask
    if (window.PerformanceObserver) {
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            window.__metrics.longTasks.push({ start: e.startTime, dur: e.duration });
          }
        }).observe({ type: 'longtask', buffered: true });

        // FCP
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            if (e.name === 'first-contentful-paint' && !window.__metrics.firstContentfulPaint) {
              window.__metrics.firstContentfulPaint = e.startTime;
            }
          }
        }).observe({ type: 'paint', buffered: true });
      } catch (_) {}
    }

    // Canvas 생성 감지
    const origCreate = document.createElement.bind(document);
    document.createElement = function (tag) {
      const el = origCreate(tag);
      if (tag.toLowerCase() === 'canvas') {
        window.__metrics.canvasCount++;
        if (!window.__metrics.firstCanvasTime) {
          window.__metrics.firstCanvasTime = performance.now();
        }
      }
      return el;
    };
  });

  await page.goto(testUrl, { waitUntil: 'networkidle2', timeout: 60000 });

  // 첫 canvas 대기 (최대 30초)
  try {
    await page.waitForFunction(() => window.__metrics.canvasCount > 0, { timeout: 30000 });
  } catch {
    // timeout — 계속 진행
  }

  // 렌더링 안정화
  await new Promise((r) => setTimeout(r, 3000));

  const result = await page.evaluate(() => {
    const fcp = window.__metrics.firstContentfulPaint || 0;
    const tasks = window.__metrics.longTasks;

    // TBT = FCP 이후 50ms 초과 longTask 합산
    const tbt = tasks
      .filter((t) => fcp > 0 && t.start + t.dur > fcp)
      .reduce((sum, t) => sum + Math.max(0, t.dur - 50), 0);

    const nav = performance.getEntriesByType('navigation')[0];
    const longDurations = tasks.map((t) => t.dur);

    return {
      tbt: Math.round(tbt),
      fcp: Math.round(fcp),
      firstCanvasTime: Math.round(window.__metrics.firstCanvasTime || 0),
      longTaskCount: tasks.length,
      longTaskMax: longDurations.length ? Math.round(Math.max(...longDurations)) : 0,
      longTaskAvg: longDurations.length
        ? Math.round(longDurations.reduce((a, b) => a + b, 0) / longDurations.length)
        : 0,
      canvasCount: window.__metrics.canvasCount,
      loadComplete: Math.round((nav?.loadEventEnd - nav?.fetchStart) || 0),
    };
  });

  await browser.close();

  console.log(
    `TBT=${result.tbt}ms  FCP=${result.fcp}ms  LongTask=${result.longTaskCount}개  Canvas=${result.canvasCount}`
  );
  return { ...result, version: versionName, run };
}

// ── 통계 ──────────────────────────────────────────────────────────────
function stats(arr) {
  if (!arr.length) return { avg: 0, min: 0, max: 0, median: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    avg: Math.round(arr.reduce((a, b) => a + b, 0) / arr.length),
    min: Math.round(sorted[0]),
    max: Math.round(sorted[sorted.length - 1]),
    median: Math.round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2),
  };
}

// ── 결과 테이블 ───────────────────────────────────────────────────────
function printTable(summaries) {
  const SEP = '═'.repeat(88);
  const baseline = summaries[0]?.tbt.median || 1;

  console.log(`\n${SEP}`);
  console.log(` TBT 비교: pdfOptimized  vs  pdfOpt14-PageCache  (CPU ${CPU_THROTTLE}x · ${RUNS}회)`);
  console.log(`${SEP}`);
  console.log(
    `${'버전'.padEnd(28)} ${'TBT median'.padStart(11)} ${'vs baseline'.padStart(12)} ${'TBT avg'.padStart(9)} ${'FCP'.padStart(7)} ${'LongTask'.padStart(9)} ${'maxDur'.padStart(7)}`
  );
  console.log(`${'─'.repeat(28)} ${'─'.repeat(11)} ${'─'.repeat(12)} ${'─'.repeat(9)} ${'─'.repeat(7)} ${'─'.repeat(9)} ${'─'.repeat(7)}`);

  for (const s of summaries) {
    const diff = s.tbt.median - baseline;
    const pct = baseline > 0 ? ((diff / baseline) * 100).toFixed(1) : '0.0';
    const sign =
      s.shortName === 'baseline'
        ? '  (base)'
        : diff < 0
        ? `↓${Math.abs(pct)}%`
        : diff > 0
        ? `↑${pct}%`
        : '  =';

    console.log(
      `${s.version.padEnd(28)} ${(s.tbt.median + 'ms').padStart(11)} ${sign.padStart(12)} ${(s.tbt.avg + 'ms').padStart(9)} ${(s.fcp.median + 'ms').padStart(7)} ${String(s.longTaskCount.avg).padStart(9)} ${(s.longTaskMax.median + 'ms').padStart(7)}`
    );
  }

  console.log(`${SEP}`);

  // 개선 수치 강조
  if (summaries.length >= 2) {
    const base = summaries[0].tbt.median;
    const opt = summaries[1].tbt.median;
    const saved = base - opt;
    if (saved > 0) {
      console.log(`\n  TBT 개선: ${base}ms → ${opt}ms  (${saved}ms 단축, ${((saved / base) * 100).toFixed(1)}% 감소)\n`);
    } else if (saved < 0) {
      console.log(`\n  TBT 증가: ${base}ms → ${opt}ms  (${Math.abs(saved)}ms 증가)\n`);
    } else {
      console.log(`\n  TBT 변화 없음\n`);
    }
  }
}

// ── 메인 ──────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(` TBT 벤치마크: pdfOptimized vs pdfOpt14-PageCache`);
  console.log(` CPU ${CPU_THROTTLE}x throttle · ${RUNS}회 반복 · PDF: ${PDF_URL}`);
  console.log(`${'═'.repeat(60)}`);

  const allResults = {};

  for (const target of TEST_URLS) {
    console.log(`\n▶ ${target.name}`);
    allResults[target.shortName] = [];

    for (let r = 1; r <= RUNS; r++) {
      try {
        const result = await measure(target.url, target.name, r);
        allResults[target.shortName].push(result);
      } catch (e) {
        console.error(`  오류 (${r}회차): ${e.message}`);
      }
    }
  }

  const summaries = TEST_URLS.map((t) => {
    const runs = allResults[t.shortName] || [];
    return {
      version: t.name,
      shortName: t.shortName,
      tbt: stats(runs.map((r) => r.tbt)),
      fcp: stats(runs.map((r) => r.fcp)),
      firstCanvasTime: stats(runs.map((r) => r.firstCanvasTime)),
      longTaskCount: stats(runs.map((r) => r.longTaskCount)),
      longTaskMax: stats(runs.map((r) => r.longTaskMax)),
      longTaskAvg: stats(runs.map((r) => r.longTaskAvg)),
      canvasCount: stats(runs.map((r) => r.canvasCount)),
      runs: runs.length,
    };
  });

  printTable(summaries);

  // 상세
  console.log('상세 통계:');
  for (const s of summaries) {
    console.log(`\n  ${s.version} (${s.runs}회)`);
    console.log(`    TBT        : median=${s.tbt.median}ms  avg=${s.tbt.avg}ms  min=${s.tbt.min}ms  max=${s.tbt.max}ms`);
    console.log(`    FCP        : median=${s.fcp.median}ms  avg=${s.fcp.avg}ms`);
    console.log(`    1st Canvas : median=${s.firstCanvasTime.median}ms`);
    console.log(`    LongTask   : avg=${s.longTaskCount.avg}개  maxDur=${s.longTaskMax.median}ms  avgDur=${s.longTaskAvg.median}ms`);
  }

  // JSON 저장
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `tbt-opt14-pagecache-${ts}.json`);
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        summaries,
        allResults,
        meta: { runs: RUNS, cpuThrottle: CPU_THROTTLE, baseUrl: BASE_URL, pdfUrl: PDF_URL, timestamp: new Date().toISOString() },
      },
      null,
      2
    )
  );
  console.log(`\n결과 저장: ${outFile}`);
}

main().catch((e) => {
  console.error('벤치마크 오류:', e);
  process.exit(1);
});
