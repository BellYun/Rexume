#!/usr/bin/env node
/**
 * PDF 첫페이지 렌더링 - 점진적 개선 성능 측정 벤치마크
 * 
 * 목적:
 * - Simple 버전을 기준으로 점진적 개선 효과 측정
 * - 우선순위 정렬 → 렌더링 스케줄링 → RAF 배칭 → 페인트 안정화
 * 
 * 사용:
 *   node bench/pdf-firstpage-progressive.js
 * 
 * 측정 버전 (점진적 개선):
 * 1. Simple (기준선) - IntersectionObserver만 사용
 * 2. Simple + 우선순위 정렬 - 뷰포트 내/외 우선순위 적용
 * 3. Simple + 우선순위 + 스케줄링 - RenderScheduler 적용 (K=4)
 * 4. Simple + 우선순위 + 스케줄링 + RAF 배칭 - RAF로 배칭 처리
 * 5. Simple + 우선순위 + 스케줄링 + RAF 배칭 + 페인트 안정화 - RAF 페인트 타이밍 최적화
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// ---- 설정 ----
const CPU_THROTTLE = 1; // 스로틀링 없음 (1 = 정상 속도)
const RUNS_PER_URL = 5; // URL당 반복 횟수
const HEADLESS = true;
const BASE_URL = process.env.TEST_URL || 'http://localhost:3000';

// 측정할 URL 목록 (점진적 개선)
const TEST_URLS = [
  {
    url: `${BASE_URL}/feedback/4?version=simple`,
    name: 'Step 1: Simple (기준선)',
    shortName: 'step1-simple',
    description: 'IntersectionObserver만 사용'
  },
  {
    url: `${BASE_URL}/feedback/4?version=simple-priority`,
    name: 'Step 2: Simple + 우선순위',
    shortName: 'step2-priority',
    description: '뷰포트 내/외 우선순위 적용'
  },
  {
    url: `${BASE_URL}/feedback/4?version=simple-priority-scheduler`,
    name: 'Step 3: Simple + 우선순위 + 스케줄링',
    shortName: 'step3-scheduler',
    description: 'RenderScheduler 적용 (K=4)'
  },
  {
    url: `${BASE_URL}/feedback/4?version=simple-priority-scheduler-raf`,
    name: 'Step 4: Simple + 우선순위 + 스케줄링 + RAF',
    shortName: 'step4-raf',
    description: 'RAF 배칭 적용'
  },
  {
    url: `${BASE_URL}/feedback/4?version=simple-priority-scheduler-raf-paint`,
    name: 'Step 5: Simple + 모든 최적화',
    shortName: 'step5-complete',
    description: 'RAF 배칭 + 페인트 안정화'
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
  
  // Docker 환경 감지
  const isDocker = fs.existsSync('/.dockerenv');
  
  const launchOptions = {
    headless: HEADLESS ? 'new' : false,
    defaultViewport: { width: 1920, height: 1080 },
    args: ['--disable-dev-shm-usage', '--no-sandbox', '--crash-dumps-dir=/tmp'],
    protocolTimeout: 120000, // 2분
  };
  
  if (isDocker) {
    // Docker 환경: 시스템 Chromium 사용
    launchOptions.executablePath = '/usr/bin/chromium';
  } else if (fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')) {
    // macOS: 시스템 Chrome 사용
    launchOptions.executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }
  
  const browser = await puppeteer.launch(launchOptions);

  const page = await browser.newPage();
  
  // 타임아웃 설정 (2분)
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

  // 페이지 로드 전 추적 설정
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
        
        // Canvas drawImage 메서드 오버라이드
        const originalDrawImage = element.getContext ? null : null;
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
              
              // 캔버스가 있는지 하위 요소 확인
              const canvases = node.querySelectorAll ? node.querySelectorAll('canvas') : [];
              canvases.forEach(canvas => {
                window.pdfFirstPageTracker.canvasElements.add(canvas);
                console.log('[FirstPage] 하위 캔버스 감지됨');
              });
            }
          });
        });
      });
      
      // DOM이 준비되면 관찰 시작
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
  const navigationStart = Date.now();
  
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

  // PDF 첫페이지 렌더링 완료까지 대기 (최대 30초)
  try {
    await page.waitForFunction(() => {
      // 첫페이지 렌더링이 완료되었거나, 최소한 캔버스가 생성되었는지 확인
      return window.__pdfFirstPageMetrics.firstPageRenderTime !== null || 
             window.__pdfFirstPageMetrics.firstPageCanvasTime !== null ||
             window.pdfFirstPageTracker.canvasElements.size > 0;
    }, { timeout: 30000 });
    
    console.log('   PDF 첫페이지 렌더링 감지됨');
  } catch (error) {
    console.warn('   PDF 첫페이지 렌더링 타임아웃, 추가 대기...');
    // 추가 5초 대기 후 결과 수집
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  // 추가 안정화 대기 (LongTask 및 TBT 측정을 위해)
  console.log('   안정화 대기 중...');
  await new Promise(resolve => setTimeout(resolve, 3000));

  // 결과 수집
  const result = await page.evaluate(() => {
    const navigationTiming = performance.getEntriesByType('navigation')[0];
    const paintTiming = performance.getEntriesByType('paint');
    const fcpPaint = paintTiming.find(p => p.name === 'first-contentful-paint');
    const fpPaint = paintTiming.find(p => p.name === 'first-paint');

    // TBT 계산 (FCP ~ 현재까지의 LongTask 기반)
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
      // 첫페이지 렌더링 시간
      firstPageRenderTime: window.__pdfFirstPageMetrics.firstPageRenderTime,
      firstPageCanvasTime: window.__pdfFirstPageMetrics.firstPageCanvasTime,
      
      // Paint 지표
      firstPaint: fpPaint?.startTime || null,
      firstContentfulPaint: window.__pdfFirstPageMetrics.firstContentfulPaint || fcpPaint?.startTime || null,
      largestContentfulPaint: window.__pdfFirstPageMetrics.largestContentfulPaint || null,
      
      // LongTask 및 TBT
      longTasks: window.__pdfFirstPageMetrics.longTasks,
      totalBlockingTime: tbt,
      longTaskCount: window.__pdfFirstPageMetrics.longTasks.length,
      
      // Navigation Timing
      navigationStart: window.__pdfFirstPageMetrics.navigationStart || navigationTiming?.startTime || 0,
      domContentLoaded: navigationTiming?.domContentLoadedEventEnd - navigationTiming?.fetchStart || null,
      loadComplete: navigationTiming?.loadEventEnd - navigationTiming?.fetchStart || null,
      
      // 추가 메트릭
      canvasCount: window.pdfFirstPageTracker.canvasElements.size,
      measurementDuration: performance.now() - (window.__pdfFirstPageMetrics.startTime || 0),
      
      // Paint Events
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

/**
 * 결과 출력
 */
