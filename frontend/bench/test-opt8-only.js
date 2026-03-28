#!/usr/bin/env node
/**
 * Opt8 단독 테스트 스크립트
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// ---- 설정 ----
const CPU_THROTTLE = 1; // 스로틀링 없음
const RUNS_PER_URL = 3;
const HEADLESS = true;
const BASE_URL = process.env.TEST_URL || 'http://localhost:3000';

// Opt8만 테스트
const TEST_URLS = [
  {
    url: `${BASE_URL}/feedback/4?version=opt8-raf-paint-batching`,
    name: 'Opt8: RAF 페인트 + 배칭',
    shortName: 'opt8-raf-paint-batching'
  }
];

const benchDir = __dirname;
const outDir = path.join(benchDir, 'results');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

/**
 * PDF 첫페이지 렌더링 시간과 TBT 측정
 */
async function measurePDFFirstPagePerformance(testUrl, versionName, runNumber = 1) {
  console.log(`\n📊 측정 시작 (${runNumber}회차): ${versionName}`);
  console.log(`   URL: ${testUrl}`);
  
  const isDocker = fs.existsSync('/.dockerenv');
  
  const launchOptions = {
    headless: HEADLESS ? 'new' : false,
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

  // CPU 스로틀링 설정
  if (CPU_THROTTLE > 1) {
    console.log(`   CPU ${CPU_THROTTLE}x throttling 적용`);
    const client = await page.target().createCDPSession();
    await client.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
  }

  // Performance Observer로 Long Task 수집
  await page.evaluateOnNewDocument(() => {
    window.__longTasks = [];
    if (window.PerformanceObserver) {
      try {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            window.__longTasks.push({
              startTime: entry.startTime,
              duration: entry.duration,
              timestamp: performance.now()
            });
          }
        });
        observer.observe({ entryTypes: ['longtask'] });
      } catch (e) {
        console.warn('PerformanceLongTaskTiming not supported');
      }
    }
  });

  // 페이지 이동
  console.log('   페이지 이동 중...');
  await page.goto(testUrl, { waitUntil: 'networkidle0', timeout: 120000 });

  // PDF 첫페이지 렌더링 대기
  console.log('   페이지 로드 완료, PDF 첫페이지 렌더링 대기...');
  
  const result = await page.evaluate(() => {
    return new Promise((resolve) => {
      const startTime = performance.now();
      let firstCanvasTime = null;
      let canvasCount = 0;

      const checkCanvas = () => {
        const canvases = document.querySelectorAll('canvas');
        
        // 캔버스가 나타났는지 확인
        if (canvases.length > 0 && !firstCanvasTime) {
          firstCanvasTime = performance.now();
          console.log(`[FirstPage] 첫 캔버스 렌더링: ${(firstCanvasTime - startTime).toFixed(2)}ms`);
        }

        canvasCount = canvases.length;

        // 충분히 대기 (3초 동안 안정화)
        if (firstCanvasTime && (performance.now() - firstCanvasTime) > 3000) {
          // Web Vitals 수집
          const paintEntries = performance.getEntriesByType('paint');
          const navigationEntry = performance.getEntriesByType('navigation')[0];

          const metrics = {
            firstPageCanvasTime: firstCanvasTime - startTime,
            firstPaint: paintEntries.find(e => e.name === 'first-paint')?.startTime || null,
            firstContentfulPaint: paintEntries.find(e => e.name === 'first-contentful-paint')?.startTime || null,
            largestContentfulPaint: null,
            domContentLoaded: navigationEntry?.domContentLoadedEventEnd - navigationEntry?.domContentLoadedEventStart || null,
            loadComplete: navigationEntry?.loadEventEnd - navigationEntry?.loadEventStart || null,
            canvasCount: canvasCount,
            longTasks: window.__longTasks || [],
            measurementDuration: performance.now() - startTime,
          };

          // LCP 수집 시도
          if (window.PerformanceObserver) {
            try {
              const lcpObserver = new PerformanceObserver((list) => {
                const entries = list.getEntries();
                if (entries.length > 0) {
                  metrics.largestContentfulPaint = entries[entries.length - 1].startTime;
                }
              });
              lcpObserver.observe({ entryTypes: ['largest-contentful-paint'] });
              
              setTimeout(() => {
                lcpObserver.disconnect();
                resolve(metrics);
              }, 100);
            } catch (e) {
              resolve(metrics);
            }
          } else {
            resolve(metrics);
          }
        } else {
          setTimeout(checkCanvas, 100);
        }
      };

      checkCanvas();
    });
  });

  // TBT 계산
  const longTasks = result.longTasks || [];
  const totalBlockingTime = longTasks.reduce((sum, task) => {
    const blockingTime = Math.max(0, task.duration - 50);
    return sum + blockingTime;
  }, 0);

  const finalResult = {
    version: versionName,
    url: testUrl,
    runNumber,
    timestamp: new Date().toISOString(),
    firstPageRenderTime: result.firstPageCanvasTime,
    firstPageCanvasTime: result.firstPageCanvasTime,
    firstPaint: result.firstPaint,
    firstContentfulPaint: result.firstContentfulPaint,
    largestContentfulPaint: result.largestContentfulPaint,
    totalBlockingTime,
    longTaskCount: longTasks.length,
    longTasks,
    domContentLoaded: result.domContentLoaded,
    loadComplete: result.loadComplete,
    canvasCount: result.canvasCount,
    measurementDuration: result.measurementDuration,
  };

  await browser.close();
  
  console.log('   PDF 첫페이지 렌더링 감지됨');
  console.log('   안정화 대기 중...');

  return finalResult;
}

