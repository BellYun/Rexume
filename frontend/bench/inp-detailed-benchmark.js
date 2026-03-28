#!/usr/bin/env node
/**
 * INP 상세 벤치마크 — 렌더링 진행 중 인터랙션 응답성 측정
 *
 * 개선 사항:
 *   - CDP Input.dispatchKeyEvent/MouseEvent로 실제 인터랙션 생성
 *   - 페이지 로드 직후 (렌더링 진행 중) 인터랙션 시작
 *   - RAF 기반 프레임 타이밍 직접 측정
 *   - 키보드(Space/ArrowDown) + 포인터(click) + 휠 복합 인터랙션
 *   - 프레임 드롭률, 평균 프레임 시간 측정
 *
 * 사용:
 *   node bench/inp-detailed-benchmark.js
 *
 * 환경변수:
 *   RUNS=3             반복 횟수 (기본 3)
 *   CPU_THROTTLE=4     CPU 스로틀 배율 (기본 4)
 *   BASE_URL=http://localhost:3000
 *   PDF_URL=/sample4.pdf
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
  { url: `${BASE_URL}/pdf-bench/opt15?url=${PDF_URL}`, name: 'Opt15 (Worker+RAF, Limit=3)', shortName: 'opt15' },
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

  // ── 메트릭 수집 스크립트 주입 ──
  await page.evaluateOnNewDocument(() => {
    window.__inp = {
      interactions: [],
      longTasks: [],
      frames: [],
      fcpTime: null,
      manualTimings: [],  // 수동 측정: 이벤트 발생 → RAF 콜백까지 시간
      rafStarted: false,
    };

    // Event Timing API
    if (window.PerformanceObserver) {
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            window.__inp.interactions.push({
              name: entry.name,
              startTime: entry.startTime,
              duration: entry.duration,
              processingStart: entry.processingStart,
              processingEnd: entry.processingEnd,
              interactionId: entry.interactionId || 0,
              inputDelay: entry.processingStart - entry.startTime,
              processingTime: entry.processingEnd - entry.processingStart,
              presentationDelay: entry.duration - (entry.processingEnd - entry.startTime),
            });
          }
        }).observe({ type: 'event', buffered: true, durationThreshold: 0 });

        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            window.__inp.longTasks.push({
              startTime: entry.startTime,
              duration: entry.duration,
            });
          }
        }).observe({ type: 'longtask', buffered: true });

        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.name === 'first-contentful-paint') {
              window.__inp.fcpTime = entry.startTime;
            }
          }
        }).observe({ type: 'paint', buffered: true });
      } catch (_) {}
    }

    // ── RAF 프레임 타이밍 측정 ──
    // 페이지 로드 후 8초간 매 프레임 시간을 기록
    let frameCount = 0;
    let lastFrameTime = 0;
    const MAX_FRAMES = 500;
    const DURATION_LIMIT = 8000;
    let startTime = 0;

    function trackFrames(timestamp) {
      if (!startTime) startTime = timestamp;
      if (timestamp - startTime > DURATION_LIMIT || frameCount > MAX_FRAMES) return;

      if (lastFrameTime > 0) {
        const delta = timestamp - lastFrameTime;
        window.__inp.frames.push({
          time: timestamp,
          delta: delta,
          dropped: delta > 33.34,  // 30fps 기준 드롭
          jank: delta > 50,        // 50ms 넘으면 jank
          severe: delta > 100,     // 100ms 넘으면 severe jank
        });
      }
      lastFrameTime = timestamp;
      frameCount++;
      requestAnimationFrame(trackFrames);
    }

    // DOM 준비 후 프레임 추적 시작
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(trackFrames));
    } else {
      requestAnimationFrame(trackFrames);
    }

    // ── 수동 Event→Paint 측정 ──
    // 이벤트 핸들러에서 시간 기록 → 다음 RAF에서 paint 시간 기록
    window.__measureEventToPaint = function(eventName) {
      const eventTime = performance.now();
      requestAnimationFrame(() => {
        const paintTime = performance.now();
        window.__inp.manualTimings.push({
          event: eventName,
          eventTime,
          paintTime,
          delay: paintTime - eventTime,
        });
      });
    };

    // 키보드/마우스 이벤트에 수동 측정 부착
    document.addEventListener('keydown', () => window.__measureEventToPaint('keydown'), { passive: true });
    document.addEventListener('pointerdown', () => window.__measureEventToPaint('pointerdown'), { passive: true });
    document.addEventListener('wheel', () => window.__measureEventToPaint('wheel'), { passive: true });
  });

  // ── 페이지 로드 (domcontentloaded로 빠르게) ──
  await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // 렌더링이 시작될 때까지 잠깐 대기
  await new Promise((r) => setTimeout(r, 500));

  // ── 렌더링 진행 중 인터랙션 수행 ──
  // Phase 1: 렌더링 초기 (0~2초) — 가장 무거운 구간
  for (let i = 0; i < 5; i++) {
    // 키보드: ArrowDown (스크롤 트리거)
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown',
      windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40,
    });
    await new Promise((r) => setTimeout(r, 50));
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown',
      windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40,
    });
    await new Promise((r) => setTimeout(r, 150));
  }

  // Phase 2: 렌더링 중반 (2~4초)
  for (let i = 0; i < 5; i++) {
    // 마우스 클릭
    await client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: 960, y: 400 + i * 80, button: 'left', clickCount: 1,
    });
    await new Promise((r) => setTimeout(r, 30));
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: 960, y: 400 + i * 80, button: 'left', clickCount: 1,
    });
    await new Promise((r) => setTimeout(r, 170));
  }

  // Phase 3: 스크롤 (4~6초)
  for (let i = 0; i < 8; i++) {
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: 960, y: 540, deltaX: 0, deltaY: 300,
    });
    await new Promise((r) => setTimeout(r, 200));
  }

  // Phase 4: 키보드 Space (6~7초)
  for (let i = 0; i < 4; i++) {
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: ' ', code: 'Space',
      windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32,
    });
    await new Promise((r) => setTimeout(r, 50));
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: ' ', code: 'Space',
      windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32,
    });
    await new Promise((r) => setTimeout(r, 200));
  }

  // 안정화 대기
  await new Promise((r) => setTimeout(r, 2000));

  // ── 결과 수집 ──
  const result = await page.evaluate(() => {
    const interactions = window.__inp.interactions;
    const longTasks = window.__inp.longTasks;
    const frames = window.__inp.frames;
    const manual = window.__inp.manualTimings;

    // === Event Timing 기반 INP ===
    // interactionId > 0 인 것만 (실제 인터랙션)
    const realInteractions = interactions.filter((i) => i.interactionId > 0);
    // interactionId별 최대 duration
    const grouped = {};
    for (const i of realInteractions) {
      if (!grouped[i.interactionId] || i.duration > grouped[i.interactionId].duration) {
        grouped[i.interactionId] = i;
      }
    }
    const unique = Object.values(grouped);
    const sortedByDur = [...unique].sort((a, b) => b.duration - a.duration);

    // INP = p98
    let inp = 0;
    if (sortedByDur.length > 0) {
      const idx = Math.max(0, Math.floor(sortedByDur.length * 0.02));
      inp = sortedByDur[idx]?.duration || 0;
    }

    // === 전체 이벤트 (interactionId 무관) duration 분석 ===
    const allDurations = interactions.map((i) => i.duration);
    const allInputDelays = interactions.map((i) => i.inputDelay);
    const allPresDelays = interactions.map((i) => i.presentationDelay);

    // === 수동 Event→Paint 타이밍 ===
    const manualDelays = manual.map((m) => m.delay);

    // === 프레임 타이밍 분석 ===
    const frameDeltas = frames.map((f) => f.delta);
    const droppedFrames = frames.filter((f) => f.dropped).length;
    const jankFrames = frames.filter((f) => f.jank).length;
    const severeJankFrames = frames.filter((f) => f.severe).length;
    const totalFrames = frames.length;
    const droppedRate = totalFrames > 0 ? (droppedFrames / totalFrames) * 100 : 0;
    const jankRate = totalFrames > 0 ? (jankFrames / totalFrames) * 100 : 0;

    // === TBT ===
    const fcp = window.__inp.fcpTime || 0;
    const tbt = longTasks
      .filter((t) => fcp > 0 && t.startTime + t.duration > fcp)
      .reduce((sum, t) => sum + Math.max(0, t.duration - 50), 0);

    const calcStats = (arr) => {
      if (!arr.length) return { avg: 0, min: 0, max: 0, median: 0, p75: 0, p95: 0, p99: 0 };
      const s = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return {
        avg: Math.round(s.reduce((a, b) => a + b, 0) / s.length * 10) / 10,
        min: Math.round(s[0] * 10) / 10,
        max: Math.round(s[s.length - 1] * 10) / 10,
        median: Math.round((s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2) * 10) / 10,
        p75: Math.round((s[Math.floor(s.length * 0.75)] || s[s.length - 1]) * 10) / 10,
        p95: Math.round((s[Math.floor(s.length * 0.95)] || s[s.length - 1]) * 10) / 10,
        p99: Math.round((s[Math.floor(s.length * 0.99)] || s[s.length - 1]) * 10) / 10,
      };
    };

    return {
      // INP (Event Timing)
      inp: Math.round(inp),
      realInteractionCount: unique.length,
      totalEventCount: interactions.length,

      // Event Timing 상세
      eventDuration: calcStats(allDurations),
      eventInputDelay: calcStats(allInputDelays),
      eventPresDelay: calcStats(allPresDelays),

      // 수동 Event→Paint
      manualCount: manual.length,
      manualDelay: calcStats(manualDelays),

      // 프레임 타이밍
      totalFrames,
      droppedFrames,
      jankFrames,
      severeJankFrames,
      droppedRate: Math.round(droppedRate * 10) / 10,
      jankRate: Math.round(jankRate * 10) / 10,
      frameDelta: calcStats(frameDeltas),
      avgFPS: frameDeltas.length > 0
        ? Math.round(1000 / (frameDeltas.reduce((a, b) => a + b, 0) / frameDeltas.length) * 10) / 10
        : 0,

      // TBT / LongTask
      tbt: Math.round(tbt),
      longTaskCount: longTasks.length,
      longTaskDurations: calcStats(longTasks.map((t) => t.duration)),

      // 상위 5 느린 이벤트
      slowest5: sortedByDur.slice(0, 5).map((i) => ({
        name: i.name,
        duration: Math.round(i.duration),
        inputDelay: Math.round(i.inputDelay),
        processingTime: Math.round(i.processingTime),
        presentationDelay: Math.round(i.presentationDelay),
      })),
    };
  });

  await browser.close();

  const rating = result.inp <= 200 ? 'GOOD' : result.inp <= 500 ? 'NEEDS' : 'POOR';
  console.log(
    `INP=${result.inp}ms(${rating}) events=${result.totalEventCount} manual.p75=${result.manualDelay.p75}ms fps=${result.avgFPS} jank=${result.jankRate}% TBT=${result.tbt}ms`
  );

  return { ...result, version: versionName, run, rating };
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
  const baseINP = summaries[0]?.inp.median || 1;
  const baseManual = summaries[0]?.manualP75.median || 1;
  const baseJank = summaries[0]?.jankRate.median || 1;

  console.log(`\n${SEP}`);
  console.log(` INP 상세 벤치마크  [CPU ${CPU_THROTTLE}x · ${RUNS}회]`);
  console.log(`${SEP}`);

  // 테이블 1: INP + Event Timing
  console.log('\n[1] INP & Event Timing');
  console.log(
    `${'버전'.padEnd(32)} ${'INP med'.padStart(9)} ${'vs basic'.padStart(10)} ${'eventDur p75'.padStart(14)} ${'inputDly p75'.padStart(14)} ${'presDly p75'.padStart(13)} ${'events'.padStart(8)}`
  );
  console.log(`${'─'.repeat(32)} ${'─'.repeat(9)} ${'─'.repeat(10)} ${'─'.repeat(14)} ${'─'.repeat(14)} ${'─'.repeat(13)} ${'─'.repeat(8)}`);
  for (const s of summaries) {
    const diff = s.inp.median - baseINP;
    const sign = s.shortName === 'basic' ? '  (base)' : diff < 0 ? `↓${Math.abs(Math.round(diff / baseINP * 100))}%` : diff > 0 ? `↑${Math.round(diff / baseINP * 100)}%` : '  =';
    console.log(
      `${s.version.padEnd(32)} ${(s.inp.median + 'ms').padStart(9)} ${sign.padStart(10)} ${(s.eventDurP75.median + 'ms').padStart(14)} ${(s.eventInputP75.median + 'ms').padStart(14)} ${(s.eventPresP75.median + 'ms').padStart(13)} ${String(s.totalEvents.median).padStart(8)}`
    );
  }

  // 테이블 2: 수동 Event→Paint
  console.log('\n[2] Event → Next Paint (수동 RAF 측정)');
  console.log(
    `${'버전'.padEnd(32)} ${'median'.padStart(9)} ${'p75'.padStart(9)} ${'p95'.padStart(9)} ${'max'.padStart(9)} ${'vs basic'.padStart(10)} ${'count'.padStart(7)}`
  );
  console.log(`${'─'.repeat(32)} ${'─'.repeat(9)} ${'─'.repeat(9)} ${'─'.repeat(9)} ${'─'.repeat(9)} ${'─'.repeat(10)} ${'─'.repeat(7)}`);
  for (const s of summaries) {
    const diff = s.manualP75.median - baseManual;
    const sign = s.shortName === 'basic' ? '  (base)' : diff < 0 ? `↓${Math.abs(Math.round(diff / baseManual * 100))}%` : diff > 0 ? `↑${Math.round(diff / baseManual * 100)}%` : '  =';
    console.log(
      `${s.version.padEnd(32)} ${(s.manualMed.median + 'ms').padStart(9)} ${(s.manualP75.median + 'ms').padStart(9)} ${(s.manualP95.median + 'ms').padStart(9)} ${(s.manualMax.median + 'ms').padStart(9)} ${sign.padStart(10)} ${String(s.manualCount.median).padStart(7)}`
    );
  }

  // 테이블 3: 프레임 안정성
  console.log('\n[3] 프레임 안정성 (RAF 기반)');
  console.log(
    `${'버전'.padEnd(32)} ${'avgFPS'.padStart(8)} ${'frameDelta'.padStart(12)} ${'jank%'.padStart(8)} ${'severe%'.padStart(9)} ${'dropped%'.padStart(10)} ${'vs basic'.padStart(10)}`
  );
  console.log(`${'─'.repeat(32)} ${'─'.repeat(8)} ${'─'.repeat(12)} ${'─'.repeat(8)} ${'─'.repeat(9)} ${'─'.repeat(10)} ${'─'.repeat(10)}`);
  for (const s of summaries) {
    const diff = s.jankRate.median - baseJank;
    const sign = s.shortName === 'basic' ? '  (base)' : diff < 0 ? `↓${Math.abs(Math.round(diff / baseJank * 100))}%` : diff > 0 ? `↑${Math.round(diff / baseJank * 100)}%` : '  =';
    console.log(
      `${s.version.padEnd(32)} ${(s.avgFPS.median + '').padStart(8)} ${(s.frameDeltaMed.median + 'ms').padStart(12)} ${(s.jankRate.median + '%').padStart(8)} ${(s.severeJank.median + '%').padStart(9)} ${(s.droppedRate.median + '%').padStart(10)} ${sign.padStart(10)}`
    );
  }

  // 테이블 4: TBT / LongTask
  console.log('\n[4] TBT & Long Tasks');
  console.log(
    `${'버전'.padEnd(32)} ${'TBT med'.padStart(9)} ${'LT 수'.padStart(7)} ${'LT avg'.padStart(9)} ${'LT max'.padStart(9)}`
  );
  console.log(`${'─'.repeat(32)} ${'─'.repeat(9)} ${'─'.repeat(7)} ${'─'.repeat(9)} ${'─'.repeat(9)}`);
  for (const s of summaries) {
    console.log(
      `${s.version.padEnd(32)} ${(s.tbt.median + 'ms').padStart(9)} ${String(s.longTaskCount.median).padStart(7)} ${(s.longTaskAvg.median + 'ms').padStart(9)} ${(s.longTaskMax.median + 'ms').padStart(9)}`
    );
  }

  console.log(`\n${SEP}`);
}

async function main() {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(` INP 상세 벤치마크`);
  console.log(` CPU ${CPU_THROTTLE}x · ${RUNS}회 · 22 interactions (key+click+wheel+space)`);
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
      inp: stats(runs.map((r) => r.inp)),
      totalEvents: stats(runs.map((r) => r.totalEventCount)),
      realInteractions: stats(runs.map((r) => r.realInteractionCount)),
      eventDurP75: stats(runs.map((r) => r.eventDuration.p75)),
      eventInputP75: stats(runs.map((r) => r.eventInputDelay.p75)),
      eventPresP75: stats(runs.map((r) => r.eventPresDelay.p75)),
      manualCount: stats(runs.map((r) => r.manualCount)),
      manualMed: stats(runs.map((r) => r.manualDelay.median)),
      manualP75: stats(runs.map((r) => r.manualDelay.p75)),
      manualP95: stats(runs.map((r) => r.manualDelay.p95)),
      manualMax: stats(runs.map((r) => r.manualDelay.max)),
      avgFPS: stats(runs.map((r) => r.avgFPS)),
      frameDeltaMed: stats(runs.map((r) => r.frameDelta.median)),
      jankRate: stats(runs.map((r) => r.jankRate)),
      severeJank: stats(runs.map((r) => runs.length > 0 ? Math.round(r.severeJankFrames / Math.max(r.totalFrames, 1) * 1000) / 10 : 0)),
      droppedRate: stats(runs.map((r) => r.droppedRate)),
      tbt: stats(runs.map((r) => r.tbt)),
      longTaskCount: stats(runs.map((r) => r.longTaskCount)),
      longTaskAvg: stats(runs.map((r) => r.longTaskDurations.avg)),
      longTaskMax: stats(runs.map((r) => r.longTaskDurations.max)),
      runs: runs.length,
    };
  });

  printTable(summaries);

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `inp-detailed-${ts}.json`);
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        summaries,
        allResults,
        meta: {
          runs: RUNS,
          cpuThrottle: CPU_THROTTLE,
          baseUrl: BASE_URL,
          pdfUrl: PDF_URL,
          timestamp: new Date().toISOString(),
          interactions: '5x ArrowDown + 5x click + 8x wheel + 4x Space = 22 interactions',
          metrics: [
            'INP (p98 of Event Timing interactionId durations)',
            'Event→Paint (manual RAF timing)',
            'Frame stability (RAF delta tracking, jank/dropped rates)',
            'TBT + Long Task analysis',
          ],
        },
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
