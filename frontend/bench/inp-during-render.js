#!/usr/bin/env node
/**
 * INP During Render — 렌더링 진행 중 인터랙션 응답성 정밀 측정
 *
 * 핵심: Long Task가 실행 중인 구간에서만 인터랙션을 보내서
 *       메인스레드 블로킹이 실제로 인터랙션 지연에 미치는 영향을 측정
 *
 * 측정 방식:
 *   1. 페이지 로드 즉시 (domcontentloaded) 반복 인터랙션 시작
 *   2. 각 인터랙션마다: event dispatch → RAF 콜백 도달 시간 측정
 *   3. 동시에 Long Task 기록 → 인터랙션이 Long Task와 겹치는지 판별
 *   4. "렌더 중 지연" vs "유휴 시 지연" 분리 분석
 *
 * 사용:
 *   node bench/inp-during-render.js
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const RUNS = Number(process.env.RUNS || 3);
const CPU_THROTTLE = Number(process.env.CPU_THROTTLE || 4);
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const PDF_URL = process.env.PDF_URL || '/sample4.pdf';

const TEST_URLS = [
  { url: `${BASE_URL}/pdf-bench/basic?url=${PDF_URL}`, name: 'Basic (스케줄링 없음)', shortName: 'basic' },
  { url: `${BASE_URL}/pdf-bench/simple?url=${PDF_URL}`, name: 'Simple (IO)', shortName: 'simple' },
  { url: `${BASE_URL}/pdf-bench/optimized?url=${PDF_URL}`, name: 'Optimized (IO+RAF+Limit)', shortName: 'optimized' },
  { url: `${BASE_URL}/pdf-bench/opt14?url=${PDF_URL}`, name: 'Opt14 (IO+RAF+Cache)', shortName: 'opt14' },
  { url: `${BASE_URL}/pdf-bench/opt15?url=${PDF_URL}`, name: 'Opt15 (Worker+RAF)', shortName: 'opt15' },
  { url: `${BASE_URL}/pdf-bench/opt15-nolimit?url=${PDF_URL}`, name: 'Opt15-NL (Worker+RAF)', shortName: 'opt15-nolimit' },
  { url: `${BASE_URL}/pdf-bench/opt-worker-only?url=${PDF_URL}`, name: 'WorkerOnly (Worker)', shortName: 'worker-only' },
];

const outDir = path.join(__dirname, 'results');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

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

  // ── 측정 스크립트 주입 ──
  await page.evaluateOnNewDocument(() => {
    window.__m = {
      longTasks: [],
      probes: [],       // 주기적 probe 결과
      frames: [],
      fcpTime: null,
      probeRunning: false,
    };

    // Long Task 추적
    if (window.PerformanceObserver) {
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            window.__m.longTasks.push({ start: e.startTime, dur: e.duration, end: e.startTime + e.duration });
          }
        }).observe({ type: 'longtask', buffered: true });

        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            if (e.name === 'first-contentful-paint') window.__m.fcpTime = e.startTime;
          }
        }).observe({ type: 'paint', buffered: true });
      } catch (_) {}
    }

    // ── Probe 시스템 ──
    // 50ms 마다 setTimeout → RAF까지의 시간을 측정
    // setTimeout 콜백이 Long Task에 의해 지연되면 delay 증가
    // RAF 콜백이 지연되면 추가 delay 증가
    window.__startProbing = function() {
      if (window.__m.probeRunning) return;
      window.__m.probeRunning = true;

      const PROBE_INTERVAL = 50;  // 50ms마다 probe
      const PROBE_DURATION = 8000; // 8초간
      const startTime = performance.now();
      let probeId = 0;

      function probe() {
        const now = performance.now();
        if (now - startTime > PROBE_DURATION) {
          window.__m.probeRunning = false;
          return;
        }

        const id = probeId++;
        const scheduledTime = performance.now();

        // setTimeout(0) → 메인스레드가 바쁘면 지연됨
        setTimeout(() => {
          const timeoutFired = performance.now();
          const timeoutDelay = timeoutFired - scheduledTime;

          // RAF → 다음 페인트까지
          requestAnimationFrame(() => {
            const rafFired = performance.now();
            const rafDelay = rafFired - timeoutFired;
            const totalDelay = rafFired - scheduledTime;

            // 이 probe가 Long Task와 겹치는지 확인
            const overlappingLT = window.__m.longTasks.filter(lt =>
              lt.start <= rafFired && lt.end >= scheduledTime
            );

            window.__m.probes.push({
              id,
              scheduledTime,
              timeoutDelay: Math.round(timeoutDelay * 10) / 10,
              rafDelay: Math.round(rafDelay * 10) / 10,
              totalDelay: Math.round(totalDelay * 10) / 10,
              duringLongTask: overlappingLT.length > 0,
              overlappingLTCount: overlappingLT.length,
              maxOverlappingDur: overlappingLT.length > 0
                ? Math.round(Math.max(...overlappingLT.map(lt => lt.dur)))
                : 0,
            });

            // 다음 probe 스케줄
            setTimeout(probe, PROBE_INTERVAL);
          });
        }, 0);
      }

      probe();
    };

    // ── 프레임 타이밍 ──
    let lastFrame = 0;
    let frameStart = 0;
    function trackFrame(ts) {
      if (!frameStart) frameStart = ts;
      if (ts - frameStart > 8000) return;
      if (lastFrame > 0) {
        const delta = ts - lastFrame;
        window.__m.frames.push({ time: ts, delta });
      }
      lastFrame = ts;
      requestAnimationFrame(trackFrame);
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(trackFrame));
    } else {
      requestAnimationFrame(trackFrame);
    }
  });

  // ── 페이지 로드 ──
  await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // 즉시 probing 시작 (렌더링과 동시에)
  await page.evaluate(() => window.__startProbing());

  // 동시에 키보드/스크롤 인터랙션 수행 (8초간)
  const interactionStart = Date.now();
  let interactionCount = 0;
  while (Date.now() - interactionStart < 8000) {
    // ArrowDown 키
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown',
      windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40,
    });
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown',
      windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40,
    });
    interactionCount++;
    await new Promise((r) => setTimeout(r, 100));
  }

  // 안정화 대기
  await new Promise((r) => setTimeout(r, 2000));

  // ── 결과 수집 ──
  const result = await page.evaluate(() => {
    const probes = window.__m.probes;
    const longTasks = window.__m.longTasks;
    const frames = window.__m.frames;
    const fcp = window.__m.fcpTime || 0;

    // Probe 분류: Long Task 중 vs 유휴 시
    const duringLT = probes.filter(p => p.duringLongTask);
    const duringIdle = probes.filter(p => !p.duringLongTask);

    const calcStats = (arr) => {
      if (!arr.length) return { avg: 0, min: 0, max: 0, median: 0, p75: 0, p95: 0, p99: 0, count: 0 };
      const s = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return {
        count: s.length,
        avg: Math.round(s.reduce((a, b) => a + b, 0) / s.length * 10) / 10,
        min: Math.round(s[0] * 10) / 10,
        max: Math.round(s[s.length - 1] * 10) / 10,
        median: Math.round((s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2) * 10) / 10,
        p75: Math.round((s[Math.floor(s.length * 0.75)] || s[s.length - 1]) * 10) / 10,
        p95: Math.round((s[Math.floor(s.length * 0.95)] || s[s.length - 1]) * 10) / 10,
        p99: Math.round((s[Math.floor(s.length * 0.99)] || s[s.length - 1]) * 10) / 10,
      };
    };

    // TBT
    const tbt = longTasks
      .filter(t => fcp > 0 && t.end > fcp)
      .reduce((sum, t) => sum + Math.max(0, t.dur - 50), 0);

    // 프레임 분석
    const deltas = frames.map(f => f.delta);
    const jankFrames = frames.filter(f => f.delta > 50);
    const severeFrames = frames.filter(f => f.delta > 100);
    const droppedFrames = frames.filter(f => f.delta > 33.34);

    return {
      // Probe 전체
      probe: {
        total: calcStats(probes.map(p => p.totalDelay)),
        timeoutDelay: calcStats(probes.map(p => p.timeoutDelay)),
        rafDelay: calcStats(probes.map(p => p.rafDelay)),
      },
      // Long Task 중 Probe
      probeDuringLT: {
        total: calcStats(duringLT.map(p => p.totalDelay)),
        timeoutDelay: calcStats(duringLT.map(p => p.timeoutDelay)),
        rafDelay: calcStats(duringLT.map(p => p.rafDelay)),
        count: duringLT.length,
      },
      // 유휴 시 Probe
      probeDuringIdle: {
        total: calcStats(duringIdle.map(p => p.totalDelay)),
        timeoutDelay: calcStats(duringIdle.map(p => p.timeoutDelay)),
        rafDelay: calcStats(duringIdle.map(p => p.rafDelay)),
        count: duringIdle.length,
      },
      // Long Task
      tbt: Math.round(tbt),
      longTaskCount: longTasks.length,
      longTaskDuration: calcStats(longTasks.map(t => t.dur)),
      // 프레임
      totalFrames: frames.length,
      avgFPS: deltas.length > 0 ? Math.round(1000 / (deltas.reduce((a, b) => a + b, 0) / deltas.length) * 10) / 10 : 0,
      frameDelta: calcStats(deltas),
      jankCount: jankFrames.length,
      jankRate: frames.length > 0 ? Math.round(jankFrames.length / frames.length * 1000) / 10 : 0,
      severeJankCount: severeFrames.length,
      severeJankRate: frames.length > 0 ? Math.round(severeFrames.length / frames.length * 1000) / 10 : 0,
      droppedRate: frames.length > 0 ? Math.round(droppedFrames.length / frames.length * 1000) / 10 : 0,
      // 분류 비율
      probesDuringLTRatio: probes.length > 0
        ? Math.round(duringLT.length / probes.length * 1000) / 10
        : 0,
    };
  });

  await browser.close();

  console.log(
    `probe.p75=${result.probe.total.p75}ms  duringLT.p75=${result.probeDuringLT.total.p75}ms  idle.p75=${result.probeDuringIdle.total.p75}ms  jank=${result.jankRate}%  TBT=${result.tbt}ms  LT중비율=${result.probesDuringLTRatio}%`
  );

  return { ...result, version: versionName, run, interactionCount };
}

function stats(arr) {
  if (!arr.length) return { avg: 0, min: 0, max: 0, median: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    avg: Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 10) / 10,
    min: Math.round(sorted[0] * 10) / 10,
    max: Math.round(sorted[sorted.length - 1] * 10) / 10,
    median: Math.round((sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10,
  };
}

function printTable(summaries) {
  const SEP = '═'.repeat(130);

  console.log(`\n${SEP}`);
  console.log(` 렌더링 중 인터랙션 응답성 벤치마크  [CPU ${CPU_THROTTLE}x · ${RUNS}회]`);
  console.log(` 측정: setTimeout(0)→RAF 도달 시간 (probe), 50ms 간격, 8초간`);
  console.log(`${SEP}`);

  // 테이블 1: 전체 Probe 응답 시간
  const base = summaries[0];
  console.log('\n[1] 전체 Probe 응답 시간 (setTimeout→RAF)');
  console.log(
    `${'버전'.padEnd(30)} ${'median'.padStart(9)} ${'p75'.padStart(9)} ${'p95'.padStart(9)} ${'p99'.padStart(9)} ${'max'.padStart(9)} ${'vs basic'.padStart(10)} ${'probes'.padStart(8)}`
  );
  console.log(`${'─'.repeat(30)} ${'─'.repeat(9)} ${'─'.repeat(9)} ${'─'.repeat(9)} ${'─'.repeat(9)} ${'─'.repeat(9)} ${'─'.repeat(10)} ${'─'.repeat(8)}`);
  for (const s of summaries) {
    const diff = s.probeP75.median - base.probeP75.median;
    const pct = base.probeP75.median > 0 ? Math.round(diff / base.probeP75.median * 100) : 0;
    const sign = s.shortName === 'basic' ? '  (base)' : diff < 0 ? `↓${Math.abs(pct)}%` : diff > 0 ? `↑${pct}%` : '  =';
    console.log(
      `${s.version.padEnd(30)} ${(s.probeMed.median + 'ms').padStart(9)} ${(s.probeP75.median + 'ms').padStart(9)} ${(s.probeP95.median + 'ms').padStart(9)} ${(s.probeP99.median + 'ms').padStart(9)} ${(s.probeMax.median + 'ms').padStart(9)} ${sign.padStart(10)} ${String(s.probeCount.median).padStart(8)}`
    );
  }

  // 테이블 2: Long Task 중 vs 유휴 시
  console.log('\n[2] Long Task 중 Probe vs 유휴 시 Probe (p75)');
  console.log(
    `${'버전'.padEnd(30)} ${'LT중 p75'.padStart(10)} ${'유휴 p75'.padStart(10)} ${'차이'.padStart(8)} ${'LT중 비율'.padStart(10)} ${'LT중 max'.padStart(10)}`
  );
  console.log(`${'─'.repeat(30)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(10)}`);
  for (const s of summaries) {
    const diff = s.ltProbeP75.median - s.idleProbeP75.median;
    console.log(
      `${s.version.padEnd(30)} ${(s.ltProbeP75.median + 'ms').padStart(10)} ${(s.idleProbeP75.median + 'ms').padStart(10)} ${('+' + diff.toFixed(1) + 'ms').padStart(8)} ${(s.ltRatio.median + '%').padStart(10)} ${(s.ltProbeMax.median + 'ms').padStart(10)}`
    );
  }

  // 테이블 3: 프레임 안정성
  console.log('\n[3] 프레임 안정성');
  console.log(
    `${'버전'.padEnd(30)} ${'avgFPS'.padStart(8)} ${'jank%'.padStart(8)} ${'severe%'.padStart(9)} ${'frameDelta p95'.padStart(16)}`
  );
  console.log(`${'─'.repeat(30)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(9)} ${'─'.repeat(16)}`);
  for (const s of summaries) {
    console.log(
      `${s.version.padEnd(30)} ${(s.avgFPS.median + '').padStart(8)} ${(s.jankRate.median + '%').padStart(8)} ${(s.severeJankRate.median + '%').padStart(9)} ${(s.frameDeltaP95.median + 'ms').padStart(16)}`
    );
  }

  // 테이블 4: TBT & Long Task
  console.log('\n[4] TBT & Long Tasks');
  console.log(
    `${'버전'.padEnd(30)} ${'TBT'.padStart(8)} ${'LT수'.padStart(6)} ${'LT avg'.padStart(9)} ${'LT max'.padStart(9)}`
  );
  console.log(`${'─'.repeat(30)} ${'─'.repeat(8)} ${'─'.repeat(6)} ${'─'.repeat(9)} ${'─'.repeat(9)}`);
  for (const s of summaries) {
    console.log(
      `${s.version.padEnd(30)} ${(s.tbt.median + 'ms').padStart(8)} ${String(s.ltCount.median).padStart(6)} ${(s.ltAvg.median + 'ms').padStart(9)} ${(s.ltMax.median + 'ms').padStart(9)}`
    );
  }

  console.log(`\n${SEP}`);
}

async function main() {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(` 렌더링 중 인터랙션 응답성 정밀 벤치마크`);
  console.log(` CPU ${CPU_THROTTLE}x · ${RUNS}회 · probe 50ms간격 · 8초간`);
  console.log(` PDF: ${PDF_URL}`);
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

  const summaries = TEST_URLS.map((t) => {
    const runs = allResults[t.shortName] || [];
    return {
      version: t.name,
      shortName: t.shortName,
      // Probe 전체
      probeMed: stats(runs.map(r => r.probe.total.median)),
      probeP75: stats(runs.map(r => r.probe.total.p75)),
      probeP95: stats(runs.map(r => r.probe.total.p95)),
      probeP99: stats(runs.map(r => r.probe.total.p99)),
      probeMax: stats(runs.map(r => r.probe.total.max)),
      probeCount: stats(runs.map(r => r.probe.total.count)),
      // LT 중 Probe
      ltProbeP75: stats(runs.map(r => r.probeDuringLT.total.p75)),
      ltProbeMax: stats(runs.map(r => r.probeDuringLT.total.max)),
      ltProbeCount: stats(runs.map(r => r.probeDuringLT.count)),
      // 유휴 Probe
      idleProbeP75: stats(runs.map(r => r.probeDuringIdle.total.p75)),
      // LT 비율
      ltRatio: stats(runs.map(r => r.probesDuringLTRatio)),
      // 프레임
      avgFPS: stats(runs.map(r => r.avgFPS)),
      jankRate: stats(runs.map(r => r.jankRate)),
      severeJankRate: stats(runs.map(r => r.severeJankRate)),
      frameDeltaP95: stats(runs.map(r => r.frameDelta.p95)),
      // TBT
      tbt: stats(runs.map(r => r.tbt)),
      ltCount: stats(runs.map(r => r.longTaskCount)),
      ltAvg: stats(runs.map(r => r.longTaskDuration.avg)),
      ltMax: stats(runs.map(r => r.longTaskDuration.max)),
      runs: runs.length,
    };
  });

  printTable(summaries);

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `inp-during-render-${ts}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ summaries, allResults, meta: {
    runs: RUNS, cpuThrottle: CPU_THROTTLE, baseUrl: BASE_URL, pdfUrl: PDF_URL,
    timestamp: new Date().toISOString(),
    method: 'setTimeout(0)→RAF probe every 50ms for 8s during PDF rendering + keyboard interactions',
  }}, null, 2));
  console.log(`\n결과 저장: ${outFile}`);
}

main().catch((e) => {
  console.error('벤치마크 오류:', e);
  process.exit(1);
});