function printResult(result) {
  console.log(`\n📊 측정 결과 (${result.runNumber}회차): ${result.version}`);
  console.log('='.repeat(70));
  console.log(`첫캔버스 렌더링 시간: ${result.firstPageRenderTime.toFixed(2)}ms ✅`);
  console.log(`First Paint: ${result.firstPaint?.toFixed(2) || 'N/A'}ms`);
  console.log(`First Contentful Paint: ${result.firstContentfulPaint?.toFixed(2) || 'N/A'}ms`);
  console.log(`Largest Contentful Paint: ${result.largestContentfulPaint?.toFixed(2) || 'N/A'}ms`);
  
  const tbtQuality = result.totalBlockingTime < 200 ? '✅' : result.totalBlockingTime < 600 ? '⚠️' : '❌';
  console.log(`Total Blocking Time: ${result.totalBlockingTime.toFixed(2)}ms ${tbtQuality}`);
  console.log(`Long Tasks: ${result.longTaskCount}개`);
  
  if (result.longTasks && result.longTasks.length > 0) {
    const avgDuration = result.longTasks.reduce((sum, t) => sum + t.duration, 0) / result.longTasks.length;
    const maxDuration = Math.max(...result.longTasks.map(t => t.duration));
    console.log(`LongTask 평균: ${avgDuration.toFixed(2)}ms, 최대: ${maxDuration.toFixed(2)}ms`);
  }
  
  console.log(`DOM Content Loaded: ${result.domContentLoaded?.toFixed(2) || 'N/A'}ms`);
  console.log(`Load Complete: ${result.loadComplete?.toFixed(2) || 'N/A'}ms`);
  console.log(`Canvas 요소 수: ${result.canvasCount}개`);
  console.log(`측정 지속 시간: ${result.measurementDuration.toFixed(2)}ms`);
}

function calculateStatistics(results) {
  const validResults = results.filter(r => r.firstPageRenderTime !== null || r.firstPageCanvasTime !== null);
  
  if (validResults.length === 0) {
    return null;
  }

  const firstPageTimes = validResults.map(r => r.firstPageRenderTime || r.firstPageCanvasTime);
  const tbts = validResults.map(r => r.totalBlockingTime || 0);
  const longTaskCounts = validResults.map(r => r.longTaskCount || 0);
  const fcps = validResults.map(r => r.firstContentfulPaint).filter(v => v !== null);
  const lcps = validResults.map(r => r.largestContentfulPaint).filter(v => v !== null);

  return {
    count: validResults.length,
    firstPageRenderTime: {
      avg: firstPageTimes.reduce((a, b) => a + b, 0) / firstPageTimes.length,
      min: Math.min(...firstPageTimes),
      max: Math.max(...firstPageTimes),
    },
    totalBlockingTime: {
      avg: tbts.reduce((a, b) => a + b, 0) / tbts.length,
      min: Math.min(...tbts),
      max: Math.max(...tbts),
    },
    longTaskCount: {
      avg: longTaskCounts.reduce((a, b) => a + b, 0) / longTaskCounts.length,
      min: Math.min(...longTaskCounts),
      max: Math.max(...longTaskCounts),
    },
    firstContentfulPaint: fcps.length > 0 ? {
      avg: fcps.reduce((a, b) => a + b, 0) / fcps.length,
      min: Math.min(...fcps),
      max: Math.max(...fcps),
    } : null,
    largestContentfulPaint: lcps.length > 0 ? {
      avg: lcps.reduce((a, b) => a + b, 0) / lcps.length,
      min: Math.min(...lcps),
      max: Math.max(...lcps),
    } : null,
  };
}

