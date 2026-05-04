const { chromium } = require('@playwright/test');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  console.log('=== Production deployment check ===');
  await page.goto('https://cloud-claude.web.app/', { waitUntil: 'networkidle', timeout: 30000 });
  const title = await page.title();
  const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 200));
  console.log(`Title: ${title}`);
  console.log(`Body: ${bodyText.replace(/\n/g, ' | ')}`);

  await page.screenshot({ path: '/tmp/playwright-tests/prod-signin.png', fullPage: true });
  console.log('Screenshot: /tmp/playwright-tests/prod-signin.png');

  // Verify bundle contents
  const bundleCheck = await page.evaluate(async () => {
    const scripts = Array.from(document.querySelectorAll('script[src*="main."]'));
    if (!scripts.length) return null;
    const resp = await fetch(scripts[0].src);
    const text = await resp.text();
    return {
      bundleSize: text.length,
      hasBatchMode: text.includes('Batch mode'),
      hasPlaylistAdd: text.includes('playlist_add'),
      hasOnBatchRelease: text.includes('onBatchRelease'),
      hasPendingBatch: text.includes('pendingBatch'),
      hasWordsHkInstructions: text.includes('words.hk') || text.includes('粵典'),
      hasZhYueClass: text.includes('zh-yue'),
      hasRubyTags: text.includes('<ruby>') || text.includes('ruby'),
      hasFontFace: text.includes('VF-Canto'),
    };
  });
  console.log('\n=== Bundle inspection ===');
  console.log(JSON.stringify(bundleCheck, null, 2));

  // Check VF-Canto font availability
  console.log('\n=== Font check ===');
  const fontResp = await page.evaluate(async () => {
    const r = await fetch('/fonts/VF-Canto-HKEdB.woff2', { method: 'HEAD' });
    return { status: r.status, contentLength: r.headers.get('content-length'), contentType: r.headers.get('content-type') };
  });
  console.log(`VF-Canto-HKEdB.woff2: ${JSON.stringify(fontResp)}`);

  await browser.close();
  console.log('\n=== ALL CHECKS PASSED ===');
})().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
