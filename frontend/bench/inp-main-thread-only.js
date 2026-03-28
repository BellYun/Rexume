#!/usr/bin/env node
/**
 * INP 측정 — 메인스레드 렌더링 버전만 (Worker 제외)
 *
 * Basic / Simple / Optimized / Opt14 비교
 * Probe (setTimeout→RAF) 방식으로 인터랙션 응답성 측정
 *
 * 사용: node bench/inp-main-thread-only.js
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
    window.__d = {
      longTasks: [],
      fcpTime: null,
      probes: [],
      frames: [],
    };

    if (!window.PerformanceObserver) return;

    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          window.__d.longTasks.push({ start: e.startTime, dur: e.duration });
        }
      }).observe({ type: 'longtask', buffered: true });
    } catch (_) {}

    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.name === 'first-contentful-paint') window.__d.fcpTime = e.startTime;
        }
      }).observe({ type: 'paint', buffered: true });
    } catch (_) {}

    // Probe: 30ms 간격, 12초간
    const probeStart = performance.now();
    function runProbe() {
      if (performance.now() - probeStart > 12000) return;
      const t0 = performance.now();
      setTimeout(() => {
        const t1 = performance.now();
        requestAnimationFrame(() => {
          const t2 = performance.now();
          // Long Task와 겹치는지 확인
          const overlapping = window.__d.longTasks.some(
            (lt) => lt.start <= t1 && lt.start + lt.dur >= t0
          );
          window.__d.probes.push({
            t0, t1, t2,
            timeoutDelay: Math.round((t1 - t0) * 10) / 10,
            rafDelay: Math.round((t2 - t1) * 10) / 10,
            total: Math.round((t2 - t0) * 10) / 10,
            duringLT: overlapping,
          });
          setTimeout(runProbe, 30);
        });
      }, 0);
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', runProbe);
    } else {
      runProbe();
    }

    // 프레임 타이밍
    let lastFrame = 0, frameStart = 0;
    function trackFrame(ts) {
      if (!frameStart) frameStart = ts;
      if (ts - frameStart > 12000) return;
      if (lastFrame > 0) {
        window.__d.frames.push({ delta: ts - lastFrame });
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

  await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 200));

  // 12초간 ArrowDown + Click 인터랙션
  const start = Date.now();
  let count = 0;
  while (Date.now() - start < 12000) {
    if (count % 3 === 0) {
      // Click
      const y = 300 + (count % 5) * 100;
      await client.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: 960, y, button: 'left', clickCount: 1,
      });
      await new Promise((r) => setTimeout(r, 20));
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: 960, y, button: 'left', clickCount: 1,
      });
    } else {
      // ArrowDown
      await client.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown', key: 'ArrowDown', code: 'ArrowDown',
        windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40,
      });
      await new Promise((r) => setTimeout(r, 20));
      await client.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown',
        windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40,
      });
    }
    count++;
    await new Promise((r) => setTimeout(r, 150));
  }

  await new Promise((r) => setTimeout(r, 2000));

  const result = await page.evaluate(() => {
    const d = window.__d;
    const probes = d.probes;
    const duringLT = probes.filter((p) => p.duringLT);
    const duringIdle = probes.filter((p) => !p.duringLT);
    const frames = d.frames;

    const calcStats = (arr) => {
      if (!arr.length) return { avg: 0, min: 0, max: 0, med: 0, p75: 0, p95: 0, p99: 0 };
      const s = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return {
        count: s.length,
        avg: Math.round(s.reduce((a, b) => a + b, 0) / s.length * 10) / 10,
        min: Math.round(s[0] * 10) / 10,
        max: Math.round(s[s.length - 1] * 10) / 10,
        med: Math.round((s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2) * 10) / 10,
        p75: Math.round((s[Math.floor(s.length * 0.75)] || s[s.length - 1]) * 10) / 10,
        p95: Math.round((s[Math.floor(s.length * 0.95)] || s[s.length - 1]) * 10) / 10,
        p99: Math.round((s[Math.floor(s.length * 0.99)] || s[s.length - 1]) * 10) / 10,
      };
    };

    const fcp = d.fcpTime || 0;
    const tbt = d.longTasks
      .filter((t) => fcp > 0 && t.start + t.dur > fcp)
      .reduce((sum, t) => sum + Math.max(0, t.dur - 50), 0);

    const deltas = frames.map((f) => f.delta);
    const jankFrames = frames.filter((f) => f.delta > 50);
    const severeFrames = frames.filter((f) => f.delta > 100);

    return {
      // 전체 Probe
      probe: calcStats(probes.map((p) => p.total)),
      probeTimeout: calcStats(probes.map((p) => p.timeoutDelay)),
      probeRaf: calcStats(probes.map((p) => p.rafDelay)),
      // LT 중 Probe
      ltProbe: calcStats(duringLT.map((p) => p.total)),
      ltProbeCount: duringLT.length,
      // 유휴 Probe
      idleProbe: calcStats(duringIdle.map((p) => p.total)),
      idleProbeCount: duringIdle.length,
      ltRatio: probes.length > 0 ? Math.round(duringLT.length / probes.length * 1000) / 10 : 0,
      // TBT
      tbt: Math.round(tbt),
      longTaskCount: d.longTasks.length,
      ltDur: calcStats(d.longTasks.map((t) => t.dur)),
      // 프레임
      totalFrames: frames.length,
      avgFPS: deltas.length > 0 ? Math.round(1000 / (deltas.reduce((a, b) => a + b, 0) / deltas.length) * 10) / 10 : 0,
      frameDelta: calcStats(deltas),
      jankRate: frames.length > 0 ? Math.round(jankFrames.length / frames.length * 1000) / 10 : 0,
      severeJankRate: frames.length > 0 ? Math.round(severeFrames.length / frames.length * 1000) / 10 : 0,
    };
  });

  await browser.close();

  console.log(
    `probe: med=${result.probe.med}ms p75=${result.probe.p75}ms p95=${result.probe.p95}ms | LT중=${result.ltProbe.med}ms(${result.ltRatio}%) | jank=${result.jankRate}% | TBT=${result.tbt}ms`
  );

  return { ...result, version: versionName, run };
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
  const SEP = '═'.repeat(115);
  const baseP75 = summaries[0]?.probeP75.median || 1;

  console.log(`\n${SEP}`);
  console.log(` INP (메인스레드 렌더링만)  [CPU ${CPU_THROTTLE}x · ${RUNS}회 · 12초간 probe 30ms간격]`);
  console.log(`${SEP}`);

  console.log('\n[1] Probe 응답 시간 (setTimeout→RAF) — 낮을수록 인터랙션 반응 빠름');
  console.log(
    `${'버전'.padEnd(28)} ${'med'.padStart(8)} ${'p75'.padStart(8)} ${'p95'.padStart(8)} ${'p99'.padStart(8)} ${'max'.padStart(8)} ${'vs basic'.padStart(10)} ${'probes'.padStart(8)}`
  );
  console.log(`${'─'.repeat(28)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(8)}`);
  for (const s of summaries) {
    const diff = s.probeP75.median - baseP75;
    const pct = baseP75 > 0 ? Math.round(diff / baseP75 * 100) : 0;
    const sign = s.shortName === 'basic' ? '  (base)' : diff < 0 ? `↓${Math.abs(pct)}%` : diff > 0 ? `↑${pct}%` : '  =';
    console.log(
      `${s.version.padEnd(28)} ${(s.probeMed.median + 'ms').padStart(8)} ${(s.probeP75.median + 'ms').padStart(8)} ${(s.probeP95.median + 'ms').padStart(8)} ${(s.probeP99.median + 'ms').padStart(8)} ${(s.probeMax.median + 'ms').padStart(8)} ${sign.padStart(10)} ${String(s.probeCount.median).padStart(8)}`
    );
  }

  console.log('\n[2] Long Task 중 Probe vs 유휴 시 Probe');
  console.log(
    `${'버전'.padEnd(28)} ${'LT중 med'.padStart(10)} ${'LT중 p75'.padStart(10)} ${'LT중 max'.padStart(10)} ${'유휴 med'.padStart(10)} ${'유휴 p75'.padStart(10)} ${'LT중 비율'.padStart(10)} ${'LT중 수'.padStart(8)}`
  );
  console.log(`${'─'.repeat(28)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(8)}`);
  for (const s of summaries) {
    console.log(
      `${s.version.padEnd(28)} ${(s.ltProbeMed.median + 'ms').padStart(10)} ${(s.ltProbeP75.median + 'ms').padStart(10)} ${(s.ltProbeMax.median + 'ms').padStart(10)} ${(s.idleProbeMed.median + 'ms').padStart(10)} ${(s.idleProbeP75.median + 'ms').padStart(10)} ${(s.ltRatio.median + '%').padStart(10)} ${String(s.ltProbeCount.median).padStart(8)}`
    );
  }

  console.log('\n[3] 프레임 안정성');
  console.log(
    `${'버전'.padEnd(28)} ${'avgFPS'.padStart(8)} ${'jank%'.padStart(8)} ${'severe%'.padStart(9)} ${'delta p95'.padStart(11)}`
  );
  console.log(`${'─'.repeat(28)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(9)} ${'─'.repeat(11)}`);
  for (const s of summaries) {
    console.log(
      `${s.version.padEnd(28)} ${String(s.avgFPS.median).padStart(8)} ${(s.jankRate.median + '%').padStart(8)} ${(s.severeJank.median + '%').padStart(9)} ${(s.frameDeltaP95.median + 'ms').padStart(11)}`
    );
  }

  console.log('\n[4] TBT & Long Tasks');
  console.log(
    `${'버전'.padEnd(28)} ${'TBT'.padStart(8)} ${'LT수'.padStart(6)} ${'LT avg'.padStart(8)} ${'LT max'.padStart(8)}`
  );
  console.log(`${'─'.repeat(28)} ${'─'.repeat(8)} ${'─'.repeat(6)} ${'─'.repeat(8)} ${'─'.repeat(8)}`);
  for (const s of summaries) {
    console.log(
      `${s.version.padEnd(28)} ${(s.tbt.median + 'ms').padStart(8)} ${String(s.ltCount.median).padStart(6)} ${(s.ltAvg.median + 'ms').padStart(8)} ${(s.ltMax.median + 'ms').padStart(8)}`
    );
  }

  console.log(`\n${SEP}`);
}

async function main() {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(` INP 측정 (메인스레드 렌더링만 — Worker 제외)`);
  console.log(` CPU ${CPU_THROTTLE}x · ${RUNS}회 · 12초 probe(30ms) + interactions`);
  console.log(` Basic / Simple / Optimized / Opt14`);
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
      probeMed: stats(runs.map((r) => r.probe.med)),
      probeP75: stats(runs.map((r) => r.probe.p75)),
      probeP95: stats(runs.map((r) => r.probe.p95)),
      probeP99: stats(runs.map((r) => r.probe.p99)),
      probeMax: stats(runs.map((r) => r.probe.max)),
      probeCount: stats(runs.map((r) => r.probe.count)),
      ltProbeMed: stats(runs.map((r) => r.ltProbe.med)),
      ltProbeP75: stats(runs.map((r) => r.ltProbe.p75)),
      ltProbeMax: stats(runs.map((r) => r.ltProbe.max)),
      ltProbeCount: stats(runs.map((r) => r.ltProbeCount)),
      idleProbeMed: stats(runs.map((r) => r.idleProbe.med)),
      idleProbeP75: stats(runs.map((r) => r.idleProbe.p75)),
      ltRatio: stats(runs.map((r) => r.ltRatio)),
      tbt: stats(runs.map((r) => r.tbt)),
      ltCount: stats(runs.map((r) => r.longTaskCount)),
      ltAvg: stats(runs.map((r) => r.ltDur.avg)),
      ltMax: stats(runs.map((r) => r.ltDur.max)),
      avgFPS: stats(runs.map((r) => r.avgFPS)),
      jankRate: stats(runs.map((r) => r.jankRate)),
      severeJank: stats(runs.map((r) => r.severeJankRate)),
      frameDeltaP95: stats(runs.map((r) => r.frameDelta.p95)),
      runs: runs.length,
    };
  });

  printTable(summaries);

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `inp-main-thread-${ts}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ summaries, allResults, meta: {
    runs: RUNS, cpuThrottle: CPU_THROTTLE, baseUrl: BASE_URL, pdfUrl: PDF_URL,
    timestamp: new Date().toISOString(),
    versions: 'Basic, Simple(IO), Optimized(IO+RAF+Limit), Opt14(IO+RAF+Cache)',
    method: 'setTimeout(0)→RAF probe every 30ms for 12s + keyboard/click interactions',
  }}, null, 2));
  console.log(`\n결과 저장: ${outFile}`);
}

main().catch((e) => {
  console.error('벤치마크 오류:', e);
  process.exit(1);
});
