const { chromium } = require('@playwright/test');
const fs = require('fs');

(async () => {
  fs.mkdirSync('/tmp/playwright-tests', { recursive: true });
  const browser = await chromium.launch({ headless: true });

  for (const width of [320, 360, 375]) {
    const context = await browser.newContext({ viewport: { width, height: 700 } });
    const page = await context.newPage();

    await page.goto('http://localhost:3099/', { waitUntil: 'networkidle', timeout: 15000 });

    // Screenshot the base state
    await page.screenshot({ path: `/tmp/playwright-tests/base-${width}.png` });

    // Enable batch mode by clicking the playlist_add button
    const batchBtn = await page.$('button[aria-label="Toggle batch mode"]');
    if (!batchBtn) {
      console.log(`[${width}px] No batch button found`);
      await context.close();
      continue;
    }
    await batchBtn.click();
    await page.waitForTimeout(300);

    // Simulate 6 queued items by injecting them via React state
    // We'll use page.evaluate to directly manipulate the batch queue
    await page.evaluate(() => {
      // Find the React fiber to set batch state — or just simulate by
      // creating fake queue DOM elements to test layout
      const queueContainer = document.querySelector('.input-wrapper');
      if (!queueContainer) return;

      // Create a fake batch queue display
      const batchDiv = document.createElement('div');
      batchDiv.style.cssText = 'margin-bottom:4px;padding:4px 8px;border-radius:8px;background:var(--surface-container-low);border:1px solid var(--outline-variant);max-height:100px;overflow-y:auto;';

      const header = document.createElement('div');
      header.style.cssText = 'font-size:11px;color:var(--on-surface-variant);margin-bottom:4px;display:flex;justify-content:space-between;';
      header.innerHTML = '<span>8 queued</span><span style="font-style:italic">Tap batch to release</span>';
      batchDiv.appendChild(header);

      const strip = document.createElement('div');
      strip.style.cssText = 'display:flex;gap:4px;overflow-x:auto;padding-bottom:2px;';

      for (let i = 0; i < 8; i++) {
        const thumb = document.createElement('div');
        thumb.style.cssText = 'flex-shrink:0;width:56px;height:56px;border-radius:8px;border:1px solid var(--outline-variant);background:var(--surface);display:flex;align-items:center;justify-content:center;';
        thumb.textContent = `${i+1}`;
        strip.appendChild(thumb);
      }
      batchDiv.appendChild(strip);

      // Insert before the flex input row
      const form = queueContainer;
      const flexRow = form.querySelector('.flex');
      if (flexRow) {
        form.insertBefore(batchDiv, flexRow);
      }
    });

    await page.waitForTimeout(200);
    await page.screenshot({ path: `/tmp/playwright-tests/batch-${width}.png` });

    // Now measure the input row
    const metrics = await page.evaluate(() => {
      const flexRow = document.querySelector('.input-wrapper .flex');
      if (!flexRow) return { error: 'no flex row' };

      const buttons = Array.from(flexRow.querySelectorAll('button'));
      const textarea = flexRow.querySelector('textarea');
      const vw = window.innerWidth;
      const formRect = flexRow.closest('form')?.getBoundingClientRect();

      return {
        viewport: vw,
        formWidth: formRect ? Math.round(formRect.width) : null,
        flexScrollWidth: flexRow.scrollWidth,
        flexClientWidth: flexRow.clientWidth,
        overflows: flexRow.scrollWidth > flexRow.clientWidth,
        textareaWidth: textarea ? Math.round(textarea.getBoundingClientRect().width) : null,
        textareaMinWidth: textarea ? getComputedStyle(textarea).minWidth : null,
        buttonCount: buttons.length,
        buttons: buttons.map(b => ({
          label: b.getAttribute('aria-label') || b.textContent?.trim().substring(0, 15),
          right: Math.round(b.getBoundingClientRect().right),
          visible: b.getBoundingClientRect().right <= vw,
          width: Math.round(b.getBoundingClientRect().width),
        })),
      };
    });

    console.log(`\n[${width}px] form=${metrics.formWidth} flexScroll=${metrics.flexScrollWidth} flexClient=${metrics.flexClientWidth} overflows=${metrics.overflows}`);
    console.log(`  textarea: ${metrics.textareaWidth}px minWidth=${metrics.textareaMinWidth}`);
    metrics.buttons?.forEach(b => {
      console.log(`  ${b.label}: w=${b.width} right=${b.right} visible=${b.visible}`);
    });

    await context.close();
  }

  await browser.close();
  console.log('\nDone. Screenshots in /tmp/playwright-tests/');
})().catch(err => { console.error(err); process.exit(1); });
