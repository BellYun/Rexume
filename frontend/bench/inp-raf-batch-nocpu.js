#!/usr/bin/env node
/**
 * 프레임 일관성 — CPU 쓰로틀링 없이 실환경 측정
 *
 * CPU_THROTTLE=1 (쓰로틀 없음) 에서 프레임 안정성 지표 비교
 * Simple(IO) / IO+RAF(NoLimit) / IO+RAF+Batch
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const RUNS = Number(process.env.RUNS || 5);
const CPU_THROTTLE = Number(process.env.CPU_THROTTLE || 1);
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const PDF_URL = process.env.PDF_URL || '/sample4.pdf';

const TEST_URLS = [
  { url: `${BASE_URL}/pdf-bench/simple?url=${PDF_URL}`, name: 'Simple (IO)', shortName: 'simple' },
  { url: `${BASE_URL}/pdf-bench/optimized-nolimit?url=${PDF_URL}`, name: 'IO+RAF (NoLimit)', shortName: 'raf-nolimit' },
  { url: `${BASE_URL}/pdf-bench/raf-batch?url=${PDF_URL}`, name: 'IO+RAF+Batch', shortName: 'raf-batch' },
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
  if (CPU_THROTTLE > 1) {
    await client.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
  }

  await page.evaluateOnNewDocument(() => {
    window.__d = { longTasks: [], fcpTime: null, probes: [], frames: [] };
    if (!window.PerformanceObserver) return;
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__d.longTasks.push({ start: e.startTime, dur: e.duration });
      }).observe({ type: 'longtask', buffered: true });
    } catch (_) {}
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') window.__d.fcpTime = e.startTime;
      }).observe({ type: 'paint', buffered: true });
    } catch (_) {}

    const s = performance.now();
    function probe() {
      if (performance.now() - s > 12000) return;
      const t0 = performance.now();
      setTimeout(() => {
        const t1 = performance.now();
        requestAnimationFrame(() => {
          const t2 = performance.now();
          const overlapping = window.__d.longTasks.some(lt => lt.start <= t1 && lt.start + lt.dur >= t0);
          window.__d.probes.push({
            timeoutDelay: Math.round((t1-t0)*10)/10,
            rafDelay: Math.round((t2-t1)*10)/10,
            total: Math.round((t2-t0)*10)/10,
            duringLT: overlapping,
          });
          setTimeout(probe, 30);
        });
      }, 0);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', probe);
    else probe();

    let last = 0, fs2 = 0;
    function tf(ts) {
      if (!fs2) fs2 = ts;
      if (ts - fs2 > 12000) return;
      if (last > 0) window.__d.frames.push({ delta: ts - last });
      last = ts;
      requestAnimationFrame(tf);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(tf));
    else requestAnimationFrame(tf);
  });

  await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise(r => setTimeout(r, 200));

  const start = Date.now();
  let count = 0;
  while (Date.now() - start < 12000) {
    if (count % 3 === 0) {
      await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 960, y: 300+(count%5)*100, button: 'left', clickCount: 1 });
      await new Promise(r => setTimeout(r, 20));
      await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 960, y: 300+(count%5)*100, button: 'left', clickCount: 1 });
    } else {
      await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 });
      await new Promise(r => setTimeout(r, 20));
      await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 });
    }
    count++;
    await new Promise(r => setTimeout(r, 150));
  }

  await new Promise(r => setTimeout(r, 2000));

  const result = await page.evaluate(() => {
    const d = window.__d;
    const probes = d.probes;
    const frames = d.frames;

    const cs = (arr) => {
      if (!arr.length) return { avg:0,min:0,max:0,med:0,p75:0,p95:0,p99:0,count:0 };
      const s=[...arr].sort((a,b)=>a-b), mid=Math.floor(s.length/2);
      return {
        count:s.length,
        avg:Math.round(s.reduce((a,b)=>a+b,0)/s.length*10)/10,
        min:Math.round(s[0]*10)/10, max:Math.round(s[s.length-1]*10)/10,
        med:Math.round((s.length%2?s[mid]:(s[mid-1]+s[mid])/2)*10)/10,
        p75:Math.round((s[Math.floor(s.length*0.75)]||s[s.length-1])*10)/10,
        p95:Math.round((s[Math.floor(s.length*0.95)]||s[s.length-1])*10)/10,
        p99:Math.round((s[Math.floor(s.length*0.99)]||s[s.length-1])*10)/10,
      };
    };

    const fcp = d.fcpTime||0;
    const tbt = d.longTasks.filter(t=>fcp>0&&t.start+t.dur>fcp).reduce((s,t)=>s+Math.max(0,t.dur-50),0);
    const deltas = frames.map(f=>f.delta);
    const jank = frames.filter(f=>f.delta>50);
    const severe = frames.filter(f=>f.delta>100);

    return {
      probe: cs(probes.map(p=>p.total)),
      tbt: Math.round(tbt),
      longTaskCount: d.longTasks.length,
      ltDur: cs(d.longTasks.map(t=>t.dur)),
      totalFrames: frames.length,
      avgFPS: deltas.length>0?Math.round(1000/(deltas.reduce((a,b)=>a+b,0)/deltas.length)*10)/10:0,
      frameDelta: cs(deltas),
      jankRate: frames.length>0?Math.round(jank.length/frames.length*1000)/10:0,
      severeJankRate: frames.length>0?Math.round(severe.length/frames.length*1000)/10:0,
    };
  });

  await browser.close();

  console.log(
    `probe p75=${result.probe.p75}ms | delta p95=${result.frameDelta.p95}ms | jank=${result.jankRate}% | FPS=${result.avgFPS} | TBT=${result.tbt}ms`
  );
  return { ...result, version: versionName, run };
}

function stats(arr) {
  if (!arr.length) return { avg:0,min:0,max:0,median:0 };
  const s=[...arr].sort((a,b)=>a-b), mid=Math.floor(s.length/2);
  return {
    avg:Math.round(arr.reduce((a,b)=>a+b,0)/arr.length*10)/10,
    min:Math.round(s[0]*10)/10, max:Math.round(s[s.length-1]*10)/10,
    median:Math.round((s.length%2?s[mid]:(s[mid-1]+s[mid])/2)*10)/10,
  };
}

function printTable(summaries) {
  const SEP = '═'.repeat(100);

  console.log(`\n${SEP}`);
  console.log(` 프레임 일관성 — CPU 쓰로틀 없음 (실환경)  [${RUNS}회 · 12초]`);
  console.log(`${SEP}`);

  console.log('\n[1] 프레임 안정성 (핵심 지표)');
  console.log(`${'버전'.padEnd(26)} ${'avgFPS'.padStart(8)} ${'jank%'.padStart(8)} ${'severe%'.padStart(9)} ${'delta med'.padStart(11)} ${'delta p95'.padStart(11)} ${'delta p99'.padStart(11)} ${'delta max'.padStart(11)}`);
  console.log(`${'─'.repeat(26)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(9)} ${'─'.repeat(11)} ${'─'.repeat(11)} ${'─'.repeat(11)} ${'─'.repeat(11)}`);
  for (const s of summaries) {
    console.log(`${s.version.padEnd(26)} ${String(s.avgFPS.median).padStart(8)} ${(s.jankRate.median+'%').padStart(8)} ${(s.severeJank.median+'%').padStart(9)} ${(s.frameDeltaMed.median+'ms').padStart(11)} ${(s.frameDeltaP95.median+'ms').padStart(11)} ${(s.frameDeltaP99.median+'ms').padStart(11)} ${(s.frameDeltaMax.median+'ms').padStart(11)}`);
  }

  console.log('\n[2] Probe 응답 시간');
  console.log(`${'버전'.padEnd(26)} ${'med'.padStart(8)} ${'p75'.padStart(8)} ${'p95'.padStart(9)}`);
  console.log(`${'─'.repeat(26)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(9)}`);
  for (const s of summaries) {
    console.log(`${s.version.padEnd(26)} ${(s.probeMed.median+'ms').padStart(8)} ${(s.probeP75.median+'ms').padStart(8)} ${(s.probeP95.median+'ms').padStart(9)}`);
  }

  console.log('\n[3] TBT & Long Tasks');
  console.log(`${'버전'.padEnd(26)} ${'TBT'.padStart(8)} ${'LT수'.padStart(6)} ${'LT avg'.padStart(8)} ${'LT max'.padStart(8)}`);
  console.log(`${'─'.repeat(26)} ${'─'.repeat(8)} ${'─'.repeat(6)} ${'─'.repeat(8)} ${'─'.repeat(8)}`);
  for (const s of summaries) {
    console.log(`${s.version.padEnd(26)} ${(s.tbt.median+'ms').padStart(8)} ${String(s.ltCount.median).padStart(6)} ${(s.ltAvg.median+'ms').padStart(8)} ${(s.ltMax.median+'ms').padStart(8)}`);
  }
  console.log(`\n${SEP}`);
}

async function main() {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(` 프레임 일관성 — CPU 쓰로틀 없음 (실환경)`);
  console.log(` ${RUNS}회 · Simple(IO) / IO+RAF / IO+RAF+Batch`);
  console.log(`${'═'.repeat(70)}`);

  const allResults = {};
  for (const target of TEST_URLS) {
    console.log(`\n▶ ${target.name}`);
    allResults[target.shortName] = [];
    for (let r = 1; r <= RUNS; r++) {
      try {
        const result = await measure(target.url, target.name, r);
        allResults[target.shortName].push(result);
      } catch (e) { console.error(`  오류 (${r}회차): ${e.message}`); }
    }
  }

  const summaries = TEST_URLS.map(t => {
    const runs = allResults[t.shortName]||[];
    return {
      version: t.name, shortName: t.shortName,
      probeMed: stats(runs.map(r=>r.probe.med)),
      probeP75: stats(runs.map(r=>r.probe.p75)),
      probeP95: stats(runs.map(r=>r.probe.p95)),
      tbt: stats(runs.map(r=>r.tbt)),
      ltCount: stats(runs.map(r=>r.longTaskCount)),
      ltAvg: stats(runs.map(r=>r.ltDur.avg)),
      ltMax: stats(runs.map(r=>r.ltDur.max)),
      avgFPS: stats(runs.map(r=>r.avgFPS)),
      jankRate: stats(runs.map(r=>r.jankRate)),
      severeJank: stats(runs.map(r=>r.severeJankRate)),
      frameDeltaMed: stats(runs.map(r=>r.frameDelta.med)),
      frameDeltaP95: stats(runs.map(r=>r.frameDelta.p95)),
      frameDeltaP99: stats(runs.map(r=>r.frameDelta.p99)),
      frameDeltaMax: stats(runs.map(r=>r.frameDelta.max)),
      runs: runs.length,
    };
  });

  printTable(summaries);

  const ts = new Date().toISOString().replace(/[:.]/g,'-');
  const outFile = path.join(outDir, `inp-raf-batch-nocpu-${ts}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ summaries, allResults, meta: {
    runs:RUNS, cpuThrottle:CPU_THROTTLE, baseUrl:BASE_URL, pdfUrl:PDF_URL,
    timestamp:new Date().toISOString(),
    versions:'Simple(IO) / IO+RAF(NoLimit) / IO+RAF+Batch',
    note: 'No CPU throttling — real device performance',
  }}, null, 2));
  console.log(`\n결과 저장: ${outFile}`);
}

main().catch(e => { console.error('오류:', e); process.exit(1); });
