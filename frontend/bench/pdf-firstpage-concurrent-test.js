#!/usr/bin/env node
/**
 * PDF 첫페이지 렌더링 - Simple 75vh + rAF 동시성 제한 테스트
 * 
 * 기존 pdf-firstpage-performance.js를 기반으로 동시성 제한 값(K)별 성능 비교
 * 
 * 사용:
 *   node bench/pdf-firstpage-concurrent-test.js
 *   CPU_THROTTLE=4 RUNS_PER_URL=10 node bench/pdf-firstpage-concurrent-test.js
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// ---- 설정 ----
const CPU_THROTTLE = Number(process.env.CPU_THROTTLE || 4);
const RUNS_PER_URL = Number(process.env.RUNS_PER_URL || 10);
const HEADLESS = true;
const BASE_URL = process.env.TEST_URL || 'http://localhost:3000';

// 동시성 제한 값 테스트 목록
// 기존: [1, 2, 3, 4, 6, 8]
// 추가 테스트: 더 큰 값들만 (10, 12, 16, 20, 24)
const CONCURRENT_VALUES = [1, 2, 3, 4, 6, 8, 10, 12, 16, 20, 24];

// 측정할 URL 목록
const TEST_URLS = CONCURRENT_VALUES.map(k => ({
  url: `${BASE_URL}/feedback/4?version=simple-75vh-raf-paint&concurrent=${k}`,
  name: `Simple 75vh + rAF (K=${k})`,
  shortName: `simple-75vh-raf-paint-k${k}`,
  concurrent: k
}));

const benchDir = __dirname;
const outDir = path.join(benchDir, 'results');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

/**
 * PDF 첫페이지 렌더링 시간과 TBT 측정 (기존 스크립트 로직 사용)
 */
