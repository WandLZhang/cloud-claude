// Pastes through Chromium's real clipboard into the chat input and checks what lands.
// Run against the dev server in test mode (skips sign-in):
//   REACT_APP_TEST_MODE=true PORT=3099 BROWSER=none npx react-scripts start
//   node test_scripts/test-paste-image.js
const { chromium } = require('@playwright/test');

const APP_URL = process.env.APP_URL || 'http://localhost:3099/';
const MAX_IMAGE_BYTES = 3750000; // ChatInput's limit; Claude rejects base64 over 5 MiB

// Each case puts one clipboard shape on the clipboard, presses Ctrl+V in the textarea, and
// states what should show: an image preview (of what type), the textarea text, or both.
// `noise` draws random pixels, which PNG can't compress: a large screenshot stand-in.
const CASES = [
  { name: 'image only (screenshot)', image: true, expectPreview: 'image/png', expectText: '' },
  { name: 'text only', text: '你好 paste test', expectPreview: null, expectText: '你好 paste test' },
  { name: 'image + html (Chrome "Copy image")', image: true, html: '<img src="https://example.com/a.png">', expectPreview: 'image/png', expectText: '' },
  { name: 'image + text (Office selection, Firefox "Copy Image")', image: true, text: 'Q3 totals', expectPreview: 'image/png', expectText: 'Q3 totals' },
  { name: 'large screenshot (2400x1600 noise PNG)', image: true, noise: [2400, 1600], expectPreview: 'image/jpeg', expectText: '' },
];

function dataUrlBytes(src) {
  const b64 = src.split(',')[1] || '';
  return Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
}

async function runCase(browser, c) {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.text().includes('[ChatInput]')) console.log(`    console: ${m.text()}`);
  });
  await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('textarea.chat-input', { timeout: 15000 });

  const pastedBytes = await page.evaluate(async ({ image, noise, text, html }) => {
    const parts = {};
    let size = 0;
    if (image) {
      const [w, h] = noise || [40, 40];
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (noise) {
        const img = ctx.createImageData(w, h);
        for (let i = 0; i < img.data.length; i += 4) {
          img.data[i] = Math.random() * 256;
          img.data[i + 1] = Math.random() * 256;
          img.data[i + 2] = Math.random() * 256;
          img.data[i + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
      } else {
        ctx.fillStyle = '#d93025';
        ctx.fillRect(0, 0, w, h);
      }
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      size = blob.size;
      parts['image/png'] = blob;
    }
    if (text) parts['text/plain'] = new Blob([text], { type: 'text/plain' });
    if (html) parts['text/html'] = new Blob([html], { type: 'text/html' });
    await navigator.clipboard.write([new ClipboardItem(parts)]);
    return size;
  }, c);

  await page.click('textarea.chat-input');
  await page.keyboard.press('Control+V');
  // FileReader (and for big images, the JPEG re-encode) runs before the preview appears.
  await page.waitForSelector('img[alt="Selected"]', { timeout: c.expectPreview ? 15000 : 1000 }).catch(() => null);

  const preview = await page.$('img[alt="Selected"]');
  const src = preview ? await preview.getAttribute('src') : null;
  const text = await page.inputValue('textarea.chat-input');
  const bytes = src ? dataUrlBytes(src) : 0;
  const previewOk = c.expectPreview
    ? !!src && src.startsWith(`data:${c.expectPreview}`) && bytes <= MAX_IMAGE_BYTES
    : !preview;
  const ok = previewOk && text === c.expectText;
  const pasted = pastedBytes ? ` pasted ${(pastedBytes / 1e6).toFixed(2)} MB ->` : '';
  const shown = src ? `${src.slice(5, src.indexOf(';'))} ${(bytes / 1e6).toFixed(2)} MB` : 'none';
  console.log(`${ok ? 'PASS' : 'FAIL'} ${c.name}:${pasted} preview=${shown} textarea=${JSON.stringify(text)}`);
  await context.close();
  return ok;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  for (const c of CASES) {
    if (!(await runCase(browser, c))) failed++;
  }
  await browser.close();
  console.log(failed ? `${failed} of ${CASES.length} cases failed` : `all ${CASES.length} cases passed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
