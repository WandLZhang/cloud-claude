// The UI end to end, signed in as the throwaway user (mint the session first; see test-navigation.js):
// instant send with a photo, the elapsed status, the latest reply's footer (thinking, Copy, Retry,
// model), code blocks, headings, tables, Retry, the sidebar's top row and Ctrl+K, a cold load and a
// reopen (no light frame, spinner or entrance animation; the chat whole and at the bottom),
// dark-mode menus, then the phone header and layout. Three real Claude replies; screenshots go to
// /tmp/cloud-claude-e2e/.
//   NODE_PATH=$PWD/node_modules node test_scripts/test-ui.js
const { chromium } = require('@playwright/test');
const fs = require('fs');

const APP = process.env.APP_URL || 'https://cloud-claude.web.app';
const OUT = '/tmp/cloud-claude-e2e';
const session = JSON.parse(fs.readFileSync(`${OUT}/session.json`, 'utf8'));
const MARKDOWN_PROMPT = 'Answer in markdown only: a level-2 heading "Greetings", one sentence, a 3-row table with columns '
  + 'Cantonese, Jyutping, English, and a 3-line Python code block that prints them.';
const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(detail)}`);
};

async function signedIn(browser, options) {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], ...options });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`    PAGEERROR: ${e.message}`));
  await page.goto(`${APP}/`, { waitUntil: 'load' });
  await page.evaluate(async ({ apiKey, user }) => {
    localStorage.setItem('theme', 'light');
    await new Promise((resolve, reject) => {
      const open = indexedDB.open('firebaseLocalStorageDb', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('firebaseLocalStorage', { keyPath: 'fbase_key' });
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction('firebaseLocalStorage', 'readwrite');
        tx.objectStore('firebaseLocalStorage').put({ fbase_key: `firebase:authUser:${apiKey}:[DEFAULT]`, value: user });
        tx.oncomplete = () => { open.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, { apiKey: session.apiKey, user: session.user });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('textarea.chat-input', { timeout: 30000 });
  await page.waitForTimeout(1500);
  return { context, page };
}

// Runs in the page before its scripts: records each animation frame for the load checks.
const recordFrames = () => {
  window.__frames = [];
  const tick = () => {
    if (document.body) {
      const mc = document.querySelector('.messages-container');
      window.__frames.push({
        t: Math.round(performance.now()),
        theme: document.body.className,
        spinnerShown: Array.from(document.querySelectorAll('.loading-spinner')).some((s) => Number(getComputedStyle(s).opacity) > 0.05),
        entrance: document.getAnimations().filter((a) => a.playState === 'running' && ['messageSlide', 'fadeIn'].includes(a.animationName)).length,
        sidebarEmpty: !!document.querySelector('.chat-sidebar .empty-state'),
        chat: !!document.querySelector('.chat-container'),
        msgs: document.querySelectorAll('.message').length,
        gapToBottom: mc ? Math.round(mc.scrollHeight - mc.scrollTop - mc.clientHeight) : null,
      });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

// Wait until the last reply has finished (its footer shows); returns the reply count.
async function waitForLatestReply(page, timeoutMs = 180000) {
  await page.waitForSelector('.message-assistant:last-child .reply-footer, .message-assistant .reply-footer', { timeout: timeoutMs });
  await page.waitForTimeout(800);
  return page.locator('.message-assistant').count();
}

// A noisy PNG, large enough that its upload takes a noticeable moment.
function noisePng(page) {
  return page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1600;
    canvas.height = 1000;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(canvas.width, canvas.height);
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = Math.random() * 256; img.data[i + 1] = Math.random() * 256; img.data[i + 2] = Math.random() * 256; img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true });

  // ---------- desktop ----------
  let { context, page } = await signedIn(browser, { viewport: { width: 1280, height: 900 } });
  const desktop = await page.evaluate(() => ({
    floatingToggle: !!document.querySelector('.sidebar-toggle'),
    headerShown: getComputedStyle(document.querySelector('.mobile-header')).display !== 'none',
    topRow: ['New chat', 'Starred chats'].map((l) => !!document.querySelector(`.sidebar-top button[aria-label="${l}"]`)),
    bottomButton: !!document.querySelector('.sidebar-bottom'),
  }));
  check('desktop has no phone header and no floating menu button', !desktop.floatingToggle && !desktop.headerShown, desktop);
  check('sidebar top row has New chat and Starred; the bottom button is gone', desktop.topRow.every(Boolean) && !desktop.bottomButton, desktop);
  await page.keyboard.press('Control+K');
  check('Ctrl+K focuses search', await page.evaluate(() => document.activeElement?.classList.contains('search-input')), {});
  await page.keyboard.press('Escape');
  await page.click('textarea.chat-input');

  // Instant send with a photo: the message shows before the upload finishes.
  const png = await noisePng(page);
  await page.setInputFiles('input[type="file"][accept*="pdf"]', { name: 'noise.png', mimeType: 'image/png', buffer: Buffer.from(png) });
  await page.waitForSelector('img[alt="Selected"]', { timeout: 15000 });
  await page.fill('textarea.chat-input', 'Describe this image in one short sentence.');
  const t0 = Date.now();
  await page.keyboard.press('Enter');
  await page.waitForSelector('.message-user img', { timeout: 10000 });
  const shownMs = Date.now() - t0;
  const firstSrc = await page.getAttribute('.message-user img', 'src');
  await page.waitForFunction(() => (document.querySelector('.message-user img')?.getAttribute('src') || '').startsWith('https://'), null, { timeout: 60000 });
  const savedMs = Date.now() - t0;
  check('a photo message shows at once, before its upload finishes', shownMs < 1000 && firstSrc.startsWith('data:') && savedMs > shownMs,
    { shownMs, savedMs, shownFrom: firstSrc.slice(0, 22) });

  let elapsedLine = null;
  for (let i = 0; i < 40 && !elapsedLine; i++) {
    elapsedLine = await page.evaluate(() => {
      const t = document.querySelector('.message-assistant .typing-text, .message-assistant .retry-indicator')?.textContent || '';
      return t.includes(' · ') && t.trim().endsWith('s') ? t : null;
    });
    if (!elapsedLine) await page.waitForTimeout(250);
  }
  check('the status line shows elapsed time', !!elapsedLine, { elapsedLine });

  await waitForLatestReply(page);
  const footer = await page.evaluate(() => {
    const f = document.querySelector('.message-assistant .reply-footer');
    return f && {
      buttons: Array.from(f.querySelectorAll('button')).map((b) => b.textContent.replace(/\s+/g, ' ').trim()),
      model: f.querySelector('.reply-model')?.textContent || null,
    };
  });
  check('the latest reply has a footer with thinking, Copy, Retry and the model',
    !!footer && footer.buttons.some((b) => b.includes('Thought for')) && footer.buttons.some((b) => b.includes('Copy'))
    && footer.buttons.some((b) => b.includes('Retry')) && !!footer.model, footer);

  await page.locator('.reply-footer button', { hasText: 'Thought for' }).click();
  const thinking = await page.evaluate(() => document.querySelector('.thinking-text')?.innerText || '');
  check('"Thought for N s" opens the thinking', thinking.length > 20, { chars: thinking.length });

  await page.locator('.reply-footer button', { hasText: 'Copy' }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const replyText = await page.evaluate(() => document.querySelector('.message-assistant .message-content > p')?.innerText || '');
  check('Copy puts the reply on the clipboard', copied.length > 0 && replyText.length > 0 && copied.includes(replyText.slice(0, 20)), { copied: copied.slice(0, 80) });

  // Markdown: one dark code block with Copy, body-sized headings, a filled table header.
  await page.fill('textarea.chat-input', MARKDOWN_PROMPT);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.message-user').length === 2, null, { timeout: 10000 });
  await page.waitForFunction(() => {
    const replies = document.querySelectorAll('.message-assistant');
    return replies.length === 2 && replies[1].querySelector('.reply-footer');
  }, null, { timeout: 180000 });
  await page.waitForTimeout(800);
  const md = await page.evaluate(() => {
    const reply = document.querySelectorAll('.message-assistant')[1];
    const code = reply.querySelector('.code-block code');
    const h2 = reply.querySelector('.message-content h2');
    const p = reply.querySelector('.message-content p');
    const th = reply.querySelector('.table-scroll th');
    return {
      codeBlocks: reply.querySelectorAll('.code-block').length,
      lang: reply.querySelector('.code-block-lang')?.textContent || null,
      innerCodeBorder: code ? getComputedStyle(code).borderTopWidth : null,
      outerPre: reply.querySelectorAll('.message-content > pre').length,
      h2Size: h2 ? parseFloat(getComputedStyle(h2).fontSize) : null,
      pSize: p ? parseFloat(getComputedStyle(p).fontSize) : null,
      h2Color: h2 ? getComputedStyle(h2).color : null,
      pColor: p ? getComputedStyle(p).color : null,
      thFill: th ? getComputedStyle(th).backgroundColor : null,
      footers: Array.from(document.querySelectorAll('.message-assistant')).map((r) => !!r.querySelector('.reply-footer')),
    };
  });
  check('a code block is one dark block with its language and no inner box',
    md.codeBlocks === 1 && md.lang === 'python' && md.innerCodeBorder === '0px' && md.outerPre === 0, md);
  check('headings stay near body size, in the text color', md.h2Size && md.h2Size <= md.pSize * 1.25 && md.h2Color === md.pColor, md);
  check('tables scroll in a wrapper and fill their header row', !!md.thFill && md.thFill !== 'rgba(0, 0, 0, 0)', md);
  check('only the latest reply has a footer', JSON.stringify(md.footers) === '[false,true]', md);

  const codeText = await page.evaluate(() => document.querySelectorAll('.message-assistant')[1].querySelector('.code-block code').innerText);
  await page.hover('.message-assistant:nth-of-type(1) .code-block, .code-block');
  await page.locator('.code-block-copy').first().click();
  const copiedCode = await page.evaluate(() => navigator.clipboard.readText());
  check('the code block Copy button copies the code', copiedCode.trim() === codeText.trim(), { copiedCode: copiedCode.slice(0, 60) });
  await page.screenshot({ path: `${OUT}/ui-desktop-light.png` });

  // Retry asks again for the latest question. The new reply sits under the old one from its first
  // frame, takes the footer, and finishes with text. Each frame's reply order is recorded from the click.
  const replyRows = () => page.evaluate(() => Array.from(document.querySelectorAll('.message-assistant'))
    .map((m) => ({ id: m.parentElement.id, footer: !!m.querySelector('.reply-footer') })));
  const userCount = () => page.evaluate(() => document.querySelectorAll('.message-user').length);
  const before = { user: await userCount(), replies: await replyRows() };
  const oldIds = before.replies.map((r) => r.id);
  await page.evaluate(() => {
    window.__retryFrames = [];
    const start = performance.now();
    const tick = () => {
      window.__retryFrames.push(Array.from(document.querySelectorAll('.message-assistant'))
        .map((m) => [m.parentElement.id, !!m.querySelector('.reply-footer')]));
      if (performance.now() - start < 4000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.locator('.reply-footer button', { hasText: 'Retry' }).click();
  await page.waitForFunction((ids) => {
    const replies = Array.from(document.querySelectorAll('.message-assistant'));
    const last = replies[replies.length - 1];
    return last && !ids.includes(last.parentElement.id) && last.querySelector('.reply-footer')
      && !last.querySelector('.error-message') && (last.querySelector('.message-content')?.innerText || '').trim().length > 0;
  }, oldIds, { timeout: 180000 });
  const after = { user: await userCount(), replies: await replyRows() };
  check('Retry adds a finished reply under the old one, which gives up the footer',
    after.user === before.user && after.replies.length === oldIds.length + 1
    && JSON.stringify(after.replies.slice(0, -1).map((r) => r.id)) === JSON.stringify(oldIds)
    && after.replies.every((r, i) => r.footer === (i === after.replies.length - 1)), { before, after });
  const misplaced = await page.evaluate((ids) => window.__retryFrames.filter((rows) => rows.some(([id, footer], i) => {
    const isNew = !ids.includes(id);
    const last = i === rows.length - 1;
    return (isNew && !last) || (footer && !last) || (rows.some(([other]) => !ids.includes(other)) && !isNew && footer);
  })), oldIds);
  const sampled = await page.evaluate(() => window.__retryFrames.length);
  check("a retry's reply sits at the bottom from its first frame, and only it has the footer",
    misplaced.length === 0, { framesSampled: sampled, misplacedFrames: misplaced.length, firstMisplaced: misplaced[0] || null });
  const chatUrl = page.url();
  const chatTitle = await page.evaluate(() => document.querySelector('.chat-item.active h3')?.textContent || '');

  // Dark mode, then a cold load of the chat: from a blank page in the saved theme to the whole chat
  // in one step, with no light frame, no spinner, no entrance animation, and the bottom in view.
  await page.goto(`${APP}/`, { waitUntil: 'load' });
  await page.waitForSelector('.home-controls .theme-toggle', { timeout: 30000 });
  await page.click('.home-controls .theme-toggle');
  await page.addInitScript(recordFrames);
  await page.goto(chatUrl, { waitUntil: 'load' });
  await page.waitForSelector('.message-assistant .reply-footer', { timeout: 30000 });
  await page.waitForTimeout(1500);
  const frames = await page.evaluate(() => window.__frames);
  const firstChat = frames.find((f) => f.chat) || null;
  const spinnerFrames = frames.filter((f) => f.spinnerShown);
  const entranceFrames = frames.filter((f) => f.entrance > 0);
  check('a dark-mode load is dark from its first frame', frames.length > 0 && frames[0].theme === 'dark', frames[0]);
  check('the cold load shows no spinner, no entrance animation and no "No previous chats"',
    spinnerFrames.length === 0 && entranceFrames.length === 0 && !frames.some((f) => f.sidebarEmpty),
    { frames: frames.length, spinnerFrom: spinnerFrames[0]?.t ?? null, entranceFrom: entranceFrames[0]?.t ?? null });
  check('the chat appears whole and already at the bottom',
    !!firstChat && firstChat.msgs >= 5 && firstChat.gapToBottom !== null && firstChat.gapToBottom <= 2, firstChat);

  // Reopening a chat this session has shown puts its messages in the first frame.
  await page.click('.chat-sidebar button[aria-label="New chat"]');
  await page.waitForSelector('.home-page', { timeout: 10000 });
  await page.evaluate(() => { window.__frames = []; });
  await page.locator('.chat-item').first().click();
  await page.waitForTimeout(1000);
  const reopened = await page.evaluate(() => window.__frames.find((f) => f.chat) || null);
  check('reopening the chat shows its messages in the first frame, at the bottom',
    !!reopened && reopened.msgs >= 5 && reopened.gapToBottom !== null && reopened.gapToBottom <= 2, reopened);
  await page.waitForSelector('.message-assistant .reply-footer', { timeout: 30000 });
  await page.hover('.message-assistant .message-bubble');
  await page.locator('.message-assistant .export-menu-button').first().click();
  const menuBg = await page.evaluate(() => getComputedStyle(document.querySelector('.export-menu-dropdown')).backgroundColor);
  check('the reply menu is dark in dark mode', menuBg === 'rgb(15, 15, 15)', { menuBg });
  await page.keyboard.press('Escape');
  await page.mouse.click(700, 450);
  await page.screenshot({ path: `${OUT}/ui-desktop-dark.png` });
  await context.close();

  // ---------- phone ----------
  ({ context, page } = await signedIn(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }));
  const home = await page.evaluate(() => {
    const header = document.querySelector('.mobile-header');
    return {
      headerShown: header && getComputedStyle(header).display !== 'none',
      title: document.querySelector('.mobile-header-title')?.textContent,
      themeInHeader: !!header?.querySelector('button[aria-label="Toggle theme"]'),
      floatingToggle: !!document.querySelector('.sidebar-toggle'),
    };
  });
  check('the phone header shows on home with the app name and theme toggle', home.headerShown && home.title === 'Cloud Claude' && home.themeInHeader && !home.floatingToggle, home);
  await page.screenshot({ path: `${OUT}/ui-phone-home.png` });

  await page.click('.mobile-header button[aria-label="Open sidebar"]');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/ui-phone-sidebar.png` });
  await page.locator('.chat-item', { hasText: chatTitle.slice(0, 20) }).first().click();
  await page.waitForSelector('.message-assistant .reply-footer', { timeout: 30000 });
  await page.waitForTimeout(1000);
  const phone = await page.evaluate(() => ({
    title: document.querySelector('.mobile-header-title')?.textContent,
    actions: ['Star chat', 'Unstar chat', 'New chat'].filter((l) => !!document.querySelector(`.mobile-header button[aria-label="${l}"]`)),
    codeToolsOpacity: document.querySelector('.code-block-tools') ? getComputedStyle(document.querySelector('.code-block-tools')).opacity : null,
    textareaWidth: Math.round(document.querySelector('textarea.chat-input').getBoundingClientRect().width),
  }));
  // The sidebar cuts a title at 30 characters in code; the header shows the whole saved title.
  const sidebarStem = chatTitle.endsWith('...') ? chatTitle.slice(0, -3) : chatTitle;
  check('the phone header names the open chat and offers star and new chat',
    !!phone.title && phone.title.startsWith(sidebarStem) && phone.actions.includes('New chat') && phone.actions.some((a) => a.includes('tar chat')),
    { ...phone, sidebarTitle: chatTitle });
  check('code tools show without hover on a touch screen', phone.codeToolsOpacity === '1', phone);
  check('the composer leaves the text at least 150 px on a phone', phone.textareaWidth >= 150, phone);
  await page.click('.mobile-header button[aria-label="Star chat"]');
  await page.waitForSelector('.mobile-header button[aria-label="Unstar chat"]', { timeout: 10000 });
  const starAfterTap = await page.evaluate(() => {
    const b = document.querySelector('.mobile-header button[aria-label="Unstar chat"]');
    return { filled: !!b.querySelector('svg'), background: getComputedStyle(b).backgroundColor, hoverCircle: getComputedStyle(b, '::before').width };
  });
  check('the header star fills when tapped and leaves no hover mark',
    starAfterTap.filled && starAfterTap.background === 'rgba(0, 0, 0, 0)' && starAfterTap.hoverCircle === '0px', starAfterTap);
  await page.screenshot({ path: `${OUT}/ui-phone-chat.png` });
  await context.close();

  await browser.close();
  const failed = results.filter((ok) => !ok).length;
  console.log(failed ? `${failed} of ${results.length} checks failed` : `all ${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
