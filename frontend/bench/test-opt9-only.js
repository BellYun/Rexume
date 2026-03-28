#!/usr/bin/env node
const puppeteer = require('puppeteer');
const fs = require('fs');

const CPU_THROTTLE = 1;
const RUNS = 3;
const BASE_URL = process.env.TEST_URL || 'http://localhost:3000';

const TEST_URL = {
  url: `${BASE_URL}/feedback/4?version=opt9-raf-nopaint`,
  name: 'Opt9: RAF 페인트 제거',
};

async function measurePerformance(testUrl, runNumber) {
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
  
  if (CPU_THROTTLE > 1) {
    const client = await page.target().createCDPSession();
    await client.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
  }

  await page.goto(testUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  
  await page.evaluate(() => {
    return new Promise((resolve) => {
      const checkCanvas = () => {
        const canvasElements = document.querySelectorAll('canvas');
        if (canvasElements.length > 0) {
          resolve();
        } else {
          requestAnimationFrame(checkCanvas);
        }
      };
      checkCanvas();
    });
  });

  await new Promise(r => setTimeout(r, 3000));

  const metrics = await page.evaluate(() => {
    const perfMetrics = performance.getEntriesByType('paint');
    const navTiming = performance.getEntriesByType('navigation')[0];
    const firstPaint = perfMetrics.find(m => m.name === 'first-paint');
    const fcp = perfMetrics.find(m => m.name === 'first-contentful-paint');
    
    const longTasks = performance.getEntriesByType('longtask') || [];
    let tbt = 0;
    longTasks.forEach(task => {
      const blockingTime = task.duration - 50;
      if (blockingTime > 0) tbt += blockingTime;
    });

    const canvasCount = document.querySelectorAll('canvas').length;

    return {
      firstPaint: firstPaint ? firstPaint.startTime : null,
      fcp: fcp ? fcp.startTime : null,
      tbt,
      longTaskCount: longTasks.length,
      canvasCount,
      domContentLoaded: navTiming ? navTiming.domContentLoadedEventEnd - navTiming.fetchStart : null,
    };
  });

  await browser.close();
  
  console.log(`\n📊 측정 결과 (${runNumber}회차): ${TEST_URL.name}`);
  console.log('======================================================================');
  console.log(`First Paint: ${metrics.firstPaint ? metrics.firstPaint.toFixed(2) : 'N/A'}ms`);
  console.log(`First Contentful Paint: ${metrics.fcp ? metrics.fcp.toFixed(2) : 'N/A'}ms`);
  console.log(`Total Blocking Time: ${metrics.tbt.toFixed(2)}ms ${metrics.tbt < 200 ? '✅' : '⚠️'}`);
  console.log(`Long Tasks: ${metrics.longTaskCount}개`);
  console.log(`Canvas 요소 수: ${metrics.canvasCount}개`);
  console.log(`DOM Content Loaded: ${metrics.domContentLoaded ? metrics.domContentLoaded.toFixed(2) : 'N/A'}ms`);
  
  return metrics;
}

(async () => {
  console.log('\n🚀 Opt9 단독 테스트');
  console.log('================================================================================');
  console.log(`설정:`);
  console.log(`  - CPU Throttle: ${CPU_THROTTLE}x`);
  console.log(`  - 반복 횟수: ${RUNS}회`);
  console.log(`\n### ${TEST_URL.name} ###`);
  console.log(`### ${TEST_URL.url}\n`);
  
  const results = [];
  for (let i = 1; i <= RUNS; i++) {
    const result = await measurePerformance(TEST_URL.url, i);
    results.push(result);
    if (i < RUNS) {
      console.log('⏸️  다음 실행까지 3초 대기...\n');
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  
  const avgTbt = results.reduce((s, r) => s + r.tbt, 0) / results.length;
  const avgFcp = results.reduce((s, r) => s + (r.fcp || 0), 0) / results.length;
  
  console.log(`\n──────────────────────────────────────────────────────────────────────`);
  console.log(`📈 ${TEST_URL.name} - ${RUNS}회 실행 통계`);
  console.log(`──────────────────────────────────────────────────────────────────────`);
  console.log(`Total Blocking Time: 평균 ${avgTbt.toFixed(2)}ms`);
  console.log(`First Contentful Paint: 평균 ${avgFcp.toFixed(2)}ms`);
  console.log(`Canvas 요소: ${results[0].canvasCount}개\n`);
  console.log(`✅ Opt9 테스트 완료!\n`);
})();

