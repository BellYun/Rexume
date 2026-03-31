#!/usr/bin/env node
/**
 * PC 화면(1920x1080)에서 PDF 1-2페이지 렌더링 성능 비교
 * Basic (메인스레드) vs OffscreenCanvas Worker
 *
 * 측정: TBT, FCP, LongTask, 1페이지/2페이지 캔버스 등장 시점
 *
 * 사용:
 *   node bench/pc-pages12-basic-vs-worker.js
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
    name: 'Basic (메인스레드)',
    shortName: 'basic',
  },
  {
    url: `${BASE_URL}/pdf-bench/simple-io?url=${PDF_URL}`,
    name: 'IO only (메인스레드)',
    shortName: 'io-only',
  },
  {
    url: `${BASE_URL}/pdf-bench/opt15?url=${PDF_URL}`,
    name: 'OffscreenCanvas Worker',
    shortName: 'offscreen-worker',
  },
];

const outDir = path.join(__dirname, 'results');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

async function measure(testUrl, versionName, run) {
  process.stdout.write(`  [${run}/${RUNS}] ${versionName} ... `);

  const launchOptions = {
    headless: 'new',
    defaultViewport: { width: 1920, height: 1080 },
    args: ['--disable-dev-shm-usage', '--no-sandbox'],
    protocolTimeout: 120000,
  };
  if (fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')) {
    launchOptions.executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }

  const browser = await puppeteer.launch(launchOptions);
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);

  const client = await page.target().createCDPSession();
  await client.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });

  // LongTask + FCP 수집만 인-페이지에서
  await page.evaluateOnNewDocument(() => {
    window.__m = { longTasks: [], fcp: null };
    if (window.PerformanceObserver) {
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries())
            window.__m.longTasks.push({ start: e.startTime, dur: e.duration });
        }).observe({ type: 'longtask', buffered: true });

        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            if (e.name === 'first-contentful-paint' && !window.__m.fcp)
              window.__m.fcp = e.startTime;
          }
        }).observe({ type: 'paint', buffered: true });
      } catch (_) {}
    }
  });

  // 네비게이션 시작 시각 기록
  const navStart = Date.now();
  await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Puppeteer 측에서 캔버스 렌더링 완료 폴링 (canvas width > 0 체크)
  let page1Time = null;
  let page2Time = null;

  const pollStart = Date.now();
  const POLL_TIMEOUT = 45000;

  while (Date.now() - pollStart < POLL_TIMEOUT) {
    const canvasInfo = await page.evaluate(() => {
      const canvases = Array.from(document.querySelectorAll('canvas'));
      return canvases.map((c) => ({
        width: c.width,
        height: c.height,
        offsetWidth: c.offsetWidth,
        display: getComputedStyle(c).display,
      }));
    });

    // height > 300인 캔버스 = PDF 렌더 완료 (기본 canvas height는 150)
    const rendered = canvasInfo.filter((c) => c.height > 300);

    if (rendered.length >= 1 && page1Time === null) {
      page1Time = Date.now() - navStart;
    }
    if (rendered.length >= 2 && page2Time === null) {
      page2Time = Date.now() - navStart;
      break;
    }

    await new Promise((r) => setTimeout(r, 100));
  }

  // 안정화 대기 (TBT 수집)
  await new Promise((r) => setTimeout(r, 3000));

  // 인-페이지 메트릭 수집
  const result = await page.evaluate(() => {
    const fcp = window.__m.fcp || 0;
    const tasks = window.__m.longTasks;
    const tbt = tasks
      .filter((t) => fcp > 0 && t.start + t.dur > fcp)
      .reduce((sum, t) => sum + Math.max(0, t.dur - 50), 0);

    const nav = performance.getEntriesByType('navigation')[0];
    const longDurations = tasks.map((t) => t.dur);

    return {
      tbt: Math.round(tbt),
      fcp: Math.round(fcp),
      longTaskCount: tasks.length,
      longTaskMax: longDurations.length ? Math.round(Math.max(...longDurations)) : 0,
      longTaskAvg: longDurations.length
        ? Math.round(longDurations.reduce((a, b) => a + b, 0) / longDurations.length)
        : 0,
      loadComplete: Math.round((nav?.loadEventEnd - nav?.fetchStart) || 0),
    };
  });

  await browser.close();

  result.page1Render = page1Time;
  result.page2Render = page2Time;
  result.version = versionName;
  result.run = run;

  const p1 = page1Time !== null ? `P1=${page1Time}ms` : 'P1=N/A';
  const p2 = page2Time !== null ? `P2=${page2Time}ms` : 'P2=N/A';
  console.log(
    `${p1}  ${p2}  TBT=${result.tbt}ms  FCP=${result.fcp}ms  LongTask=${result.longTaskCount}개  maxDur=${result.longTaskMax}ms`
  );
  return result;
}

function stats(arr) {
  const valid = arr.filter((v) => v !== null && v !== undefined);
  if (!valid.length) return { avg: 0, min: 0, max: 0, median: 0 };
  const sorted = [...valid].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    avg: Math.round(valid.reduce((a, b) => a + b, 0) / valid.length),
    min: Math.round(sorted[0]),
    max: Math.round(sorted[sorted.length - 1]),
    median: Math.round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2),
  };
}

function printTable(summaries) {
  const SEP = '='.repeat(110);

  console.log(`\n${SEP}`);
  console.log(` PC(1920x1080) PDF 1-2페이지 렌더링 비교  [CPU ${CPU_THROTTLE}x · ${RUNS}회]`);
  console.log(`${SEP}`);
  console.log(
    `${'버전'.padEnd(30)} ${'P1 median'.padStart(11)} ${'P2 median'.padStart(11)} ${'TBT median'.padStart(12)} ${'FCP'.padStart(8)} ${'LongTask'.padStart(9)} ${'maxDur'.padStart(8)}`
  );
  console.log(
    `${'─'.repeat(30)} ${'─'.repeat(11)} ${'─'.repeat(11)} ${'─'.repeat(12)} ${'─'.repeat(8)} ${'─'.repeat(9)} ${'─'.repeat(8)}`
  );

  for (const s of summaries) {
    const p1 = s.page1Render.median ? s.page1Render.median + 'ms' : 'N/A';
    const p2 = s.page2Render.median ? s.page2Render.median + 'ms' : 'N/A';
    console.log(
      `${s.version.padEnd(30)} ${p1.padStart(11)} ${p2.padStart(11)} ${(s.tbt.median + 'ms').padStart(12)} ${(s.fcp.median + 'ms').padStart(8)} ${String(s.longTaskCount.avg).padStart(9)} ${(s.longTaskMax.median + 'ms').padStart(8)}`
    );
  }
  console.log(SEP);

  if (summaries.length === 2) {
    const [base, worker] = summaries;
    console.log('\n--- 비교 분석 (Basic 대비 OffscreenCanvas Worker) ---');

    const compare = (label, baseVal, workerVal) => {
      if (!baseVal || !workerVal) { console.log(`  ${label}: 측정 불가`); return; }
      const diff = baseVal - workerVal;
      const pct = baseVal > 0 ? ((diff / baseVal) * 100).toFixed(1) : '0.0';
      if (diff > 0) {
        console.log(`  ${label}: ${baseVal}ms → ${workerVal}ms  (↓${diff}ms, ${pct}% 감소)`);
      } else if (diff < 0) {
        console.log(`  ${label}: ${baseVal}ms → ${workerVal}ms  (↑${Math.abs(diff)}ms, ${Math.abs(Number(pct))}% 증가)`);
      } else {
        console.log(`  ${label}: ${baseVal}ms  (변화 없음)`);
      }
    };

    compare('1페이지 렌더링', base.page1Render.median, worker.page1Render.median);
    compare('2페이지 렌더링', base.page2Render.median, worker.page2Render.median);
    compare('TBT           ', base.tbt.median, worker.tbt.median);
    compare('FCP           ', base.fcp.median, worker.fcp.median);
    compare('LongTask 최대 ', base.longTaskMax.median, worker.longTaskMax.median);
    console.log('');
  }
}

async function main() {
  console.log(`\n${'='.repeat(70)}`);
  console.log(` PC(1920x1080) PDF 1-2페이지: Basic vs OffscreenCanvas Worker`);
  console.log(` CPU ${CPU_THROTTLE}x throttle · ${RUNS}회 반복 · PDF: ${PDF_URL}`);
  console.log(`${'='.repeat(70)}`);

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
      page1Render: stats(runs.map((r) => r.page1Render)),
      page2Render: stats(runs.map((r) => r.page2Render)),
      tbt: stats(runs.map((r) => r.tbt)),
      fcp: stats(runs.map((r) => r.fcp)),
      longTaskCount: stats(runs.map((r) => r.longTaskCount)),
      longTaskMax: stats(runs.map((r) => r.longTaskMax)),
      loadComplete: stats(runs.map((r) => r.loadComplete)),
      runs: runs.length,
    };
  });

  printTable(summaries);

  console.log('상세 통계:');
  for (const s of summaries) {
    console.log(`\n  ${s.version} (${s.runs}회)`);
    console.log(`    1페이지    : median=${s.page1Render.median}ms  avg=${s.page1Render.avg}ms  min=${s.page1Render.min}ms  max=${s.page1Render.max}ms`);
    console.log(`    2페이지    : median=${s.page2Render.median}ms  avg=${s.page2Render.avg}ms  min=${s.page2Render.min}ms  max=${s.page2Render.max}ms`);
    console.log(`    TBT        : median=${s.tbt.median}ms  avg=${s.tbt.avg}ms  min=${s.tbt.min}ms  max=${s.tbt.max}ms`);
    console.log(`    FCP        : median=${s.fcp.median}ms  avg=${s.fcp.avg}ms`);
    console.log(`    LongTask   : avg=${s.longTaskCount.avg}개  maxDur median=${s.longTaskMax.median}ms`);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `pc-pages12-${ts}.json`);
  fs.writeFileSync(
    outFile,
    JSON.stringify({
      summaries,
      allResults,
      meta: { runs: RUNS, cpuThrottle: CPU_THROTTLE, viewport: '1920x1080', pdfUrl: PDF_URL, timestamp: new Date().toISOString() },
    }, null, 2)
  );
  console.log(`\n결과 저장: ${outFile}`);
}

main().catch((e) => {
  console.error('벤치마크 오류:', e);
  process.exit(1);
});
