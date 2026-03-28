#!/usr/bin/env node
/**
 * TBT 비교: Basic vs WorkerOnly vs RAF+IO+OffscreenWorker
 *
 * 사용:
 *   node bench/tbt-basic-vs-worker.js
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
    url: `${BASE_URL}/pdf-bench/basic?url=${PDF_URL}`,
    name: 'Basic (스케줄링 없음)',
    shortName: 'basic',
  },
  {
    url: `${BASE_URL}/pdf-bench/simple?url=${PDF_URL}`,
    name: 'IO (IntersectionObserver)',
    shortName: 'simple-io',
  },
  {
    url: `${BASE_URL}/pdf-bench/opt-worker-only?url=${PDF_URL}`,
    name: 'WorkerOnly (OffscreenCanvas)',
    shortName: 'worker-only',
  },
  {
    url: `${BASE_URL}/pdf-bench/opt15?url=${PDF_URL}`,
    name: 'IO + Worker',
    shortName: 'io-worker',
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
    };

    if (window.PerformanceObserver) {
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            window.__metrics.longTasks.push({ start: e.startTime, dur: e.duration });
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

  try {
    await page.waitForFunction(() => window.__metrics.canvasCount > 0, { timeout: 30000 });
  } catch {
    // canvas 생성 타임아웃 — 계속 진행
  }

  await new Promise((r) => setTimeout(r, 3000));

  const result = await page.evaluate(() => {
    const fcp = window.__metrics.firstContentfulPaint || 0;
    const tasks = window.__metrics.longTasks;

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
    `TBT=${result.tbt}ms  FCP=${result.fcp}ms  LongTask=${result.longTaskCount}개  maxDur=${result.longTaskMax}ms`
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
  const SEP = '═'.repeat(96);
  const baseline = summaries[0]?.tbt.median || 1;

  console.log(`\n${SEP}`);
  console.log(` TBT 비교: Basic  vs  WorkerOnly  vs  RAF+IO+OffscreenWorker  [CPU ${CPU_THROTTLE}x · ${RUNS}회]`);
  console.log(`${SEP}`);
  console.log(
    `${'버전'.padEnd(36)} ${'TBT median'.padStart(11)} ${'vs baseline'.padStart(12)} ${'TBT avg'.padStart(9)} ${'FCP'.padStart(7)} ${'LongTask'.padStart(9)} ${'maxDur'.padStart(7)}`
  );
  console.log(`${'─'.repeat(36)} ${'─'.repeat(11)} ${'─'.repeat(12)} ${'─'.repeat(9)} ${'─'.repeat(7)} ${'─'.repeat(9)} ${'─'.repeat(7)}`);

  for (const s of summaries) {
    const diff = s.tbt.median - baseline;
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
      `${s.version.padEnd(36)} ${(s.tbt.median + 'ms').padStart(11)} ${sign.padStart(12)} ${(s.tbt.avg + 'ms').padStart(9)} ${(s.fcp.median + 'ms').padStart(7)} ${String(s.longTaskCount.avg).padStart(9)} ${(s.longTaskMax.median + 'ms').padStart(7)}`
    );
  }
  console.log(`${SEP}`);

  if (summaries.length >= 2) {
    const base = summaries[0].tbt.median;
    console.log('');
    for (const s of summaries.slice(1)) {
      const saved = base - s.tbt.median;
      if (saved > 0) {
        console.log(`  ${s.version}: ${base}ms → ${s.tbt.median}ms  (↓${saved}ms, ${((saved / base) * 100).toFixed(1)}% 감소)`);
      } else if (saved < 0) {
        console.log(`  ${s.version}: ${base}ms → ${s.tbt.median}ms  (↑${Math.abs(saved)}ms 증가)`);
      } else {
        console.log(`  ${s.version}: 변화 없음`);
      }
    }
    console.log('');
  }
}

// ── 메인 ──────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(` TBT 벤치마크: Basic vs WorkerOnly vs RAF+IO+OffscreenWorker`);
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

  console.log('상세 통계:');
  for (const s of summaries) {
    console.log(`\n  ${s.version} (${s.runs}회)`);
    console.log(`    TBT        : median=${s.tbt.median}ms  avg=${s.tbt.avg}ms  min=${s.tbt.min}ms  max=${s.tbt.max}ms`);
    console.log(`    FCP        : median=${s.fcp.median}ms  avg=${s.fcp.avg}ms`);
    console.log(`    1st Canvas : median=${s.firstCanvasTime.median}ms`);
    console.log(`    LongTask   : avg=${s.longTaskCount.avg}개  maxDur=${s.longTaskMax.median}ms  avgDur=${s.longTaskAvg.median}ms`);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `tbt-basic-vs-worker-${ts}.json`);
  fs.writeFileSync(
    outFile,
    JSON.stringify({ summaries, allResults, meta: { runs: RUNS, cpuThrottle: CPU_THROTTLE, baseUrl: BASE_URL, pdfUrl: PDF_URL, timestamp: new Date().toISOString() } }, null, 2)
  );
  console.log(`\n결과 저장: ${outFile}`);

  return { summaries, outFile };
}

main().catch((e) => {
  console.error('벤치마크 오류:', e);
  process.exit(1);
});