async function measurePDFFirstPagePerformance(testUrl, versionName, runNumber = 1) {
  console.log(`\n📊 측정 시작 (${runNumber}회차): ${versionName}`);
  console.log(`   URL: ${testUrl}`);
  
  // Docker 환경 감지
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

  // CPU throttling 적용
  const client = await page.target().createCDPSession();
  await client.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
  console.log(`   CPU ${CPU_THROTTLE}x throttling 적용`);

  // 콘솔 로그 포워딩
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('[PDFTrace]') || text.includes('[LongTask]') || text.includes('[FirstPage]')) {
      console.log(`   ${text}`);
    }
  });

  // 페이지 로드 전 추적 설정 (기존 스크립트와 동일)
  await page.evaluateOnNewDocument(() => {
    window.__pdfFirstPageMetrics = {
      firstPageRenderTime: null,
      firstPageCanvasTime: null,
      navigationStart: performance.now(),
      longTasks: [],
      paintEvents: [],
      firstContentfulPaint: null,
      largestContentfulPaint: null,
      startTime: null,
    };

    // LongTask Observer
    if (window.PerformanceObserver) {
      try {
        const ltObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            window.__pdfFirstPageMetrics.longTasks.push({
              startTime: entry.startTime,
              duration: entry.duration,
              timestamp: performance.now(),
            });
          }
        });
        ltObserver.observe({ type: 'longtask', buffered: true });

        // Paint Events 추적
        const paintObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            window.__pdfFirstPageMetrics.paintEvents.push({
              name: entry.name,
              startTime: entry.startTime,
              duration: entry.duration,
            });
            
            if (entry.name === 'first-contentful-paint' && !window.__pdfFirstPageMetrics.firstContentfulPaint) {
              window.__pdfFirstPageMetrics.firstContentfulPaint = entry.startTime;
            }
          }
        });
        paintObserver.observe({ type: 'paint', buffered: true });

        // LCP 추적
        const lcpObserver = new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const lastEntry = entries[entries.length - 1];
          window.__pdfFirstPageMetrics.largestContentfulPaint = lastEntry.startTime;
        });
        lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });

      } catch (e) {
        console.warn('[PerformanceObserver] 초기화 실패:', e);
      }
    }

    // PDF 첫페이지 렌더링 추적
    window.pdfFirstPageTracker = {
      isFirstPageRendered: false,
      renderStartTime: null,
      canvasElements: new Set(),
      
      onCanvasRender: function(canvas, timestamp) {
        if (!this.isFirstPageRendered) {
          this.isFirstPageRendered = true;
          window.__pdfFirstPageMetrics.firstPageCanvasTime = timestamp;
          console.log(`[FirstPage] 첫 캔버스 렌더링: ${timestamp.toFixed(2)}ms`);
        }
      },
      
      onPageRender: function(pageNumber, timestamp) {
        if (pageNumber === 1 && window.__pdfFirstPageMetrics.firstPageRenderTime === null) {
          window.__pdfFirstPageMetrics.firstPageRenderTime = timestamp;
          console.log(`[FirstPage] 첫페이지 렌더링 완료: ${timestamp.toFixed(2)}ms`);
        }
      }
    };

    // Canvas 요소 모니터링
    const originalCreateElement = document.createElement;
    document.createElement = function(tagName) {
      const element = originalCreateElement.call(this, tagName);
      
      if (tagName.toLowerCase() === 'canvas') {
        window.pdfFirstPageTracker.canvasElements.add(element);
        
        if (element.getContext) {
          const context = element.getContext('2d');
          if (context && context.drawImage) {
            const originalDrawImage = context.drawImage.bind(context);
            context.drawImage = function(...args) {
              const timestamp = performance.now();
              window.pdfFirstPageTracker.onCanvasRender(element, timestamp);
              return originalDrawImage.apply(this, args);
            };
          }
        }
      }
      
      return element;
    };

    // MutationObserver로 캔버스 변화 감지
    if (window.MutationObserver) {
      const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              if (node.tagName === 'CANVAS') {
                window.pdfFirstPageTracker.canvasElements.add(node);
                console.log('[FirstPage] 캔버스 요소 감지됨');
              }
              
              const canvases = node.querySelectorAll ? node.querySelectorAll('canvas') : [];
              canvases.forEach(canvas => {
                window.pdfFirstPageTracker.canvasElements.add(canvas);
                console.log('[FirstPage] 하위 캔버스 감지됨');
              });
            }
          });
        });
      });
      
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
          observer.observe(document.body, { childList: true, subtree: true });
        });
      } else {
        observer.observe(document.body, { childList: true, subtree: true });
      }
    }
  });

  console.log('   페이지 이동 중...');
  
  await page.goto(testUrl, { 
    waitUntil: ['networkidle2', 'domcontentloaded'], 
    timeout: 120000
  });

  console.log('   페이지 로드 완료, PDF 첫페이지 렌더링 대기...');
  
  // 측정 시작 시간 설정
  await page.evaluate(() => {
    window.__pdfFirstPageMetrics.startTime = performance.now();
    window.__pdfFirstPageMetrics.navigationStart = performance.timing.navigationStart || performance.now();
  });

  // PDF 첫페이지 렌더링 완료까지 대기
  try {
    await page.waitForFunction(() => {
      return window.__pdfFirstPageMetrics.firstPageRenderTime !== null || 
             window.__pdfFirstPageMetrics.firstPageCanvasTime !== null ||
             window.pdfFirstPageTracker.canvasElements.size > 0;
    }, { timeout: 30000 });
    
    console.log('   PDF 첫페이지 렌더링 감지됨');
  } catch (error) {
    console.warn('   PDF 첫페이지 렌더링 타임아웃, 추가 대기...');
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  // 안정화 대기
  console.log('   안정화 대기 중...');
  await new Promise(resolve => setTimeout(resolve, 3000));

  // 결과 수집
  const result = await page.evaluate(() => {
    const navigationTiming = performance.getEntriesByType('navigation')[0];
    const paintTiming = performance.getEntriesByType('paint');
    const fcpPaint = paintTiming.find(p => p.name === 'first-contentful-paint');
    const fpPaint = paintTiming.find(p => p.name === 'first-paint');

    // TBT 계산
    const fcpTime = window.__pdfFirstPageMetrics.firstContentfulPaint || fcpPaint?.startTime || 0;
    const currentTime = performance.now();
    let tbt = 0;
    
    if (fcpTime > 0) {
      const relevantTasks = window.__pdfFirstPageMetrics.longTasks.filter(task => {
        const taskEnd = task.startTime + task.duration;
        return taskEnd > fcpTime && task.startTime < currentTime;
      });

      tbt = relevantTasks.reduce((sum, task) => {
        const blockingTime = Math.max(0, task.duration - 50);
        return sum + blockingTime;
      }, 0);
    }

    const longTaskDurations = window.__pdfFirstPageMetrics.longTasks.map(t => t.duration);
    const longTaskAvg = longTaskDurations.length > 0 
      ? longTaskDurations.reduce((a, b) => a + b, 0) / longTaskDurations.length 
      : 0;
    const longTaskMax = longTaskDurations.length > 0 ? Math.max(...longTaskDurations) : 0;

    return {
      firstPageRenderTime: window.__pdfFirstPageMetrics.firstPageRenderTime,
      firstPageCanvasTime: window.__pdfFirstPageMetrics.firstPageCanvasTime,
      firstPaint: fpPaint?.startTime || null,
      firstContentfulPaint: window.__pdfFirstPageMetrics.firstContentfulPaint || fcpPaint?.startTime || null,
      largestContentfulPaint: window.__pdfFirstPageMetrics.largestContentfulPaint || null,
      longTasks: window.__pdfFirstPageMetrics.longTasks,
      totalBlockingTime: tbt,
      longTaskCount: window.__pdfFirstPageMetrics.longTasks.length,
      longTaskAvg: longTaskAvg,
      longTaskMax: longTaskMax,
      navigationStart: window.__pdfFirstPageMetrics.navigationStart || navigationTiming?.startTime || 0,
      domContentLoaded: navigationTiming?.domContentLoadedEventEnd - navigationTiming?.fetchStart || null,
      loadComplete: navigationTiming?.loadEventEnd - navigationTiming?.fetchStart || null,
      canvasCount: window.pdfFirstPageTracker.canvasElements.size,
      measurementDuration: performance.now() - (window.__pdfFirstPageMetrics.startTime || 0),
    };
  });

  await browser.close();

  return {
    version: versionName,
    url: testUrl,
    runNumber: runNumber,
    timestamp: new Date().toISOString(),
    ...result,
  };
}

