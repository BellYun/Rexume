#!/usr/bin/env node
/**
 * feedback-basic vs feedback-raf vs feedback-optimized 성능 비교
 *
 * 측정 지표:
 *   - 초기 로드 LongTask 수 / 총 시간 / 최대 단일 태스크
 *   - TBT (Total Blocking Time, FCP 이후)
 *   - 최대 DOM 노드 수 (True Windowing 핵심 지표)
 *   - 최대 캔버스 수 (메모리 압박 지표)
 *   - 스크롤 중 LongTask (렌더 스케줄러 품질 지표)
 *   - FCP / 첫 캔버스 등장 시간
 *
 * 사용:
 *   node bench/bench-basic-vs-optimized.js
 */

const puppeteer = require('puppeteer');
const fs   = require('fs');
const path = require('path');

// ── 설정 ──────────────────────────────────────────────────────────────────────
const CPU_THROTTLE  = 4;    // 4× 스로틀링
const RUNS          = 3;    // URL 당 반복 횟수
const HEADLESS      = true;
const RESUME_ID     = 4;    // 테스트할 resume ID
const SCROLL_STEPS  = 15;   // 스크롤 단계 수
const SCROLL_STEP_PX = 2000; // 단계당 스크롤 픽셀 (PDF 페이지 높이 ≈ 1700px)
const SCROLL_DELAY  = 600;  // 단계 간 대기 ms
const SETTLE_MS     = 4000; // 초기 안정화 대기 ms

const TEST_URLS = [
  {
    url: `http://localhost:3000/feedback-basic/${RESUME_ID}`,
    name: 'Basic (개선 전)',
    shortName: 'basic',
  },
  {
    url: `http://localhost:3000/feedback-raf/${RESUME_ID}`,
    name: 'RAF + Scheduler',
    shortName: 'raf',
  },
  {
    url: `http://localhost:3000/feedback-optimized/${RESUME_ID}`,
    name: 'True Windowing (최적화)',
    shortName: 'optimized',
  },
];

const outDir = path.join(__dirname, 'results');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