/**
 * 메인 실행
 */
(async () => {
  console.log('\n🚀 Opt8 단독 테스트');
  console.log('='.repeat(80));
  console.log(`설정:`);
  console.log(`  - CPU Throttle: ${CPU_THROTTLE}x`);
  console.log(`  - 반복 횟수: ${RUNS_PER_URL}회`);
  console.log(`  - Headless: ${HEADLESS}`);
  console.log('');

  const allResults = {};

  for (const { url, name, shortName } of TEST_URLS) {
    console.log('\n' + '#'.repeat(80));
    console.log(`### ${name} ###`);
    console.log(`### ${url}`);
    console.log('#'.repeat(80));

    const urlResults = [];

    for (let run = 1; run <= RUNS_PER_URL; run++) {
      try {
        const result = await measurePDFFirstPagePerformance(url, name, run);
        urlResults.push(result);
        printResult(result);

        if (run < RUNS_PER_URL) {
          console.log('⏸️  다음 실행까지 3초 대기...\n');
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      } catch (error) {
        console.error(`❌ ${name} ${run}회차 측정 실패:`, error.message);
      }
    }

    allResults[shortName] = {
      name: name,
      url: url,
      shortName: shortName,
      results: urlResults,
    };

    // 통계 출력
    const stats = calculateStatistics(urlResults);
    if (stats) {
      console.log('\n' + '─'.repeat(70));
      console.log(`📈 ${name} - ${stats.count}회 실행 통계`);
      console.log('─'.repeat(70));
      console.log(`첫페이지 렌더링 시간: 평균 ${stats.firstPageRenderTime.avg.toFixed(2)}ms (${stats.firstPageRenderTime.min.toFixed(2)} ~ ${stats.firstPageRenderTime.max.toFixed(2)})`);
      console.log(`Total Blocking Time: 평균 ${stats.totalBlockingTime.avg.toFixed(2)}ms (${stats.totalBlockingTime.min.toFixed(0)} ~ ${stats.totalBlockingTime.max.toFixed(0)})`);
      console.log(`Long Tasks: 평균 ${stats.longTaskCount.avg.toFixed(1)}개 (${stats.longTaskCount.min} ~ ${stats.longTaskCount.max})`);
      
      if (stats.firstContentfulPaint) {
        console.log(`First Contentful Paint: 평균 ${stats.firstContentfulPaint.avg.toFixed(2)}ms (${stats.firstContentfulPaint.min.toFixed(2)} ~ ${stats.firstContentfulPaint.max.toFixed(2)})`);
      }
      
      if (stats.largestContentfulPaint) {
        console.log(`Largest Contentful Paint: 평균 ${stats.largestContentfulPaint.avg.toFixed(2)}ms (${stats.largestContentfulPaint.min.toFixed(2)} ~ ${stats.largestContentfulPaint.max.toFixed(2)})`);
      }
    } else {
      console.log('\n❌ 유효한 측정 결과가 없습니다.');
    }
  }

  // 결과 저장
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = path.join(outDir, `opt8-test-${timestamp}.json`);
  
  const summary = {
    timestamp: new Date().toISOString(),
    config: {
      cpuThrottle: CPU_THROTTLE,
      runsPerUrl: RUNS_PER_URL,
      headless: HEADLESS,
      testUrls: TEST_URLS,
    },
    results: allResults,
    statistics: {},
  };

  // 통계 추가
  for (const [shortName, data] of Object.entries(allResults)) {
    const stats = calculateStatistics(data.results);
    if (stats) {
      summary.statistics[shortName] = {
        name: data.name,
        ...stats,
      };
    }
  }

  fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2));
  console.log(`\n💾 결과 저장: ${outputPath}`);
  console.log('\n✅ Opt8 테스트 완료!\n');

})().catch((e) => {
  console.error('❌ 오류 발생:', e);
  process.exit(1);
});