/**
 * 결과 출력
 */
function printResult(result) {
  console.log(`\n📊 측정 결과 (${result.runNumber}회차): ${result.version}`);
  console.log('='.repeat(70));
  
  const renderTime = result.firstPageRenderTime || result.firstPageCanvasTime;
  if (renderTime !== null) {
    console.log(`첫캔버스 렌더링 시간: ${renderTime.toFixed(2)}ms ✅`);
  } else {
    console.log(`첫페이지 렌더링 시간: 측정 실패 ❌`);
  }
  
  console.log(`First Paint: ${result.firstPaint?.toFixed(2) || 'N/A'}ms`);
  console.log(`First Contentful Paint: ${result.firstContentfulPaint?.toFixed(2) || 'N/A'}ms`);
  console.log(`Largest Contentful Paint: ${result.largestContentfulPaint?.toFixed(2) || 'N/A'}ms`);
  console.log(`Total Blocking Time: ${result.totalBlockingTime.toFixed(2)}ms ${result.totalBlockingTime > 200 ? '❌' : '✅'}`);
  console.log(`Long Tasks: ${result.longTaskCount}개`);
  console.log(`LongTask 평균: ${result.longTaskAvg.toFixed(2)}ms, 최대: ${result.longTaskMax.toFixed(2)}ms`);
  console.log(`DOM Content Loaded: ${result.domContentLoaded?.toFixed(2) || 'N/A'}ms`);
  console.log(`Load Complete: ${result.loadComplete?.toFixed(2) || 'N/A'}ms`);
  console.log(`Canvas 요소 수: ${result.canvasCount}개`);
  console.log(`측정 지속 시간: ${result.measurementDuration.toFixed(2)}ms`);
}

