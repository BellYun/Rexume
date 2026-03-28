#!/usr/bin/env node
/**
 * INP (Interaction to Next Paint) 벤치마크
 *
 * PDF 렌더링 중 스크롤/클릭 인터랙션의 응답 지연을 측정합니다.
 * RAF 배칭의 실제 효과를 확인하는 데 적합한 지표입니다.
 *
 * 측정 방식:
 *   1. 페이지 로드 + PDF 렌더 시작
 *   2. 렌더링 진행 중 스크롤 인터랙션 반복 수행
 *   3. PerformanceObserver('event') + Long Animation Frame으로 응답 지연 측정
 *   4. INP = 가장 느린 인터랙션의 지연시간 (p98)
 *
 * 사용:
 *   node bench/inp-benchmark.js
 *
 * 환경변수:
 *   RUNS=3             반복 횟수 (기본 3)
 *   CPU_THROTTLE=4     CPU 스로틀 배율 (기본 4)
 *   BASE_URL=http://localhost:3000
 *   PDF_URL=/sample4.pdf
 *   SCROLL_COUNT=10    스크롤 인터랙션 횟수 (기본 10)
 *   SCROLL_DELAY=300   스크롤 간격 ms (기본 300)
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const RUNS = Number(process.env.RUNS || 3);
const CPU_THROTTLE = Number(process.env.CPU_THROTTLE || 4);
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const PDF_URL = process.env.PDF_URL || '/sample4.pdf';
const SCROLL_COUNT = Number(process.env.SCROLL_COUNT || 10);
const SCROLL_DELAY = Number(process.env.SCROLL_DELAY || 300);

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
    name: 'Optimized (IO+RAF+Limit)',
    shortName: 'optimized',
  },
  {
    url: `${BASE_URL}/pdf-bench/opt14?url=${PDF_URL}`,
    name: 'Opt14 (IO+RAF+Limit+Cache)',
    shortName: 'opt14',
  },
  {
    url: `${BASE_URL}/pdf-bench/opt15?url=${PDF_URL}`,
    name: 'Opt15 (IO+RAF+Worker, Limit=3)',
    shortName: 'opt15',
  },
  {
    url: `${BASE_URL}/pdf-bench/opt15-nolimit?url=${PDF_URL}`,
    name: 'Opt15-NoLimit (IO+RAF+Worker)',
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

  // 인터랙션 측정용 스크립트 주입
  await page.evaluateOnNewDocument(() => {
    window.__inp = {
      interactions: [],
      longTasks: [],
      longAnimationFrames: [],
      fcpTime: null,
    };

    if (window.PerformanceObserver) {
      try {
        // Event Timing API — 인터랙션 지연 측정
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            // interactionId가 있는 것만 (실제 인터랙션)
            if (entry.interactionId > 0) {
              window.__inp.interactions.push({
                name: entry.name,
                type: entry.entryType,
                startTime: entry.startTime,
                duration: entry.duration,
                processingStart: entry.processingStart,
                processingEnd: entry.processingEnd,
                interactionId: entry.interactionId,
                // 입력 지연 = processingStart - startTime
                inputDelay: entry.processingStart - entry.startTime,
                // 처리 시간 = processingEnd - processingStart
                processingTime: entry.processingEnd - entry.processingStart,
                // 표현 지연 = duration - (processingEnd - startTime)
                presentationDelay: entry.duration - (entry.processingEnd - entry.startTime),
              });
            }
          }
        }).observe({ type: 'event', buffered: true, durationThreshold: 0 });

        // Long Task 추적
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            window.__inp.longTasks.push({
              startTime: entry.startTime,
              duration: entry.duration,
            });
          }
        }).observe({ type: 'longtask', buffered: true });

        // FCP 추적
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.name === 'first-contentful-paint') {
              window.__inp.fcpTime = entry.startTime;
            }
          }
        }).observe({ type: 'paint', buffered: true });

        // Long Animation Frame 추적 (available in Chrome 123+)
        try {
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              window.__inp.longAnimationFrames.push({
                startTime: entry.startTime,
                duration: entry.duration,
                blockingDuration: entry.blockingDuration,
                renderStart: entry.renderStart,
                styleAndLayoutStart: entry.styleAndLayoutStart,
              });
            }
          }).observe({ type: 'long-animation-frame', buffered: true });
        } catch (_) {
          // Long Animation Frame API 미지원 시 무시
        }
      } catch (e) {
        console.warn('[INP] PerformanceObserver 초기화 실패:', e);
      }
    }
  });

  // 페이지 로드
  await page.goto(testUrl, { waitUntil: 'networkidle2', timeout: 60000 });

  // 캔버스 생성 대기 (PDF 렌더 시작 확인)
  try {
    await page.waitForFunction(
      () => document.querySelectorAll('canvas').length > 0,
      { timeout: 15000 }
    );
  } catch {
    // 계속 진행
  }

  // 잠깐 대기 후 스크롤 인터랙션 시작 (렌더링 진행 중에 수행)
  await new Promise((r) => setTimeout(r, 500));

  // 스크롤 인터랙션 수행
  for (let i = 0; i < SCROLL_COUNT; i++) {
    // 마우스 휠 스크롤 (실제 유저 인터랙션)
    await page.mouse.wheel({ deltaY: 400 });
    await new Promise((r) => setTimeout(r, SCROLL_DELAY));
  }

  // 위로 스크롤 (추가 인터랙션)
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel({ deltaY: -600 });
    await new Promise((r) => setTimeout(r, SCROLL_DELAY));
  }

  // 클릭 인터랙션
  try {
    await page.mouse.click(960, 540);
    await new Promise((r) => setTimeout(r, 200));
    await page.mouse.click(960, 300);
    await new Promise((r) => setTimeout(r, 200));
  } catch {
    // 클릭 실패 무시
  }

  // 안정화 대기
  await new Promise((r) => setTimeout(r, 2000));

  // 결과 수집
  const result = await page.evaluate(() => {
    const interactions = window.__inp.interactions;
    const longTasks = window.__inp.longTasks;
    const loaf = window.__inp.longAnimationFrames;

    // 인터랙션별 최대 duration 기준 그룹핑 (같은 interactionId)
    const grouped = {};
    for (const i of interactions) {
      if (!grouped[i.interactionId] || i.duration > grouped[i.interactionId].duration) {
        grouped[i.interactionId] = i;
      }
    }
    const uniqueInteractions = Object.values(grouped);

    // duration 기준 정렬
    const sorted = [...uniqueInteractions].sort((a, b) => b.duration - a.duration);

    // INP = p98 of interaction durations (or worst if < 50 interactions)
    let inp = 0;
    if (sorted.length > 0) {
      const p98Index = Math.max(0, Math.floor(sorted.length * 0.02));
      inp = sorted[p98Index]?.duration || 0;
    }

    // duration 통계
    const durations = uniqueInteractions.map((i) => i.duration);
    const inputDelays = uniqueInteractions.map((i) => i.inputDelay);
    const processingTimes = uniqueInteractions.map((i) => i.processingTime);
    const presentationDelays = uniqueInteractions.map((i) => i.presentationDelay);

    const calcStats = (arr) => {
      if (!arr.length) return { avg: 0, min: 0, max: 0, median: 0, p75: 0, p95: 0 };
      const s = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return {
        avg: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
        min: Math.round(s[0]),
        max: Math.round(s[s.length - 1]),
        median: Math.round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2),
        p75: Math.round(s[Math.floor(s.length * 0.75)] || s[s.length - 1]),
        p95: Math.round(s[Math.floor(s.length * 0.95)] || s[s.length - 1]),
      };
    };

    // TBT 계산
    const fcp = window.__inp.fcpTime || 0;
    const tbt = longTasks
      .filter((t) => fcp > 0 && t.startTime + t.duration > fcp)
      .reduce((sum, t) => sum + Math.max(0, t.duration - 50), 0);

    // LoAF 통계
    const loafDurations = loaf.map((l) => l.duration);
    const loafBlocking = loaf.map((l) => l.blockingDuration);

    return {
      inp: Math.round(inp),
      interactionCount: uniqueInteractions.length,
      totalEventCount: interactions.length,

      duration: calcStats(durations),
      inputDelay: calcStats(inputDelays),
      processingTime: calcStats(processingTimes),
      presentationDelay: calcStats(presentationDelays),

      tbt: Math.round(tbt),
      longTaskCount: longTasks.length,
      fcp: Math.round(fcp),

      loafCount: loaf.length,
      loafDuration: calcStats(loafDurations),
      loafBlocking: calcStats(loafBlocking),

      // 상위 5개 느린 인터랙션
      slowest5: sorted.slice(0, 5).map((i) => ({
        name: i.name,
        duration: Math.round(i.duration),
        inputDelay: Math.round(i.inputDelay),
        processingTime: Math.round(i.processingTime),
        presentationDelay: Math.round(i.presentationDelay),
      })),
    };
  });

  await browser.close();

  const rating = result.inp <= 200 ? 'GOOD' : result.inp <= 500 ? 'NEEDS_IMPROVEMENT' : 'POOR';
  console.log(
    `INP=${result.inp}ms (${rating})  interactions=${result.interactionCount}  inputDelay.p75=${result.inputDelay.p75}ms  TBT=${result.tbt}ms`
  );

  return { ...result, version: versionName, run, rating };
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
  const SEP = '═'.repeat(120);
  const baseline = summaries[0]?.inp.median || 1;

  console.log(`\n${SEP}`);
  console.log(` INP 벤치마크 결과  [CPU ${CPU_THROTTLE}x · ${RUNS}회 · scroll ${SCROLL_COUNT}회 × ${SCROLL_DELAY}ms]`);
  console.log(`${SEP}`);
  console.log(
    `${'버전'.padEnd(38)} ${'INP med'.padStart(9)} ${'등급'.padStart(8)} ${'vs basic'.padStart(10)} ${'inputDelay'.padStart(12)} ${'processing'.padStart(12)} ${'presDelay'.padStart(11)} ${'TBT'.padStart(8)}`
  );
  console.log(
    `${'─'.repeat(38)} ${'─'.repeat(9)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(12)} ${'─'.repeat(12)} ${'─'.repeat(11)} ${'─'.repeat(8)}`
  );

  for (const s of summaries) {
    const diff = s.inp.median - baseline;
    const pct = baseline > 0 ? ((diff / baseline) * 100).toFixed(1) : '0.0';
    const sign =
      s.shortName === 'basic'
        ? '  (base)'
        : diff < 0
        ? `↓${Math.abs(Number(pct))}%`
        : diff > 0
        ? `↑${pct}%`
        : '  =';

    const rating =
      s.inp.median <= 200 ? '  GOOD' : s.inp.median <= 500 ? '  NEEDS' : '  POOR';

    console.log(
      `${s.version.padEnd(38)} ${(s.inp.median + 'ms').padStart(9)} ${rating.padStart(8)} ${sign.padStart(10)} ${(s.inputDelay.median + 'ms').padStart(12)} ${(s.processingTime.median + 'ms').padStart(12)} ${(s.presentationDelay.median + 'ms').padStart(11)} ${(s.tbt.median + 'ms').padStart(8)}`
    );
  }
  console.log(`${SEP}`);

  // INP 등급 기준
  console.log('\n📏 INP 등급 기준 (Google Web Vitals):');
  console.log('  GOOD: ≤ 200ms  |  NEEDS IMPROVEMENT: ≤ 500ms  |  POOR: > 500ms');

  // 개선율 요약
  if (summaries.length >= 2) {
    const base = summaries[0].inp.median;
    console.log('\n📊 Basic 대비 INP 변화:');
    for (const s of summaries.slice(1)) {
      const saved = base - s.inp.median;
      if (saved > 0) {
        console.log(
          `  ${s.version}: ${base}ms → ${s.inp.median}ms  (↓${saved}ms, ${((saved / base) * 100).toFixed(1)}% 감소)`
        );
      } else if (saved < 0) {
        console.log(
          `  ${s.version}: ${base}ms → ${s.inp.median}ms  (↑${Math.abs(saved)}ms 증가)`
        );
      } else {
        console.log(`  ${s.version}: 변화 없음`);
      }
    }
  }
}

// ── 메인 ──────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(` INP (Interaction to Next Paint) 벤치마크`);
  console.log(` CPU ${CPU_THROTTLE}x · ${RUNS}회 반복 · scroll ${SCROLL_COUNT}회 × ${SCROLL_DELAY}ms`);
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

  // 통계 집계
  const summaries = TEST_URLS.map((t) => {
    const runs = allResults[t.shortName] || [];
    return {
      version: t.name,
      shortName: t.shortName,
      inp: stats(runs.map((r) => r.inp)),
      interactionCount: stats(runs.map((r) => r.interactionCount)),
      duration: {
        avg: stats(runs.map((r) => r.duration.avg)),
        median: stats(runs.map((r) => r.duration.median)),
        p75: stats(runs.map((r) => r.duration.p75)),
        p95: stats(runs.map((r) => r.duration.p95)),
        max: stats(runs.map((r) => r.duration.max)),
      },
      inputDelay: {
        avg: stats(runs.map((r) => r.inputDelay.avg)),
        median: stats(runs.map((r) => r.inputDelay.median)),
        p75: stats(runs.map((r) => r.inputDelay.p75)),
        max: stats(runs.map((r) => r.inputDelay.max)),
      },
      processingTime: {
        avg: stats(runs.map((r) => r.processingTime.avg)),
        median: stats(runs.map((r) => r.processingTime.median)),
        p75: stats(runs.map((r) => r.processingTime.p75)),
        max: stats(runs.map((r) => r.processingTime.max)),
      },
      presentationDelay: {
        avg: stats(runs.map((r) => r.presentationDelay.avg)),
        median: stats(runs.map((r) => r.presentationDelay.median)),
        p75: stats(runs.map((r) => r.presentationDelay.p75)),
        max: stats(runs.map((r) => r.presentationDelay.max)),
      },
      tbt: stats(runs.map((r) => r.tbt)),
      longTaskCount: stats(runs.map((r) => r.longTaskCount)),
      runs: runs.length,
    };
  });

  printTable(summaries);

  // 상세 통계
  console.log('\n\n상세 통계:');
  for (const s of summaries) {
    console.log(`\n  ${s.version} (${s.runs}회)`);
    console.log(`    INP          : median=${s.inp.median}ms  avg=${s.inp.avg}ms  min=${s.inp.min}ms  max=${s.inp.max}ms`);
    console.log(`    Duration     : median=${s.duration.median.median}ms  p75=${s.duration.p75.median}ms  p95=${s.duration.p95.median}ms  max=${s.duration.max.median}ms`);
    console.log(`    Input Delay  : median=${s.inputDelay.median.median}ms  p75=${s.inputDelay.p75.median}ms  max=${s.inputDelay.max.median}ms`);
    console.log(`    Processing   : median=${s.processingTime.median.median}ms  p75=${s.processingTime.p75.median}ms  max=${s.processingTime.max.median}ms`);
    console.log(`    Pres. Delay  : median=${s.presentationDelay.median.median}ms  p75=${s.presentationDelay.p75.median}ms  max=${s.presentationDelay.max.median}ms`);
    console.log(`    TBT          : median=${s.tbt.median}ms  avg=${s.tbt.avg}ms`);
    console.log(`    Interactions : median=${s.interactionCount.median}개`);
  }

  // JSON 저장
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `inp-benchmark-${ts}.json`);
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        summaries,
        allResults,
        meta: {
          runs: RUNS,
          cpuThrottle: CPU_THROTTLE,
          scrollCount: SCROLL_COUNT,
          scrollDelay: SCROLL_DELAY,
          baseUrl: BASE_URL,
          pdfUrl: PDF_URL,
          timestamp: new Date().toISOString(),
          metric: 'INP (Interaction to Next Paint) - p98 of interaction durations',
          rating: 'GOOD: ≤200ms, NEEDS_IMPROVEMENT: ≤500ms, POOR: >500ms',
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
