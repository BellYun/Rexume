#!/usr/bin/env node
/**
 * INP 정밀 측정 — CDP 이벤트 + Event Timing API
 *
 * 개선:
 *   - domcontentloaded 직후 인터랙션 시작 (렌더링 중 측정)
 *   - CDP dispatchKeyEvent로 확실한 keyboard interaction 생성
 *   - pointerdown/pointerup 페어로 pointer interaction 생성
 *   - 충분한 인터랙션 수 확보 (40+)
 *
 * 사용: node bench/inp-measure.js
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const RUNS = Number(process.env.RUNS || 5);
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

  const launchOptions = {
    headless: 'new',
    defaultViewport: { width: 1920, height: 1080 },
    args: ['--disable-dev-shm-usage', '--no-sandbox', '--crash-dumps-dir=/tmp'],
    protocolTimeout: 180000,
  };
  if (fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')) {
    launchOptions.executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }

  const browser = await puppeteer.launch(launchOptions);
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);

  const client = await page.target().createCDPSession();
  await client.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });

  await page.evaluateOnNewDocument(() => {
    window.__data = {
      eventTimings: [],
      longTasks: [],
      fcpTime: null,
      probes: [],
    };

    if (!window.PerformanceObserver) return;

    // Event Timing — duration만 정확히 수집
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          window.__data.eventTimings.push({
            name: e.name,
            iid: e.interactionId,
            start: e.startTime,
            dur: e.duration,
            pStart: e.processingStart,
            pEnd: e.processingEnd,
          });
        }
      }).observe({ type: 'event', buffered: true, durationThreshold: 0 });
    } catch (_) {}

    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          window.__data.longTasks.push({ start: e.startTime, dur: e.duration });
        }
      }).observe({ type: 'longtask', buffered: true });
    } catch (_) {}

    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.name === 'first-contentful-paint') window.__data.fcpTime = e.startTime;
        }
      }).observe({ type: 'paint', buffered: true });
    } catch (_) {}

    // Probe: setTimeout(0) → RAF 시간 측정 (50ms 간격, 10초)
    const probeStart = performance.now();
    function runProbe() {
      if (performance.now() - probeStart > 10000) return;
      const t0 = performance.now();
      setTimeout(() => {
        const t1 = performance.now();
        requestAnimationFrame(() => {
          const t2 = performance.now();
          window.__data.probes.push({
            scheduled: t0,
            timeoutDelay: Math.round((t1 - t0) * 10) / 10,
            rafDelay: Math.round((t2 - t1) * 10) / 10,
            total: Math.round((t2 - t0) * 10) / 10,
          });
          setTimeout(runProbe, 50);
        });
      }, 0);
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', runProbe);
    } else {
      runProbe();
    }
  });

  // domcontentloaded로 빨리 진입
  await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 200));

  // ── 렌더링 중 인터랙션 (10초간) ──
  const phases = [
    // Phase 1 (0~3s): ArrowDown 키 반복 — 스크롤 + keyboard interaction
    async () => {
      for (let i = 0; i < 15; i++) {
        await client.send('Input.dispatchKeyEvent', {
          type: 'rawKeyDown', key: 'ArrowDown', code: 'ArrowDown',
          windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40,
        });
        await new Promise((r) => setTimeout(r, 30));
        await client.send('Input.dispatchKeyEvent', {
          type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown',
          windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40,
        });
        await new Promise((r) => setTimeout(r, 170));
      }
    },
    // Phase 2 (3~6s): 클릭 — pointer interaction
    async () => {
      for (let i = 0; i < 10; i++) {
        const y = 300 + (i % 5) * 100;
        await client.send('Input.dispatchMouseEvent', {
          type: 'mousePressed', x: 960, y, button: 'left', clickCount: 1,
        });
        await new Promise((r) => setTimeout(r, 30));
        await client.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: 960, y, button: 'left', clickCount: 1,
        });
        await new Promise((r) => setTimeout(r, 270));
      }
    },
    // Phase 3 (6~9s): Tab키 — keyboard interaction
    async () => {
      for (let i = 0; i < 10; i++) {
        await client.send('Input.dispatchKeyEvent', {
          type: 'rawKeyDown', key: 'Tab', code: 'Tab',
          windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
        });
        await new Promise((r) => setTimeout(r, 30));
        await client.send('Input.dispatchKeyEvent', {
          type: 'keyUp', key: 'Tab', code: 'Tab',
          windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
        });
        await new Promise((r) => setTimeout(r, 270));
      }
    },
  ];

  for (const phase of phases) {
    await phase();
  }

  // 안정화
  await new Promise((r) => setTimeout(r, 2000));

  const result = await page.evaluate(() => {
    const d = window.__data;

    // Event Timing 기반 INP 계산
    // interactionId > 0 인 것 중 각 id별 max duration
    const withIid = d.eventTimings.filter((e) => e.iid > 0);
    const grouped = {};
    for (const e of withIid) {
      const dur = e.dur;
      if (!grouped[e.iid] || dur > grouped[e.iid]) {
        grouped[e.iid] = dur;
      }
    }
    const interactionDurations = Object.values(grouped).sort((a, b) => b - a);

    // INP = p98 (or worst if <50)
    let inp = 0;
    if (interactionDurations.length > 0) {
      const idx = Math.max(0, Math.floor(interactionDurations.length * 0.02));
      inp = interactionDurations[idx];
    }

    // 전체 이벤트 duration 분석 (interactionId 무관)
    const allDurs = d.eventTimings.map((e) => e.dur);
    const allInputDelays = d.eventTimings.map((e) => e.pStart - e.start);
    const allPresDelays = d.eventTimings.map((e) => e.dur - (e.pEnd - e.start));
    const allProcessing = d.eventTimings.map((e) => e.pEnd - e.pStart);

    // Probe 분석
    const probeTotals = d.probes.map((p) => p.total);
    const probeTimeouts = d.probes.map((p) => p.timeoutDelay);
    const probeRafs = d.probes.map((p) => p.rafDelay);

    // TBT
    const fcp = d.fcpTime || 0;
    const tbt = d.longTasks
      .filter((t) => fcp > 0 && t.start + t.dur > fcp)
      .reduce((sum, t) => sum + Math.max(0, t.dur - 50), 0);

    const calcStats = (arr) => {
      if (!arr.length) return { avg: 0, min: 0, max: 0, med: 0, p75: 0, p95: 0 };
      const s = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return {
        avg: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
        min: Math.round(s[0]),
        max: Math.round(s[s.length - 1]),
        med: Math.round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2),
        p75: Math.round(s[Math.floor(s.length * 0.75)] || s[s.length - 1]),
        p95: Math.round(s[Math.floor(s.length * 0.95)] || s[s.length - 1]),
      };
    };

    return {
      inp: Math.round(inp),
      interactionCount: interactionDurations.length,
      interactionDurations: calcStats(interactionDurations),
      totalEvents: d.eventTimings.length,
      eventDuration: calcStats(allDurs),
      inputDelay: calcStats(allInputDelays),
      processingTime: calcStats(allProcessing),
      presentationDelay: calcStats(allPresDelays),
      probe: calcStats(probeTotals),
      probeTimeout: calcStats(probeTimeouts),
      probeRaf: calcStats(probeRafs),
      probeCount: d.probes.length,
      tbt: Math.round(tbt),
      longTaskCount: d.longTasks.length,
      longTaskDur: calcStats(d.longTasks.map((t) => t.dur)),
    };
  });

  await browser.close();

  const rating = result.inp <= 200 ? 'GOOD' : result.inp <= 500 ? 'NEEDS' : 'POOR';
  console.log(
    `INP=${result.inp}ms(${rating}) iact=${result.interactionCount} events=${result.totalEvents} probe.p75=${result.probe.p75}ms TBT=${result.tbt}ms`
  );

  return { ...result, version: versionName, run, rating };
}

function stats(arr) {
  if (!arr.length) return { avg: 0, min: 0, max: 0, median: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    avg: Math.round(arr.reduce((a, b) => a + b, 0) / arr.length),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median: sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2),
  };
}

function printTable(summaries) {
  const SEP = '═'.repeat(125);
  const baseINP = summaries[0]?.inp.median || 1;

  console.log(`\n${SEP}`);
  console.log(` INP 측정 결과  [CPU ${CPU_THROTTLE}x · ${RUNS}회 · 35 interactions/run]`);
  console.log(`${SEP}`);

  // INP 메인 테이블
  console.log('\n[INP & Event Timing]');
  console.log(
    `${'버전'.padEnd(30)} ${'INP'.padStart(7)} ${'등급'.padStart(6)} ${'vs basic'.padStart(10)} ${'inputDly'.padStart(10)} ${'presDly'.padStart(9)} ${'processing'.padStart(12)} ${'interactions'.padStart(13)}`
  );
  console.log(`${'─'.repeat(30)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(9)} ${'─'.repeat(12)} ${'─'.repeat(13)}`);

  for (const s of summaries) {
    const diff = s.inp.median - baseINP;
    const pct = baseINP > 0 ? Math.round(diff / baseINP * 100) : 0;
    const sign = s.shortName === 'basic' ? '  (base)' : diff < 0 ? `↓${Math.abs(pct)}%` : diff > 0 ? `↑${pct}%` : '  =';
    const rating = s.inp.median <= 200 ? ' GOOD' : s.inp.median <= 500 ? 'NEEDS' : ' POOR';

    console.log(
      `${s.version.padEnd(30)} ${(s.inp.median + 'ms').padStart(7)} ${rating.padStart(6)} ${sign.padStart(10)} ${(s.inputDelay.median + 'ms').padStart(10)} ${(s.presDelay.median + 'ms').padStart(9)} ${(s.processing.median + 'ms').padStart(12)} ${String(s.interactions.median).padStart(13)}`
    );
  }

  // Probe 테이블
  console.log('\n[Probe 응답 (setTimeout→RAF)]');
  console.log(
    `${'버전'.padEnd(30)} ${'med'.padStart(7)} ${'p75'.padStart(7)} ${'p95'.padStart(7)} ${'max'.padStart(8)} ${'vs basic'.padStart(10)} ${'count'.padStart(7)}`
  );
  console.log(`${'─'.repeat(30)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(7)}`);
  const baseProbe = summaries[0]?.probeP75.median || 1;
  for (const s of summaries) {
    const diff = s.probeP75.median - baseProbe;
    const pct = baseProbe > 0 ? Math.round(diff / baseProbe * 100) : 0;
    const sign = s.shortName === 'basic' ? '  (base)' : diff < 0 ? `↓${Math.abs(pct)}%` : diff > 0 ? `↑${pct}%` : '  =';
    console.log(
      `${s.version.padEnd(30)} ${(s.probeMed.median + 'ms').padStart(7)} ${(s.probeP75.median + 'ms').padStart(7)} ${(s.probeP95.median + 'ms').padStart(7)} ${(s.probeMax.median + 'ms').padStart(8)} ${sign.padStart(10)} ${String(s.probeCount.median).padStart(7)}`
    );
  }

  // TBT 테이블
  console.log('\n[TBT & LongTask]');
  console.log(
    `${'버전'.padEnd(30)} ${'TBT'.padStart(8)} ${'LT수'.padStart(6)} ${'LT avg'.padStart(8)} ${'LT max'.padStart(8)}`
  );
  console.log(`${'─'.repeat(30)} ${'─'.repeat(8)} ${'─'.repeat(6)} ${'─'.repeat(8)} ${'─'.repeat(8)}`);
  for (const s of summaries) {
    console.log(
      `${s.version.padEnd(30)} ${(s.tbt.median + 'ms').padStart(8)} ${String(s.ltCount.median).padStart(6)} ${(s.ltAvg.median + 'ms').padStart(8)} ${(s.ltMax.median + 'ms').padStart(8)}`
    );
  }

  console.log(`\n${SEP}`);
  console.log('INP 등급: GOOD ≤200ms | NEEDS IMPROVEMENT ≤500ms | POOR >500ms');
}

async function main() {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(` INP 측정`);
  console.log(` CPU ${CPU_THROTTLE}x · ${RUNS}회 · 35 interactions (15 key + 10 click + 10 tab)`);
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
      interactions: stats(runs.map((r) => r.interactionCount)),
      events: stats(runs.map((r) => r.totalEvents)),
      inputDelay: stats(runs.map((r) => r.inputDelay.med)),
      presDelay: stats(runs.map((r) => r.presentationDelay.med)),
      processing: stats(runs.map((r) => r.processingTime.med)),
      probeMed: stats(runs.map((r) => r.probe.med)),
      probeP75: stats(runs.map((r) => r.probe.p75)),
      probeP95: stats(runs.map((r) => r.probe.p95)),
      probeMax: stats(runs.map((r) => r.probe.max)),
      probeCount: stats(runs.map((r) => r.probeCount)),
      tbt: stats(runs.map((r) => r.tbt)),
      ltCount: stats(runs.map((r) => r.longTaskCount)),
      ltAvg: stats(runs.map((r) => r.longTaskDur.avg)),
      ltMax: stats(runs.map((r) => r.longTaskDur.max)),
      runs: runs.length,
    };
  });

  printTable(summaries);

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `inp-measure-${ts}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ summaries, allResults, meta: {
    runs: RUNS, cpuThrottle: CPU_THROTTLE, baseUrl: BASE_URL, pdfUrl: PDF_URL,
    timestamp: new Date().toISOString(),
  }}, null, 2));
  console.log(`\n결과 저장: ${outFile}`);
}

main().catch((e) => {
  console.error('벤치마크 오류:', e);
  process.exit(1);
});
