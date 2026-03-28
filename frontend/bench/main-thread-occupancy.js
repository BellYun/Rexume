#!/usr/bin/env node
/**
 * 메인스레드 점유율 비교 벤치마크
 *
 * 측정 지표:
 *   - Main Thread Occupancy (%) = sum(longTask durations) / measurement_window * 100
 *   - TBT (Total Blocking Time)
 *   - Long Task 수, 최대/평균 Long Task 시간
 *
 * 사용:
 *   node bench/main-thread-occupancy.js
 *
 * 환경변수:
 *   RUNS=5           반복 횟수 (기본 5)
 *   CPU_THROTTLE=4   CPU 스로틀 배율 (기본 4)
 *   BASE_URL=http://localhost:3000
 *   PDF_URL=/sample4.pdf
 *   SETTLE_TIME=5000  안정화 대기 시간 ms (기본 5000)
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const RUNS = Number(process.env.RUNS || 5);
const CPU_THROTTLE = Number(process.env.CPU_THROTTLE || 4);
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const PDF_URL = process.env.PDF_URL || '/sample4.pdf';
const SETTLE_TIME = Number(process.env.SETTLE_TIME || 5000);

const TEST_URLS = [
  {
    url: `${BASE_URL}/pdf-bench/basic?url=${PDF_URL}`,
    name: 'Basic (pdfOld, 스케줄링 없음)',
    shortName: 'basic',
  },
  {
    url: `${BASE_URL}/pdf-bench/simple?url=${PDF_URL}`,
    name: 'Simple (IntersectionObserver)',
    shortName: 'simple',
  },
  {
    url: `${BASE_URL}/pdf-bench/optimized?url=${PDF_URL}`,
    name: 'Optimized (Baseline)',
    shortName: 'optimized',
  },
  {
    url: `${BASE_URL}/pdf-bench/opt14?url=${PDF_URL}`,
    name: 'Opt14 (getPage Cache)',
    shortName: 'opt14',
  },
  {
    url: `${BASE_URL}/pdf-bench/opt15?url=${PDF_URL}`,
    name: 'Opt15 (RAF+IO+Worker, Limit=3)',
    shortName: 'opt15',
  },
  {
    url: `${BASE_URL}/pdf-bench/opt15-nolimit?url=${PDF_URL}`,
    name: 'Opt15-NoLimit (RAF+IO+Worker)',
    shortName: 'opt15-nolimit',
  },
  {
    url: `${BASE_URL}/pdf-bench/opt-worker-only?url=${PDF_URL}`,
    name: 'WorkerOnly (OffscreenCanvas)',
    shortName: 'worker-only',
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

  // 페이지 로드 전 메트릭 수집 설정
  await page.evaluateOnNewDocument(() => {
    window.__metrics = {
      longTasks: [],
      firstContentfulPaint: null,
      navigationStartTime: performance.now(),
      canvasCount: 0,
      firstCanvasTime: null,
    };

    if (window.PerformanceObserver) {
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            window.__metrics.longTasks.push({
              start: e.startTime,
              dur: e.duration,
            });
          }
        }).observe({ type: 'longtask', buffered: true });

        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            if (e.name === 'first-contentful-paint' && !window.__metrics.firstContentfulPaint) {
              window.__metrics.firstContentfulPaint = e.startTime;
            }
          }
        }).observe({ type: 'paint', buffered: true });
      } catch (_) {}
    }

    // Canvas 생성 추적
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

  const navStart = Date.now();
  await page.goto(testUrl, { waitUntil: 'networkidle2', timeout: 60000 });

  // 캔버스 생성 대기
  try {
    await page.waitForFunction(() => window.__metrics.canvasCount > 0, { timeout: 30000 });
  } catch {
    // 타임아웃 — 계속
  }

  // 안정화 대기 (long task 수집을 위해)
  await new Promise((r) => setTimeout(r, SETTLE_TIME));

  const result = await page.evaluate((settleTime) => {
    const now = performance.now();
    const fcp = window.__metrics.firstContentfulPaint || 0;
    const tasks = window.__metrics.longTasks;
    const nav = performance.getEntriesByType('navigation')[0];
    const navStart = nav?.fetchStart || 0;

    // 측정 윈도우: navigation start ~ now
    const measurementWindow = now - navStart;

    // Long Task 총 시간
    const totalLongTaskDuration = tasks.reduce((sum, t) => sum + t.dur, 0);

    // 메인스레드 점유율 (%)
    const occupancy = measurementWindow > 0
      ? (totalLongTaskDuration / measurementWindow) * 100
      : 0;

    // TBT 계산 (FCP 이후의 long task에서 50ms 초과분)
    const tbt = tasks
      .filter((t) => fcp > 0 && t.start + t.dur > fcp)
      .reduce((sum, t) => sum + Math.max(0, t.dur - 50), 0);

    const longDurations = tasks.map((t) => t.dur);

    return {
      // 핵심 지표
      occupancy: Math.round(occupancy * 100) / 100,
      totalLongTaskDuration: Math.round(totalLongTaskDuration),
      measurementWindow: Math.round(measurementWindow),

      // 보조 지표
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
  }, SETTLE_TIME);

  await browser.close();

  console.log(
    `점유율=${result.occupancy}%  TBT=${result.tbt}ms  LongTask=${result.longTaskCount}개  totalDur=${result.totalLongTaskDuration}ms / ${result.measurementWindow}ms`
  );
  return { ...result, version: versionName, run };
}

// ── 통계 ──────────────────────────────────────────────────────────────
function stats(arr) {
  if (!arr.length) return { avg: 0, min: 0, max: 0, median: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    avg: Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 100) / 100,
    min: Math.round(sorted[0] * 100) / 100,
    max: Math.round(sorted[sorted.length - 1] * 100) / 100,
    median: Math.round(
      (sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) * 100
    ) / 100,
  };
}

// ── 결과 테이블 ───────────────────────────────────────────────────────
function printTable(summaries) {
  const SEP = '═'.repeat(110);
  const baseline = summaries[0]?.occupancy.median || 1;

  console.log(`\n${SEP}`);
  console.log(` 메인스레드 점유율 비교  [CPU ${CPU_THROTTLE}x · ${RUNS}회 · settle ${SETTLE_TIME}ms]`);
  console.log(`${SEP}`);
  console.log(
    `${'버전'.padEnd(38)} ${'점유율 med'.padStart(11)} ${'vs basic'.padStart(10)} ${'점유율 avg'.padStart(11)} ${'TBT med'.padStart(9)} ${'LongTask'.padStart(9)} ${'maxDur'.padStart(8)} ${'totalDur'.padStart(9)}`
  );
  console.log(
    `${'─'.repeat(38)} ${'─'.repeat(11)} ${'─'.repeat(10)} ${'─'.repeat(11)} ${'─'.repeat(9)} ${'─'.repeat(9)} ${'─'.repeat(8)} ${'─'.repeat(9)}`
  );

  for (const s of summaries) {
    const diff = s.occupancy.median - baseline;
    const pct = baseline > 0 ? ((diff / baseline) * 100).toFixed(1) : '0.0';
    const sign =
      s.shortName === 'basic'
        ? '  (base)'
        : diff < 0
        ? `↓${Math.abs(Number(pct))}%`
        : diff > 0
        ? `↑${pct}%`
        : '  =';

    console.log(
      `${s.version.padEnd(38)} ${(s.occupancy.median + '%').padStart(11)} ${sign.padStart(10)} ${(s.occupancy.avg + '%').padStart(11)} ${(s.tbt.median + 'ms').padStart(9)} ${String(s.longTaskCount.avg).padStart(9)} ${(s.longTaskMax.median + 'ms').padStart(8)} ${(s.totalLongTaskDuration.median + 'ms').padStart(9)}`
    );
  }
  console.log(`${SEP}`);

  // 개선율 요약
  if (summaries.length >= 2) {
    const base = summaries[0].occupancy.median;
    console.log('\n📊 Basic 대비 메인스레드 점유율 변화:');
    for (const s of summaries.slice(1)) {
      const saved = base - s.occupancy.median;
      if (saved > 0) {
        console.log(
          `  ${s.version}: ${base}% → ${s.occupancy.median}%  (↓${saved.toFixed(2)}%p, ${((saved / base) * 100).toFixed(1)}% 감소)`
        );
      } else if (saved < 0) {
        console.log(
          `  ${s.version}: ${base}% → ${s.occupancy.median}%  (↑${Math.abs(saved).toFixed(2)}%p 증가)`
        );
      } else {
        console.log(`  ${s.version}: 변화 없음`);
      }
    }
    console.log('');
  }
}

// ── 메인 ──────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(` 메인스레드 점유율 벤치마크`);
  console.log(` CPU ${CPU_THROTTLE}x throttle · ${RUNS}회 반복 · settle ${SETTLE_TIME}ms · PDF: ${PDF_URL}`);
  console.log(`${'═'.repeat(70)}`);

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

  // 통계 집계
  const summaries = TEST_URLS.map((t) => {
    const runs = allResults[t.shortName] || [];
    return {
      version: t.name,
      shortName: t.shortName,
      occupancy: stats(runs.map((r) => r.occupancy)),
      totalLongTaskDuration: stats(runs.map((r) => r.totalLongTaskDuration)),
      measurementWindow: stats(runs.map((r) => r.measurementWindow)),
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

  // 상세 통계
  console.log('상세 통계:');
  for (const s of summaries) {
    console.log(`\n  ${s.version} (${s.runs}회)`);
    console.log(`    점유율     : median=${s.occupancy.median}%  avg=${s.occupancy.avg}%  min=${s.occupancy.min}%  max=${s.occupancy.max}%`);
    console.log(`    LongTask총 : median=${s.totalLongTaskDuration.median}ms / 측정윈도=${s.measurementWindow.median}ms`);
    console.log(`    TBT        : median=${s.tbt.median}ms  avg=${s.tbt.avg}ms  min=${s.tbt.min}ms  max=${s.tbt.max}ms`);
    console.log(`    FCP        : median=${s.fcp.median}ms  avg=${s.fcp.avg}ms`);
    console.log(`    1st Canvas : median=${s.firstCanvasTime.median}ms`);
    console.log(`    LongTask   : avg=${s.longTaskCount.avg}개  maxDur=${s.longTaskMax.median}ms  avgDur=${s.longTaskAvg.median}ms`);
  }

  // JSON 저장
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `main-thread-occupancy-${ts}.json`);
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        summaries,
        allResults,
        meta: {
          runs: RUNS,
          cpuThrottle: CPU_THROTTLE,
          settleTime: SETTLE_TIME,
          baseUrl: BASE_URL,
          pdfUrl: PDF_URL,
          timestamp: new Date().toISOString(),
          metric: 'Main Thread Occupancy (%) = sum(longTask durations) / measurement_window * 100',
        },
      },
      null,
      2
    )
  );
  console.log(`\n결과 저장: ${outFile}`);

  return { summaries, outFile };
}

main().catch((e) => {
  console.error('벤치마크 오류:', e);
  process.exit(1);
});