function printResult(result) {
  console.log(`\n📊 측정 결과 (${result.runNumber}회차): ${result.version}`);
  console.log('='.repeat(70));
  
  // 첫페이지 렌더링 시간
  if (result.firstPageRenderTime !== null) {
    console.log(`첫페이지 렌더링 시간: ${result.firstPageRenderTime.toFixed(2)}ms ✅`);
  } else if (result.firstPageCanvasTime !== null) {
    console.log(`첫캔버스 렌더링 시간: ${result.firstPageCanvasTime.toFixed(2)}ms ✅`);
  } else {
    console.log(`첫페이지 렌더링 시간: 측정 실패 ❌`);
  }
  
  // Paint 지표
  console.log(`First Paint: ${result.firstPaint?.toFixed(2) || 'N/A'}ms`);
  console.log(`First Contentful Paint: ${result.firstContentfulPaint?.toFixed(2) || 'N/A'}ms`);
  console.log(`Largest Contentful Paint: ${result.largestContentfulPaint?.toFixed(2) || 'N/A'}ms`);
  
  // TBT 및 LongTask
  console.log(`Total Blocking Time: ${result.totalBlockingTime.toFixed(2)}ms ${result.totalBlockingTime < 200 ? '✅' : result.totalBlockingTime < 600 ? '⚠️' : '❌'}`);
  console.log(`Long Tasks: ${result.longTaskCount}개`);
  
  if (result.longTasks.length > 0) {
    const avgDuration = result.longTasks.reduce((sum, task) => sum + task.duration, 0) / result.longTasks.length;
    const maxDuration = Math.max(...result.longTasks.map(task => task.duration));
    console.log(`LongTask 평균: ${avgDuration.toFixed(2)}ms, 최대: ${maxDuration.toFixed(2)}ms`);
  }
  
  // Navigation Timing
  console.log(`DOM Content Loaded: ${result.domContentLoaded?.toFixed(2) || 'N/A'}ms`);
  console.log(`Load Complete: ${result.loadComplete?.toFixed(2) || 'N/A'}ms`);
  
  // 추가 정보
  console.log(`Canvas 요소 수: ${result.canvasCount}개`);
  console.log(`측정 지속 시간: ${result.measurementDuration.toFixed(2)}ms`);
}

/**
 * 통계 계산
 */
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
 * 개선률 계산
 */
function calculateImprovement(baseline, current) {
  if (!baseline || baseline === 0) return 0;
  return ((baseline - current) / baseline * 100);
}

/**
 * 메인 실행
 */