// ── 단일 측정 ─────────────────────────────────────────────────────────────────
async function measure(testUrl, versionName, run) {
  console.log(`\n🔬 [${run}회차] ${versionName}`);
  console.log(`   ${testUrl}`);

  const browser = await puppeteer.launch({
    headless: HEADLESS ? 'new' : false,
    defaultViewport: { width: 1920, height: 1080 },
    args: ['--disable-dev-shm-usage', '--no-sandbox'],
    protocolTimeout: 180000,
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(180000);

  const client = await page.target().createCDPSession();
  await client.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });

  // ── 브라우저 내 측정 인프라 주입 ─────────────────────────────────────────────
  await page.evaluateOnNewDocument(() => {
    window.__bench = {
      longTasks:     [],
      paintEvents:   [],
      fcp:           null,
      firstCanvas:   null,
      domNodeSamples: [],  // 스크롤 중 DOM 노드 수 샘플
      canvasSamples:  [],  // 스크롤 중 캔버스 수 샘플
      scrollLongTasks: [], // 스크롤 시작 이후 LongTask
      scrollStarted:  false,
    };

    // LongTask
    try {
      new PerformanceObserver((list) => {
        list.getEntries().forEach(e => {
          const rec = { start: e.startTime, dur: e.duration };
          window.__bench.longTasks.push(rec);
          if (window.__bench.scrollStarted) {
            window.__bench.scrollLongTasks.push(rec);
          }
        });
      }).observe({ type: 'longtask', buffered: true });
    } catch (_) {}

    // Paint
    try {
      new PerformanceObserver((list) => {
        list.getEntries().forEach(e => {
          window.__bench.paintEvents.push({ name: e.name, start: e.startTime });
          if (e.name === 'first-contentful-paint') window.__bench.fcp = e.startTime;
        });
      }).observe({ type: 'paint', buffered: true });
    } catch (_) {}

    // Canvas 최초 등장: document.createElement 감시
    const _origCreate = document.createElement.bind(document);
    document.createElement = function(tag) {
      const el = _origCreate(tag);
      if (tag.toLowerCase() === 'canvas' && window.__bench.firstCanvas === null) {
        window.__bench.firstCanvas = performance.now();
      }
      return el;
    };
  });

  // ── 페이지 이동 ───────────────────────────────────────────────────────────────
  const navStart = Date.now();
  await page.goto(testUrl, { waitUntil: 'networkidle2', timeout: 120000 });
  const loadTime = Date.now() - navStart;
  console.log(`   로드 완료 ${loadTime}ms`);

  // ── PDF 첫 캔버스 등장 대기 (최대 30초) ──────────────────────────────────────
  try {
    await page.waitForFunction(
      () => document.querySelector('canvas') !== null ||
            window.__bench.firstCanvas !== null,
      { timeout: 30000 }
    );
    console.log('   첫 캔버스 감지');
  } catch (_) {
    console.warn('   캔버스 미감지 (에러 상태일 수 있음)');
  }

  // ── 초기 안정화 대기 ──────────────────────────────────────────────────────────
  await new Promise(r => setTimeout(r, SETTLE_MS));

  // 안정화 후 초기 DOM 스냅샷
  const snapInit = await page.evaluate(() => ({
    domNodes: document.querySelectorAll('*').length,
    canvases: document.querySelectorAll('canvas').length,
  }));
  console.log(`   초기 DOM: ${snapInit.domNodes}노드, canvas: ${snapInit.canvases}개`);

  // ── 스크롤 테스트 ─────────────────────────────────────────────────────────────
  await page.evaluate(() => { window.__bench.scrollStarted = true; });
  console.log(`   스크롤 시작 (${SCROLL_STEPS}단계 × ${SCROLL_STEP_PX}px)`);

  for (let i = 1; i <= SCROLL_STEPS; i++) {
    const scrollPx = i * SCROLL_STEP_PX;
    await page.evaluate((px) => {
      // True Windowing 버전은 컨테이너 스크롤, 나머지는 window 스크롤 시도
      const container = document.querySelector('[data-testid="pdf-scroll-container"]');
      if (container) {
        container.scrollTop = px;
      } else {
        window.scrollTo(0, px);
        // 페이지 내 scroll 가능한 div도 함께 스크롤 시도
        const divs = document.querySelectorAll('div[style*="overflow"]');
        divs.forEach(d => { if (d.scrollHeight > d.clientHeight) d.scrollTop = px; });
      }
    }, scrollPx);

    await new Promise(r => setTimeout(r, SCROLL_DELAY));

    // 스크롤 중 DOM 노드 / 캔버스 수 샘플링
    const snap = await page.evaluate((step) => ({
      step,
      scrollPx: step * 2000,
      domNodes: document.querySelectorAll('*').length,
      canvases: document.querySelectorAll('canvas').length,
    }), i);
    await page.evaluate((s) => {
      window.__bench.domNodeSamples.push(s.domNodes);
      window.__bench.canvasSamples.push(s.canvases);
    }, snap);

    if (i % 5 === 0) {
      console.log(`   step ${i}: DOM ${snap.domNodes}노드, canvas ${snap.canvases}개`);
    }
  }

  // 스크롤 안정화
  await new Promise(r => setTimeout(r, 2000));

  // ── 최종 메트릭 수집 ──────────────────────────────────────────────────────────
  const metrics = await page.evaluate((fcpMs) => {
    const b = window.__bench;
    const now = performance.now();

    // TBT: FCP 이후 LongTask 중 50ms 초과 부분 합산
    const fcp = b.fcp || fcpMs || 0;
    const tbt = b.longTasks
      .filter(t => t.start + t.dur > fcp)
      .reduce((s, t) => s + Math.max(0, t.dur - 50), 0);

    const ltDurations = b.longTasks.map(t => t.dur);
    const sltDurations = b.scrollLongTasks.map(t => t.dur);

    return {
      fcp:               b.fcp,
      firstCanvas:       b.firstCanvas,
      tbt:               tbt,
      ltCount:           b.longTasks.length,
      ltTotalMs:         ltDurations.reduce((a, v) => a + v, 0),
      ltMaxMs:           ltDurations.length ? Math.max(...ltDurations) : 0,
      scrollLtCount:     b.scrollLongTasks.length,
      scrollLtTotalMs:   sltDurations.reduce((a, v) => a + v, 0),
      scrollLtMaxMs:     sltDurations.length ? Math.max(...sltDurations) : 0,
      domNodesMax:       b.domNodeSamples.length ? Math.max(...b.domNodeSamples) : 0,
      domNodesMin:       b.domNodeSamples.length ? Math.min(...b.domNodeSamples) : 0,
      domNodesSamples:   b.domNodeSamples,
      canvasMax:         b.canvasSamples.length ? Math.max(...b.canvasSamples) : 0,
      canvasFinal:       document.querySelectorAll('canvas').length,
      domNodesFinal:     document.querySelectorAll('*').length,
      measureMs:         now,
    };
  }, snapInit.domNodes);

  await browser.close();

  return { version: versionName, url: testUrl, run, loadTime, ...metrics };
}

// ── 통계 헬퍼 ────────────────────────────────────────────────────────────────
function avg(arr) { return arr.length ? arr.reduce((a, v) => a + v, 0) / arr.length : 0; }
function fmt(n, d = 1) { return (n ?? 0).toFixed(d); }