/**
 * 통계 계산
 */
function calculateStats(results) {
  if (results.length === 0) return null;

  const renderTimes = results.map(r => r.firstPageRenderTime || r.firstPageCanvasTime).filter(v => v != null);
  const tbtValues = results.map(r => r.totalBlockingTime).filter(v => v != null);
  const longTasksValues = results.map(r => r.longTaskCount).filter(v => v != null);
  const fcpValues = results.map(r => r.firstContentfulPaint).filter(v => v != null);
  const lcpValues = results.map(r => r.largestContentfulPaint).filter(v => v != null);

  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const min = (arr) => Math.min(...arr);
  const max = (arr) => Math.max(...arr);

  return {
    firstPageRenderTime: {
      avg: avg(renderTimes),
      min: min(renderTimes),
      max: max(renderTimes),
      count: renderTimes.length
    },
    totalBlockingTime: {
      avg: avg(tbtValues),
      min: min(tbtValues),
      max: max(tbtValues),
      count: tbtValues.length
    },
    longTasks: {
      avg: avg(longTasksValues),
      min: min(longTasksValues),
      max: max(longTasksValues),
      count: longTasksValues.length
    },
    firstContentfulPaint: {
      avg: avg(fcpValues),
      min: min(fcpValues),
      max: max(fcpValues),
      count: fcpValues.length
    },
    largestContentfulPaint: {
      avg: avg(lcpValues),
      min: min(lcpValues),
      max: max(lcpValues),
      count: lcpValues.length
    }
  };
}

/**
 * 메인 실행
 */
