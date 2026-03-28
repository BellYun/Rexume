#!/usr/bin/env node
/**
 * PDF 첫페이지 렌더링 성능 벤치마크 - 그룹2 (Playwright)
 * 최적화 4,5,6,7 + 기준선
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ---- 설정 ----
const CPU_THROTTLE = 4;
const RUNS_PER_URL = 3;
const HEADLESS = true;

// 그룹2: 최적화 4,5,6,7 + 기준선
const TEST_URLS = [
  {
    url: 'http://localhost:3000/feedback-basic/4',
    name: 'Basic (개선 전)',
    shortName: 'basic'
  },
  {
    url: 'http://localhost:3000/feedback/4?version=opt4-scheduler',
    name: 'Opt4: RenderScheduler (K=4)',
    shortName: 'opt4-scheduler'
  },
  {
    url: 'http://localhost:3000/feedback/4?version=opt5-raf-batching',
    name: 'Opt5: RAF 배칭',
    shortName: 'opt5-raf-batching'
  },
  {
    url: 'http://localhost:3000/feedback/4?version=opt6-priority',
    name: 'Opt6: 우선순위 정렬',
    shortName: 'opt6-priority'
  },
  {
    url: 'http://localhost:3000/feedback/4?version=opt7-all-scheduling',
    name: 'Opt7: 전체 스케줄링',
    shortName: 'opt7-all-scheduling'
  }
];

const benchDir = __dirname;
const outDir = path.join(benchDir, 'results');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

async function measurePDFFirstPagePerformance(testUrl, versionName, runNumber = 1) {
  console.log(`\n📊 측정 시작 (${runNumber}회차): ${versionName}`);
  console.log(`   URL: ${testUrl}`);
  
  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--disable-dev-shm-usage', '--no-sandbox'],
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
  });

  const page = await context.newPage();

  // CDP 세션 생성 및 CPU throttling 적용
  const client = await context.newCDPSession(page);
  await client.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
  console.log(`   CPU ${CPU_THROTTLE}x throttling 적용`);

  // 콘솔 로그 포워딩
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('[PDFTrace]') || text.includes('[LongTask]') || text.includes('[FirstPage]')) {
      console.log(`   ${text}`);
    }
  });

  // 페이지 로드 전 추적 설정
  await page.addInitScript(() => {
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

    if (window.MutationObserver) {
      const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              if (node.tagName === 'CANVAS') {
                window.pdfFirstPageTracker.canvasElements.add(node);
              }
              
              const canvases = node.querySelectorAll ? node.querySelectorAll('canvas') : [];
              canvases.forEach(canvas => {
                window.pdfFirstPageTracker.canvasElements.add(canvas);
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
    waitUntil: 'domcontentloaded',
    timeout: 120000
  });

  console.log('   페이지 로드 완료, PDF 첫페이지 렌더링 대기...');
  
  await page.evaluate(() => {
    window.__pdfFirstPageMetrics.startTime = performance.now();
    window.__pdfFirstPageMetrics.navigationStart = performance.timing.navigationStart || performance.now();
  });

  // PDF 첫페이지 렌더링 완료까지 대기 (최대 30초)
  try {
    await page.waitForFunction(() => {
      return window.__pdfFirstPageMetrics.firstPageRenderTime !== null || 
             window.__pdfFirstPageMetrics.firstPageCanvasTime !== null ||
             window.pdfFirstPageTracker.canvasElements.size > 0;
    }, { timeout: 30000 });
    
    console.log('   PDF 첫페이지 렌더링 감지됨');
  } catch (error) {
    console.warn('   PDF 첫페이지 렌더링 타임아웃, 추가 대기...');
    await page.waitForTimeout(5000);
  }

  // 추가 안정화 대기 (LongTask 및 TBT 측정을 위해)
  console.log('   안정화 대기 중...');
  await page.waitForTimeout(3000);

  // 결과 수집
  const result = await page.evaluate(() => {
    const navigationTiming = performance.getEntriesByType('navigation')[0];
    const paintTiming = performance.getEntriesByType('paint');
    const fcpPaint = paintTiming.find(p => p.name === 'first-contentful-paint');
    const fpPaint = paintTiming.find(p => p.name === 'first-paint');

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

    return {
      firstPageRenderTime: window.__pdfFirstPageMetrics.firstPageRenderTime,
      firstPageCanvasTime: window.__pdfFirstPageMetrics.firstPageCanvasTime,
      firstPaint: fpPaint?.startTime || null,
      firstContentfulPaint: window.__pdfFirstPageMetrics.firstContentfulPaint || fcpPaint?.startTime || null,
      largestContentfulPaint: window.__pdfFirstPageMetrics.largestContentfulPaint || null,
      longTasks: window.__pdfFirstPageMetrics.longTasks,
      totalBlockingTime: tbt,
      longTaskCount: window.__pdfFirstPageMetrics.longTasks.length,
      navigationStart: window.__pdfFirstPageMetrics.navigationStart || navigationTiming?.startTime || 0,
      domContentLoaded: navigationTiming?.domContentLoadedEventEnd - navigationTiming?.fetchStart || null,
      loadComplete: navigationTiming?.loadEventEnd - navigationTiming?.fetchStart || null,
      canvasCount: window.pdfFirstPageTracker.canvasElements.size,
      measurementDuration: performance.now() - (window.__pdfFirstPageMetrics.startTime || 0),
      paintEvents: window.__pdfFirstPageMetrics.paintEvents,
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

function printResult(result) {
  console.log(`\n📊 측정 결과 (${result.runNumber}회차): ${result.version}`);
  console.log('='.repeat(70));
  
  if (result.firstPageRenderTime !== null) {
    console.log(`첫페이지 렌더링 시간: ${result.firstPageRenderTime.toFixed(2)}ms ✅`);
  } else if (result.firstPageCanvasTime !== null) {
    console.log(`첫캔버스 렌더링 시간: ${result.firstPageCanvasTime.toFixed(2)}ms ✅`);
  } else {
    console.log(`첫페이지 렌더링 시간: 측정 실패 ❌`);
  }
  
  console.log(`First Paint: ${result.firstPaint?.toFixed(2) || 'N/A'}ms`);
  console.log(`First Contentful Paint: ${result.firstContentfulPaint?.toFixed(2) || 'N/A'}ms`);
  console.log(`Largest Contentful Paint: ${result.largestContentfulPaint?.toFixed(2) || 'N/A'}ms`);
  console.log(`Total Blocking Time: ${result.totalBlockingTime.toFixed(2)}ms ${result.totalBlockingTime < 200 ? '✅' : result.totalBlockingTime < 600 ? '⚠️' : '❌'}`);
  console.log(`Long Tasks: ${result.longTaskCount}개`);
  
  if (result.longTasks.length > 0) {
    const avgDuration = result.longTasks.reduce((sum, task) => sum + task.duration, 0) / result.longTasks.length;
    const maxDuration = Math.max(...result.longTasks.map(task => task.duration));
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

(async () => {
  console.log('\n🚀 PDF 첫페이지 렌더링 성능 벤치마크 - 그룹2 (Playwright)');
  console.log('='.repeat(80));
  console.log(`설정:`);
  console.log(`  - CPU Throttle: ${CPU_THROTTLE}x`);
  console.log(`  - 반복 횟수: ${RUNS_PER_URL}회`);
  console.log(`  - Headless: ${HEADLESS}`);
  console.log(`  - 측정 URL: ${TEST_URLS.length}개`);

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
          console.log('⏸️  다음 실행까지 5초 대기...\n');
          await new Promise(resolve => setTimeout(resolve, 5000));
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

    // 각 URL 테스트 후 10초 대기
    console.log('\n💤 브라우저 정리 대기 (10초)...\n');
    await new Promise(resolve => setTimeout(resolve, 10000));
  }

  console.log('\n\n' + '='.repeat(80));
  console.log('🏆 버전별 성능 비교 (평균)');
  console.log('='.repeat(80));

  const comparisonData = [];
  for (const [shortName, data] of Object.entries(allResults)) {
    const stats = calculateStatistics(data.results);
    if (stats) {
      comparisonData.push({
        name: data.name,
        shortName: shortName,
        stats: stats,
      });
    }
  }

  if (comparisonData.length > 0) {
    console.log('\n첫페이지 렌더링 시간 (ms):');
    console.log('버전'.padEnd(35) + '평균'.padEnd(12) + '최소'.padEnd(12) + '최대'.padEnd(12) + '측정수');
    console.log('-'.repeat(80));
    
    comparisonData.forEach(data => {
      const { name, stats } = data;
      const avg = stats.firstPageRenderTime.avg.toFixed(1);
      const min = stats.firstPageRenderTime.min.toFixed(1);
      const max = stats.firstPageRenderTime.max.toFixed(1);
      console.log(name.padEnd(35) + avg.padEnd(12) + min.padEnd(12) + max.padEnd(12) + stats.count.toString());
    });

    console.log('\nTotal Blocking Time (TBT, ms):');
    console.log('버전'.padEnd(35) + '평균'.padEnd(12) + '최소'.padEnd(12) + '최대'.padEnd(12) + '측정수');
    console.log('-'.repeat(80));
    
    comparisonData.forEach(data => {
      const { name, stats } = data;
      const avg = stats.totalBlockingTime.avg.toFixed(0);
      const min = stats.totalBlockingTime.min.toFixed(0);
      const max = stats.totalBlockingTime.max.toFixed(0);
      const quality = stats.totalBlockingTime.avg < 200 ? '✅' : stats.totalBlockingTime.avg < 600 ? '⚠️' : '❌';
      console.log((name + ' ' + quality).padEnd(35) + avg.padEnd(12) + min.padEnd(12) + max.padEnd(12) + stats.count.toString());
    });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = path.join(outDir, `pdf-firstpage-group2-playwright-${timestamp}.json`);
  
  const summary = {
    timestamp: new Date().toISOString(),
    engine: 'playwright',
    group: 'group2',
    description: '최적화 4,5,6,7 + 기준선',
    config: {
      cpuThrottle: CPU_THROTTLE,
      runsPerUrl: RUNS_PER_URL,
      headless: HEADLESS,
      testUrls: TEST_URLS,
    },
    results: allResults,
    statistics: {},
  };

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
  console.log('\n✅ 그룹2 벤치마크 완료!\n');

})().catch((e) => {
  console.error('❌ 오류 발생:', e);
  process.exit(1);
});