// ── 메인 ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n🚀 feedback-basic vs feedback-raf vs feedback-optimized 벤치마크');
  console.log(`   CPU ${CPU_THROTTLE}× 스로틀 | ${RUNS}회 반복 | 스크롤 ${SCROLL_STEPS}단계`);
  console.log('='.repeat(80));

  const allResults = {};

  for (const { url, name, shortName } of TEST_URLS) {
    console.log(`\n${'#'.repeat(80)}`);
    console.log(`### ${name}  (${url})`);
    const runs = [];

    for (let r = 1; r <= RUNS; r++) {
      try {
        const res = await measure(url, name, r);
        runs.push(res);
        // 실행 간 대기
        if (r < RUNS) await new Promise(res => setTimeout(res, 3000));
      } catch (e) {
        console.error(`  ❌ ${r}회차 실패: ${e.message}`);
      }
    }

    allResults[shortName] = { name, runs };

    if (runs.length) {
      console.log(`\n  ─ ${name} (${runs.length}회 평균) ─`);
      console.log(`  LongTask: ${fmt(avg(runs.map(r => r.ltCount)))}개  총 ${fmt(avg(runs.map(r => r.ltTotalMs)))}ms  최대 ${fmt(avg(runs.map(r => r.ltMaxMs)))}ms`);
      console.log(`  TBT: ${fmt(avg(runs.map(r => r.tbt)))}ms`);
      console.log(`  DOM노드(스크롤중 최대): ${fmt(avg(runs.map(r => r.domNodesMax)), 0)}`);
      console.log(`  Canvas(스크롤중 최대): ${fmt(avg(runs.map(r => r.canvasMax)), 0)}개`);
      console.log(`  스크롤 LongTask: ${fmt(avg(runs.map(r => r.scrollLtCount)))}개  총 ${fmt(avg(runs.map(r => r.scrollLtTotalMs)))}ms`);
    }
  }

  // ── 최종 비교표 ──────────────────────────────────────────────────────────────
  console.log('\n\n' + '='.repeat(90));
  console.log('🏆 최종 비교 결과 (평균)');
  console.log('='.repeat(90));

  const headers = ['버전', '로드ms', 'LT개수', 'LT합ms', 'TBTms', 'DOM최대', 'Canvas최대', '스크롤LT개', '스크롤LTms'];
  const widths   = [24,      8,       7,       8,       8,      8,        11,          10,           10];

  console.log(headers.map((h, i) => h.padEnd(widths[i])).join(' | '));
  console.log('-'.repeat(90));

  const baseKey = 'basic';
  for (const [key, data] of Object.entries(allResults)) {
    const { runs } = data;
    if (!runs.length) continue;

    const row = [
      data.name,
      fmt(avg(runs.map(r => r.loadTime)), 0),
      fmt(avg(runs.map(r => r.ltCount))),
      fmt(avg(runs.map(r => r.ltTotalMs)), 0),
      fmt(avg(runs.map(r => r.tbt)), 0),
      fmt(avg(runs.map(r => r.domNodesMax)), 0),
      fmt(avg(runs.map(r => r.canvasMax)), 0),
      fmt(avg(runs.map(r => r.scrollLtCount))),
      fmt(avg(runs.map(r => r.scrollLtTotalMs)), 0),
    ];

    console.log(row.map((v, i) => v.padEnd(widths[i])).join(' | '));
  }

  // baseline 대비 개선율
  const base = allResults[baseKey];
  if (base && base.runs.length) {
    console.log('\n📊 basic 대비 개선율:');
    for (const [key, data] of Object.entries(allResults)) {
      if (key === baseKey || !data.runs.length) continue;
      const bRuns = base.runs, tRuns = data.runs;
      const imp = (metric) => {
        const b = avg(bRuns.map(r => r[metric]));
        const t = avg(tRuns.map(r => r[metric]));
        if (b === 0) return 'N/A';
        const pct = ((b - t) / b * 100).toFixed(1);
        return `${pct > 0 ? '-' : '+'}${Math.abs(pct)}%`;
      };
      console.log(`  ${data.name}:`);
      console.log(`    LongTask 총합 ${imp('ltTotalMs')}  |  TBT ${imp('tbt')}  |  DOM노드 ${imp('domNodesMax')}  |  스크롤LT ${imp('scrollLtTotalMs')}`);
    }
  }

  // ── JSON 저장 ─────────────────────────────────────────────────────────────────
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `basic-vs-optimized-${ts}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ timestamp: new Date().toISOString(), settings: { CPU_THROTTLE, RUNS, SCROLL_STEPS }, allResults }, null, 2));
  console.log(`\n💾 결과 저장: ${outFile}`);
  console.log('✅ 완료');
})();