(async () => {
  console.log('\n🚀 PDF 첫페이지 렌더링 - 점진적 개선 벤치마크');
  console.log('='.repeat(80));
  console.log(`설정:`);
  console.log(`  - CPU Throttle: ${CPU_THROTTLE}x`);
  console.log(`  - 반복 횟수: ${RUNS_PER_URL}회`);
  console.log(`  - Headless: ${HEADLESS}`);
  console.log(`  - 측정 URL: ${TEST_URLS.length}개 (점진적 개선)`);

  const allResults = {};

  // 각 URL 측정
  for (const { url, name, shortName, description } of TEST_URLS) {
    console.log('\n' + '#'.repeat(80));
    console.log(`### ${name} ###`);
    console.log(`### ${description} ###`);
    console.log(`### ${url}`);
    console.log('#'.repeat(80));

    const urlResults = [];

    for (let run = 1; run <= RUNS_PER_URL; run++) {
      try {
        const result = await measurePDFFirstPagePerformance(url, name, run);
        urlResults.push(result);
        printResult(result);

        // 다음 실행 전 잠시 대기
        if (run < RUNS_PER_URL) {
          console.log('⏸️  다음 실행까지 3초 대기...\n');
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      } catch (error) {
        console.error(`❌ ${name} ${run}회차 측정 실패:`, error.message);
        // 실패해도 계속 진행
      }
    }

    allResults[shortName] = {
      name: name,
      url: url,
      shortName: shortName,
      description: description,
      results: urlResults,
    };

    // URL별 통계 출력
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

  // 전체 비교 분석
  console.log('\n\n' + '='.repeat(80));
  console.log('🏆 점진적 개선 성능 비교 (평균)');
  console.log('='.repeat(80));

  const comparisonData = [];
  for (const [shortName, data] of Object.entries(allResults)) {
    const stats = calculateStatistics(data.results);
    if (stats) {
      comparisonData.push({
        name: data.name,
        shortName: shortName,
        description: data.description,
        stats: stats,
      });
    }
  }

  if (comparisonData.length > 0) {
    // 기준선 (Simple) 값
    const baseline = comparisonData[0]?.stats;
    
    console.log('\n📊 첫페이지 렌더링 시간 (ms):');
    console.log('단계'.padEnd(35) + '평균'.padEnd(12) + '개선률'.padEnd(12) + 'TBT'.padEnd(12) + 'TBT 개선률');
    console.log('-'.repeat(80));
    
    comparisonData.forEach((data, index) => {
      const { name, stats, description } = data;
      const avg = stats.firstPageRenderTime.avg.toFixed(1);
      const tbtAvg = stats.totalBlockingTime.avg.toFixed(0);
      
      const improvement = index === 0 
        ? '-'
        : `${calculateImprovement(baseline.firstPageRenderTime.avg, stats.firstPageRenderTime.avg).toFixed(1)}%`;
      
      const tbtImprovement = index === 0
        ? '-'
        : `${calculateImprovement(baseline.totalBlockingTime.avg, stats.totalBlockingTime.avg).toFixed(1)}%`;
      
      const stepInfo = `${name.split(':')[0]}`;
      console.log(stepInfo.padEnd(35) + avg.padEnd(12) + improvement.padEnd(12) + tbtAvg.padEnd(12) + tbtImprovement);
    });

    console.log('\n📝 적용 기술:');
    comparisonData.forEach((data, index) => {
      console.log(`  ${index + 1}. ${data.name.split(':')[1]?.trim() || data.name}`);
      console.log(`     ${data.description}`);
    });

    console.log('\n💡 개선 효과 요약:');
    if (comparisonData.length > 1) {
      const finalStats = comparisonData[comparisonData.length - 1].stats;
      const renderImprovement = calculateImprovement(baseline.firstPageRenderTime.avg, finalStats.firstPageRenderTime.avg);
      const tbtImprovement = calculateImprovement(baseline.totalBlockingTime.avg, finalStats.totalBlockingTime.avg);
      
      console.log(`  • 첫페이지 렌더링 시간: ${baseline.firstPageRenderTime.avg.toFixed(1)}ms → ${finalStats.firstPageRenderTime.avg.toFixed(1)}ms (${renderImprovement >= 0 ? '↓' : '↑'} ${Math.abs(renderImprovement).toFixed(1)}%)`);
      console.log(`  • Total Blocking Time: ${baseline.totalBlockingTime.avg.toFixed(0)}ms → ${finalStats.totalBlockingTime.avg.toFixed(0)}ms (${tbtImprovement >= 0 ? '↓' : '↑'} ${Math.abs(tbtImprovement).toFixed(1)}%)`);
      console.log(`  • Long Tasks: ${baseline.longTaskCount.avg.toFixed(1)}개 → ${finalStats.longTaskCount.avg.toFixed(1)}개`);
    }
  }

  // 결과 저장
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = path.join(outDir, `pdf-progressive-${timestamp}.json`);
  
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
        description: data.description,
        ...stats,
      };
    }
  }

  fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2));
  console.log(`\n💾 결과 저장: ${outputPath}`);
  console.log('\n✅ 점진적 개선 벤치마크 완료!\n');

})().catch((e) => {
  console.error('❌ 오류 발생:', e);
  process.exit(1);
});