async function main() {
  console.log('='.repeat(80));
  console.log('🔬 Simple 75vh + rAF 동시성 제한 테스트');
  console.log('='.repeat(80));
  console.log(`CPU 스로틀링: ${CPU_THROTTLE}x`);
  console.log(`URL당 반복 횟수: ${RUNS_PER_URL}회`);
  console.log(`테스트 버전 수: ${TEST_URLS.length}개`);
  console.log(`동시성 제한 값: ${CONCURRENT_VALUES.join(', ')}`);
  console.log('');

  const allResults = [];

  try {
    for (const testUrl of TEST_URLS) {
      console.log(`\n${'#'.repeat(80)}`);
      console.log(`### ${testUrl.name} ###`);
      console.log(`### ${testUrl.url} ###`);
      console.log(`${'#'.repeat(80)}\n`);

      const urlResults = [];

      for (let run = 1; run <= RUNS_PER_URL; run++) {
        const result = await measurePDFFirstPagePerformance(testUrl.url, testUrl.name, run);
        
        if (result) {
          printResult({ ...result, concurrent: testUrl.concurrent });
          urlResults.push({ ...result, concurrent: testUrl.concurrent, shortName: testUrl.shortName });
          allResults.push({ ...result, concurrent: testUrl.concurrent, shortName: testUrl.shortName });
        }

        if (run < RUNS_PER_URL) {
          console.log(`⏸️  다음 실행까지 3초 대기...\n`);
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }

      // URL별 통계
      if (urlResults.length > 0) {
        const stats = calculateStats(urlResults);
        console.log(`\n${'─'.repeat(70)}`);
        console.log(`📈 ${testUrl.name} - ${urlResults.length}회 실행 통계`);
        console.log(`${'─'.repeat(70)}`);
        console.log(`첫페이지 렌더링 시간: 평균 ${stats.firstPageRenderTime.avg.toFixed(2)}ms (${stats.firstPageRenderTime.min.toFixed(2)} ~ ${stats.firstPageRenderTime.max.toFixed(2)})`);
        console.log(`Total Blocking Time: 평균 ${stats.totalBlockingTime.avg.toFixed(2)}ms (${stats.totalBlockingTime.min.toFixed(2)} ~ ${stats.totalBlockingTime.max.toFixed(2)})`);
        console.log(`Long Tasks: 평균 ${stats.longTasks.avg.toFixed(1)}개 (${stats.longTasks.min} ~ ${stats.longTasks.max})`);
        console.log(`First Contentful Paint: 평균 ${stats.firstContentfulPaint.avg.toFixed(2)}ms (${stats.firstContentfulPaint.min.toFixed(2)} ~ ${stats.firstContentfulPaint.max.toFixed(2)})`);
        console.log(`Largest Contentful Paint: 평균 ${stats.largestContentfulPaint.avg.toFixed(2)}ms (${stats.largestContentfulPaint.min.toFixed(2)} ~ ${stats.largestContentfulPaint.max.toFixed(2)})`);
      }
    }

    // 전체 비교 결과
    console.log(`\n${'='.repeat(80)}`);
    console.log('🏆 동시성 제한 값별 성능 비교 (평균)');
    console.log(`${'='.repeat(80)}\n`);

    const versionStats = {};
    for (const testUrl of TEST_URLS) {
      const versionResults = allResults.filter(r => r.shortName === testUrl.shortName);
      if (versionResults.length > 0) {
        versionStats[testUrl.shortName] = calculateStats(versionResults);
        versionStats[testUrl.shortName].name = testUrl.name;
        versionStats[testUrl.shortName].concurrent = testUrl.concurrent;
      }
    }

    // 첫페이지 렌더링 시간 비교
    console.log('첫페이지 렌더링 시간 (ms):');
    console.log('동시성 제한    평균          최소          최대          측정수');
    console.log('─'.repeat(70));
    Object.values(versionStats)
      .sort((a, b) => a.concurrent - b.concurrent)
      .forEach(stat => {
        const render = stat.firstPageRenderTime;
        console.log(
          `K=${String(stat.concurrent).padEnd(3)}      ` +
          `${render.avg.toFixed(1).padStart(10)}  ` +
          `${render.min.toFixed(1).padStart(10)}  ` +
          `${render.max.toFixed(1).padStart(10)}  ` +
          `${render.count.toString().padStart(6)}`
        );
      });

    console.log('\nTotal Blocking Time (TBT, ms):');
    console.log('동시성 제한    평균          최소          최대          측정수');
    console.log('─'.repeat(70));
    Object.values(versionStats)
      .sort((a, b) => a.concurrent - b.concurrent)
      .forEach(stat => {
        const tbt = stat.totalBlockingTime;
        const status = tbt.avg > 200 ? '❌' : '✅';
        console.log(
          `K=${String(stat.concurrent).padEnd(3)}${status.padStart(6)}  ` +
          `${tbt.avg.toFixed(1).padStart(10)}  ` +
          `${tbt.min.toFixed(1).padStart(10)}  ` +
          `${tbt.max.toFixed(1).padStart(10)}  ` +
          `${tbt.count.toString().padStart(6)}`
        );
      });

    // 결과 저장
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const resultFile = path.join(outDir, `pdf-firstpage-concurrent-test-${timestamp}.json`);
    fs.writeFileSync(
      resultFile,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        config: {
          cpuThrottle: CPU_THROTTLE,
          runsPerUrl: RUNS_PER_URL,
          concurrentValues: CONCURRENT_VALUES
        },
        results: allResults,
        stats: versionStats
      }, null, 2)
    );

    console.log(`\n💾 결과 저장: ${resultFile}`);
    console.log('\n✅ 동시성 제한 테스트 완료!');

  } catch (error) {
    console.error('❌ 테스트 실패:', error);
    process.exit(1);
  }
}

main().catch(console.error);
