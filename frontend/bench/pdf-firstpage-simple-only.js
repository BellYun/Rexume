#!/usr/bin/env node
const path = require('path');
const { runBenchmark } = require('./pdf-firstpage-performance');

(async () => {
  await runBenchmark(
    [
      {
        url: 'http://nextjs:3000/feedback/4?version=simple-notrack',
        name: 'Simple (No Track)',
        shortName: 'simple-notrack',
      },
      {
        url: 'http://nextjs:3000/feedback/4?version=simple-75vh-raf-paint',
        name: 'Simple 75vh + rAF',
        shortName: 'simple-75vh-raf-paint',
      },
    ],
    {
      label: 'simple-only',
      outputSubdir: path.join('results', 'simple-only'),
    }
  );
})();
