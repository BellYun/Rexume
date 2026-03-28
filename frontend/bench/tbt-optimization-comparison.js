#!/usr/bin/env node
/**
 * TBT 비교 벤치마크: pdf-optimazation vs 기존 버전
 *
 * 비교 대상:
 *   1. Basic (개선 전)
 *   2. Simple 75vh + rAF (기존 최고)
 *   3. pdf-optimazation (번들 최적화 + RAF + IO)
 *
 * 사용:
 *   node bench/tbt-optimization-comparison.js
 *
 * 환경변수:
 *   RUNS=5           반복 횟수 (기본 5)
 *   CPU_THROTTLE=4   CPU 스로틀 배율 (기본 4)
 *   BASE_URL=http://localhost:3000
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const RUNS = Number(process.env.RUNS || 5);
const CPU_THROTTLE = Number(process.env.CPU_THROTTLE || 4);
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

const TEST_URLS = [
  {
    url: `${BASE_URL}/pdf-bench/basic?url=/sample4.pdf`,
    name: 'Basic (개선 전)',
    shortName: 'basic',
  },
  {
    url: `${BASE_URL}/pdf-bench/simple?url=/sample4.pdf`,
    name: 'Simple 75vh + rAF (기존 최고)',
    shortName: 'simple-75vh-raf',
  },
  {
    url: `${BASE_URL}/pdf-optimazation?url=/sample4.pdf`,
    name: 'PDF Optimization (번들 최적화)',
    shortName: 'pdf-optimazation',
  },
];

const outDir = path.join(__dirname, 'results');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

// ── 단일 측정 ─────────────────────────────────────────────────────────
async function measure(testUrl, versionName, run) {
  console.log(`\n  [${run}/${RUNS}] ${versionName}`);

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

  // 측정용 코드 주입 (페이지 로드 전)
  await page.evaluateOnNewDocument(() => {
    window.__metrics = {
      longTasks: [],
      firstContentfulPaint: null,
      firstCanvasTime: null,
      canvasCount: 0,
      startTime: performance.now(),
    };

    // LongTask 감시
    if (window.PerformanceObserver) {
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            window.__metrics.longTasks.push({ start: e.startTime, dur: e.duration });
          }
        }).observe({ type: 'longtask', buffered: true });

        // FCP 감시
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            if (e.name === 'first-contentful-paint' && !window.__metrics.firstContentfulPaint) {
              window.__metrics.firstContentfulPaint = e.startTime;
            }
          }
        }).observe({ type: 'paint', buffered: true });
      } catch (_) {}
    }

    // Canvas 생성 감지 (첫 canvas 시각)
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

  // 첫 canvas 생성 대기 (최대 30초)
  try {
    await page.waitForFunction(() => window.__metrics.canvasCount > 0, { timeout: 30000 });
  } catch {
    console.warn('    canvas 생성 타임아웃');
  }

  // PDF 렌더링 안정화 대기
  await new Promise((r) => setTimeout(r, 3000));

  const result = await page.evaluate(() => {
    const fcp = window.__metrics.firstContentfulPaint || 0;
    const tasks = window.__metrics.longTasks;

    // TBT = FCP 이후 longTask 중 50ms 초과분 합산
    const tbt = tasks
      .filter((t) => t.start + t.dur > fcp && fcp > 0)
      .reduce((sum, t) => sum + Math.max(0, t.dur - 50), 0);

    const paintEntries = performance.getEntriesByType('paint');
    const fcpEntry = paintEntries.find((p) => p.name === 'first-contentful-paint');
    const nav = performance.getEntriesByType('navigation')[0];

    return {
      tbt: Math.round(tbt),
      fcp: Math.round(fcp || fcpEntry?.startTime || 0),
      firstCanvasTime: Math.round(window.__metrics.firstCanvasTime || 0),
      longTaskCount: tasks.length,
      longTaskMax: tasks.length ? Math.round(Math.max(...tasks.map((t) => t.dur))) : 0,
      canvasCount: window.__metrics.canvasCount,
      loadComplete: Math.round((nav?.loadEventEnd - nav?.fetchStart) || 0),
    };
  });

  await browser.close();
  return { ...result, version: versionName, shortName: undefined, url: testUrl, run };
}

// ── 통계 계산 ─────────────────────────────────────────────────────────
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

// ── 결과 테이블 출력 ──────────────────────────────────────────────────
function printTable(summaries) {
  const W = 32;
  const bar = '─'.repeat(W);
  console.log(`\n${'═'.repeat(90)}`);
  console.log(' TBT 비교 결과 (CPU 4x throttle, pdf-optimazation vs 기존 버전)');
  console.log(`${'═'.repeat(90)}`);
  console.log(
    `${'버전'.padEnd(W)} ${'TBT median'.padStart(12)} ${'TBT avg'.padStart(10)} ${'FCP'.padStart(8)} ${'LongTask'.padStart(10)} ${'Canvas'.padStart(8)}`
  );
  console.log(`${bar} ${'─'.repeat(12)} ${'─'.repeat(10)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(8)}`);

  const baseline = summaries[0]?.tbt.median || 1;

  for (const s of summaries) {
    const improvement = baseline > 0
      ? (((baseline - s.tbt.median) / baseline) * 100).toFixed(1)
      : '0.0';
    const sign = Number(improvement) > 0 ? `↓${improvement}%` : Number(improvement) < 0 ? `↑${Math.abs(improvement)}%` : '=';
    const badge = s.version.includes('Optimization') ? ' ✨' : '';
    console.log(
      `${(s.version + badge).padEnd(W)} ${(s.tbt.median + 'ms').padStart(10)} ${sign.padStart(8)}   ${(s.fcp.median + 'ms').padStart(6)}   ${String(s.longTaskCount.avg).padStart(8)}   ${String(s.canvasCount.avg).padStart(6)}`
    );
  }
  console.log(`${'═'.repeat(90)}\n`);
}

// ── 메인 ──────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(` TBT 비교 벤치마크`);
  console.log(` CPU ${CPU_THROTTLE}x throttle · ${RUNS}회 반복 · ${BASE_URL}`);
  console.log(`${'═'.repeat(60)}`);

  const allResults = {};

  for (const target of TEST_URLS) {
    console.log(`\n▶ ${target.name}`);
    allResults[target.shortName] = [];

    for (let r = 1; r <= RUNS; r++) {
      try {
        const result = await measure(target.url, target.name, r);
        allResults[target.shortName].push(result);
        console.log(
          `    TBT: ${result.tbt}ms  FCP: ${result.fcp}ms  LongTask: ${result.longTaskCount}개  Canvas: ${result.canvasCount}`
        );
      } catch (e) {
        console.error(`    오류 (${r}회차):`, e.message);
      }
    }
  }

  // 통계 요약
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
      canvasCount: stats(runs.map((r) => r.canvasCount)),
      loadComplete: stats(runs.map((r) => r.loadComplete)),
      runs: runs.length,
    };
  });

  printTable(summaries);

  // 상세 통계
  console.log('상세 통계:');
  for (const s of summaries) {
    console.log(`\n  ${s.version} (${s.runs}회 측정)`);
    console.log(`    TBT     : median=${s.tbt.median}ms  avg=${s.tbt.avg}ms  min=${s.tbt.min}ms  max=${s.tbt.max}ms`);
    console.log(`    FCP     : median=${s.fcp.median}ms  avg=${s.fcp.avg}ms`);
    console.log(`    1st Canvas: median=${s.firstCanvasTime.median}ms`);
    console.log(`    LongTask: avg=${s.longTaskCount.avg}개  maxDur=${s.longTaskMax.median}ms`);
  }

  // JSON 저장
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `tbt-comparison-${timestamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ summaries, allResults, meta: { runs: RUNS, cpuThrottle: CPU_THROTTLE, baseUrl: BASE_URL, timestamp: new Date().toISOString() } }, null, 2));
  console.log(`\n결과 저장: ${outFile}`);
}

main().catch((e) => {
  console.error('벤치마크 오류:', e);
  process.exit(1);
});
