// The UI end to end, signed in as the throwaway user (mint the session first; see test-navigation.js):
// instant send with a photo, the elapsed status, the reply's ⋮ menu (model, Copy, Retry, thinking)
// with nothing under the reply, code blocks, headings, tables, Retry, the sidebar's top row and
// Ctrl+K, a cold load and a reopen (no light frame, spinner or entrance animation; the chat whole
// and at the bottom), dark-mode menus, then the phone header, home and composer, including with the
// keyboard up. Three real Claude replies; screenshots go to /tmp/cloud-claude-e2e/. A reply's menu
// is checked against what Firestore saved: Claude's adaptive thinking skips some replies.
//   NODE_PATH=$PWD/node_modules node test_scripts/test-ui.js
const { chromium } = require('@playwright/test');
const fs = require('fs');

const APP = process.env.APP_URL || 'https://cloud-claude.web.app';
const OUT = '/tmp/cloud-claude-e2e';
const session = JSON.parse(fs.readFileSync(`${OUT}/session.json`, 'utf8'));
const MARKDOWN_PROMPT = 'Answer in markdown only: a level-2 heading "Greetings", one sentence, a 3-row table with columns '
  + 'Cantonese, Jyutping, English, and a 3-line Python code block that prints them.';
const PROJECT = JSON.parse(fs.readFileSync(`${__dirname}/../.firebaserc`, 'utf8')).projects.default;
const results = [];
const skipped = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(detail)}`);
};
// A check this run couldn't exercise; it counts as neither a pass nor a failure.
const skip = (name, reason) => {
  skipped.push(name);
  console.log(`SKIP ${name}: ${reason}`);
};

// The reply as Firestore saved it, read with the test user's ID token.
async function savedReply(chatId, messageId) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/`
    + `chats/${session.user.uid}/conversations/${chatId}/messages/${messageId}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${session.user.stsTokenManager.accessToken}` } });
  if (!res.ok) throw new Error(`Firestore read of ${messageId} failed: ${res.status} ${await res.text()}`);
  const doc = await res.json();
  return {
    thinkingChars: (doc.fields?.thinking?.stringValue || '').length,
    thinkingSeconds: doc.fields?.thinkingSeconds?.doubleValue ?? doc.fields?.thinkingSeconds?.integerValue ?? null,
  };
}

// The latest reply's id and the open chat's id.
function latestReply(page) {
  return page.evaluate(() => {
    const replies = document.querySelectorAll('.message-assistant');
    const reply = replies[replies.length - 1];
    return { chatId: location.pathname.split('/').pop(), id: (reply?.parentElement.id || '').slice('message-'.length) };
  });
}

// A reply's ⋮ menu (`which` is 'last' or an index): open it, read it, choose an item, close it.
const replyAt = (page, which) => (which === 'last' ? page.locator('.message-assistant').last() : page.locator('.message-assistant').nth(which));
async function openReplyMenu(page, which = 'last') {
  const reply = replyAt(page, which);
  await reply.locator('.message-bubble').first().hover();
  await reply.locator('.reply-menu .export-menu-button').click();
  const menu = reply.locator('.export-menu-dropdown');
  await menu.waitFor({ timeout: 5000 });
  return menu.evaluate((m) => ({
    model: m.querySelector('.menu-label')?.textContent || null,
    items: Array.from(m.querySelectorAll('.menu-item')).map((b) => b.textContent.replace(/\s+/g, ' ').trim()),
  }));
}
async function chooseInReplyMenu(page, text, which = 'last') {
  const reply = replyAt(page, which);
  if (!(await reply.locator('.export-menu-dropdown').count())) await openReplyMenu(page, which);
  await reply.locator('.export-menu-dropdown .menu-item', { hasText: text }).click();
}
async function closeReplyMenu(page, which = 'last') {
  const reply = replyAt(page, which);
  if (await reply.locator('.export-menu-dropdown').count()) await reply.locator('.reply-menu .export-menu-button').click();
}

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

// The composer's tools (rows and columns), its text box, and the room its placeholder needs.
function composerLayout(page) {
  return page.evaluate(() => {
    const tools = Array.from(document.querySelectorAll('.composer-tools .composer-tool')).map((b) => b.getBoundingClientRect());
    const ta = document.querySelector('textarea.chat-input');
    const cs = getComputedStyle(ta);
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const box = ta.getBoundingClientRect();
    const mid = (r) => (r.top + r.bottom) / 2;
    const send = document.querySelector('.send-button').getBoundingClientRect();
    const wrapper = document.querySelector('.input-wrapper').getBoundingClientRect();
    return {
      sendOffset: Math.round((mid(send) - Math.max(...tools.map(mid))) * 10) / 10,
      sendRightGap: Math.round(wrapper.right - send.right),
      toolsLeftGap: Math.round(Math.min(...tools.map((r) => r.left)) - wrapper.left),
      toolRows: new Set(tools.map((r) => Math.round(r.top))).size,
      toolCols: new Set(tools.map((r) => Math.round(r.left))).size,
      textBox: Math.round(box.width),
      textRoom: Math.round(ta.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)),
      placeholderNeeds: Math.ceil(ctx.measureText(ta.placeholder).width),
      textSpansCard: Math.round(box.left - wrapper.left) <= 2 && Math.round(wrapper.right - box.right) <= 2,
      toolsBelowText: Math.round(Math.min(...tools.map((r) => r.top)) - box.bottom) >= -1,
    };
  });
}

// The content above (home, or a chat's messages) runs down to the composer's top edge, and nothing
// around the composer has a background, as in CloudCLI.
function composerSurround(page, contentSelector) {
  return page.evaluate((sel) => {
    const content = document.querySelector(sel).getBoundingClientRect();
    const pill = document.querySelector('.input-wrapper').getBoundingClientRect();
    const bg = (s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { color: cs.backgroundColor, image: cs.backgroundImage };
    };
    return { contentToComposerGap: Math.round(pill.top - content.bottom), container: bg('.input-container'), homeArea: bg('.home-input-area') };
  }, contentSelector);
}
const surroundClear = (s) => Math.abs(s.contentToComposerGap) <= 1
  && s.container.image === 'none' && s.container.color === 'rgba(0, 0, 0, 0)'
  && (!s.homeArea || (s.homeArea.image === 'none' && s.homeArea.color === 'rgba(0, 0, 0, 0)'));

// Send sits level with the lower row of tools, as far from the right edge as the tools are from the left.
const sendAligned = (c) => Math.abs(c.sendOffset) <= 1.5 && Math.abs(c.sendRightGap - c.toolsLeftGap) <= 1;
// The composer card: the text on its own full-width line, the four tools in one row under it, Send
// at that row's right end.
const cardLayout = (c) => c.toolRows === 1 && c.toolCols === 4 && c.textSpansCard && c.toolsBelowText && sendAligned(c);

// Wait until the last reply has finished: its ⋮ menu appears only then.
async function waitForLatestReply(page, timeoutMs = 180000) {
  await page.waitForFunction(() => {
    const replies = document.querySelectorAll('.message-assistant');
    return replies.length > 0 && !!replies[replies.length - 1].querySelector('.reply-menu');
  }, null, { timeout: timeoutMs });
  await page.waitForTimeout(800);
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
  const deskComposer = await composerLayout(page);
  check('the composer puts the text on its own full-width line, with the tools and Send in one row under it', cardLayout(deskComposer), deskComposer);
  await page.keyboard.press('Escape');
  await page.click('textarea.chat-input');

  // Instant send with a photo: the message shows before the upload finishes.
  const png = await noisePng(page);
  await page.setInputFiles('input[type="file"][accept*="pdf"]', { name: 'noise.png', mimeType: 'image/png', buffer: Buffer.from(png) });
  await page.waitForSelector('img[alt="Selected"]', { timeout: 15000 });
  await page.fill('textarea.chat-input', 'What could have made this image? Think it over, then answer in one short sentence.');
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
  const photoReply = await latestReply(page);
  const photoSaved = await savedReply(photoReply.chatId, photoReply.id);
  const nothingUnder = await page.evaluate(() => {
    const replies = document.querySelectorAll('.message-assistant');
    const content = replies[replies.length - 1].querySelector('.message-content');
    return { lastBlock: content.lastElementChild?.tagName || null, buttonsInText: content.querySelectorAll('button:not(.code-block-copy)').length };
  });
  check('nothing sits under the reply: no buttons in its text, which ends with its last paragraph',
    nothingUnder.buttonsInText === 0 && nothingUnder.lastBlock === 'P', nothingUnder);
  const photoMenu = await openReplyMenu(page);
  check('the reply\'s ⋮ menu has the model, Copy and Retry, and "Thought for N s" when the reply thought',
    !!photoMenu.model && photoMenu.items.some((i) => i.includes('Copy')) && photoMenu.items.some((i) => i.includes('Retry'))
    && photoMenu.items.some((i) => i.includes('Thought for')) === (photoSaved.thinkingChars > 0), { ...photoMenu, saved: photoSaved });

  // The thinking toggle is tested on the first of the three replies that thought.
  let thinkingToggleTested = false;
  const tryThinkingToggle = async (saved) => {
    if (thinkingToggleTested || saved.thinkingChars === 0) return;
    thinkingToggleTested = true;
    await chooseInReplyMenu(page, 'Thought for');
    const shown = await replyAt(page, 'last').evaluate((el) => el.querySelector('.thinking-text')?.innerText || '');
    check('"Thought for N s" in the ⋮ menu opens the thinking', shown.length > 20, { shownChars: shown.length, saved });
    await chooseInReplyMenu(page, 'Hide thinking');
  };
  await tryThinkingToggle(photoSaved);

  await chooseInReplyMenu(page, 'Copy');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const replyText = await page.evaluate(() => document.querySelector('.message-assistant .message-content > p')?.innerText || '');
  check('Copy puts the reply on the clipboard', copied.length > 0 && replyText.length > 0 && copied.includes(replyText.slice(0, 20)), { copied: copied.slice(0, 80) });

  // Markdown: one dark code block with Copy, body-sized headings, a filled table header.
  await page.fill('textarea.chat-input', MARKDOWN_PROMPT);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.message-user').length === 2, null, { timeout: 10000 });
  await page.waitForFunction(() => {
    const replies = document.querySelectorAll('.message-assistant');
    return replies.length === 2 && replies[1].querySelector('.reply-menu');
  }, null, { timeout: 180000 });
  await page.waitForTimeout(800);
  const mdReply = await latestReply(page);
  await tryThinkingToggle(await savedReply(mdReply.chatId, mdReply.id));
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
    };
  });
  check('a code block is one dark block with its language and no inner box',
    md.codeBlocks === 1 && md.lang === 'python' && md.innerCodeBorder === '0px' && md.outerPre === 0, md);
  check('headings stay near body size, in the text color', md.h2Size && md.h2Size <= md.pSize * 1.25 && md.h2Color === md.pColor, md);
  check('tables scroll in a wrapper and fill their header row', !!md.thFill && md.thFill !== 'rgba(0, 0, 0, 0)', md);
  const firstReplyMenu = await openReplyMenu(page, 0);
  await closeReplyMenu(page, 0);
  const lastReplyMenu = await openReplyMenu(page);
  await closeReplyMenu(page);
  check('only the latest reply\'s menu offers Retry',
    !firstReplyMenu.items.some((i) => i.includes('Retry')) && lastReplyMenu.items.some((i) => i.includes('Retry')), { firstReplyMenu, lastReplyMenu });

  const codeText = await page.evaluate(() => document.querySelectorAll('.message-assistant')[1].querySelector('.code-block code').innerText);
  await page.hover('.message-assistant:nth-of-type(1) .code-block, .code-block');
  await page.locator('.code-block-copy').first().click();
  const copiedCode = await page.evaluate(() => navigator.clipboard.readText());
  check('the code block Copy button copies the code', copiedCode.trim() === codeText.trim(), { copiedCode: copiedCode.slice(0, 60) });
  await page.screenshot({ path: `${OUT}/ui-desktop-light.png` });

  // Retry (in the latest reply's menu) asks again for the latest question. The new reply sits under
  // the old one from its first frame and finishes with text. Each frame's reply order is recorded.
  const replyRows = () => page.evaluate(() => Array.from(document.querySelectorAll('.message-assistant'))
    .map((m) => ({ id: m.parentElement.id })));
  const userCount = () => page.evaluate(() => document.querySelectorAll('.message-user').length);
  const before = { user: await userCount(), replies: await replyRows() };
  const oldIds = before.replies.map((r) => r.id);
  await page.evaluate(() => {
    window.__retryFrames = [];
    const start = performance.now();
    const tick = () => {
      window.__retryFrames.push(Array.from(document.querySelectorAll('.message-assistant')).map((m) => m.parentElement.id));
      if (performance.now() - start < 4000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await chooseInReplyMenu(page, 'Retry');
  await page.waitForFunction((ids) => {
    const replies = Array.from(document.querySelectorAll('.message-assistant'));
    const last = replies[replies.length - 1];
    return last && !ids.includes(last.parentElement.id) && last.querySelector('.reply-menu')
      && !last.querySelector('.error-message') && (last.querySelector('.message-content')?.innerText || '').trim().length > 0;
  }, oldIds, { timeout: 180000 });
  const after = { user: await userCount(), replies: await replyRows() };
  check('Retry in the ⋮ menu adds a finished reply under the old one',
    after.user === before.user && after.replies.length === oldIds.length + 1
    && JSON.stringify(after.replies.slice(0, -1).map((r) => r.id)) === JSON.stringify(oldIds), { before, after });
  const misplaced = await page.evaluate((ids) => window.__retryFrames.filter((rows) => rows.some((id, i) => !ids.includes(id) && i !== rows.length - 1)), oldIds);
  const sampled = await page.evaluate(() => window.__retryFrames.length);
  check("a retry's reply sits at the bottom from its first frame",
    misplaced.length === 0, { framesSampled: sampled, misplacedFrames: misplaced.length, firstMisplaced: misplaced[0] || null });
  const retried = await latestReply(page);
  await tryThinkingToggle(await savedReply(retried.chatId, retried.id));
  if (!thinkingToggleTested) skip('"Thought for N s" opens the thinking', 'none of the three replies thought this run (Firestore saved no thinking)');
  const chatUrl = page.url();
  const chatTitle = await page.evaluate(() => document.querySelector('.chat-item.active h3')?.textContent || '');

  // Dark mode, then a cold load of the chat: from a blank page in the saved theme to the whole chat
  // in one step, with no light frame, no spinner, no entrance animation, and the bottom in view.
  await page.goto(`${APP}/`, { waitUntil: 'load' });
  await page.waitForSelector('.home-controls .theme-toggle', { timeout: 30000 });
  await page.click('.home-controls .theme-toggle');
  await page.addInitScript(recordFrames);
  await page.goto(chatUrl, { waitUntil: 'load' });
  await page.waitForSelector('.message-assistant .reply-menu', { timeout: 30000 });
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
  await page.waitForSelector('.message-assistant .reply-menu', { timeout: 30000 });
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
  const phoneComposer = await composerLayout(page);
  check('on a phone the composer has the same layout, with its placeholder on one line',
    cardLayout(phoneComposer) && phoneComposer.textRoom >= phoneComposer.placeholderNeeds, phoneComposer);

  // Home: no subtitle or "Saved prompts" heading, one left edge for the picker, the recent chats and
  // the composer, and a focused text box that draws no box of its own.
  const homeLayout = await page.evaluate(() => {
    const left = (sel) => { const el = document.querySelector(sel); return el ? Math.round(el.getBoundingClientRect().left) : null; };
    return {
      subtitle: !!document.querySelector('.home-subtitle'),
      savedPromptsHeading: !!document.querySelector('.saved-prompts-title'),
      edges: { picker: left('.prompt-selector'), recent: left('.recent-chat-card'), composer: left('.input-wrapper') },
      viewport: document.querySelector('meta[name="viewport"]').getAttribute('content'),
    };
  });
  check('home has no subtitle and no "Saved prompts" heading', !homeLayout.subtitle && !homeLayout.savedPromptsHeading, homeLayout);
  const edges = Object.values(homeLayout.edges);
  const homeSurround = await composerSurround(page, '.home-main-content');
  check('home runs down to the composer, with no band or background around it', surroundClear(homeSurround), homeSurround);
  check("the prompt picker and the recent chats share one left edge, clear of the composer card's rounded corners",
    edges.every((x) => x !== null) && Math.abs(homeLayout.edges.picker - homeLayout.edges.recent) <= 1
    && homeLayout.edges.picker >= homeLayout.edges.composer + 16, homeLayout.edges);
  check('the keyboard resizes the page instead of covering it', homeLayout.viewport.includes('interactive-widget=resizes-content'), homeLayout);
  await page.tap('textarea.chat-input');
  const focusedBox = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('textarea.chat-input'));
    return { focused: !!document.activeElement?.classList.contains('chat-input'), boxShadow: cs.boxShadow, background: cs.backgroundColor };
  });
  await page.evaluate(() => document.activeElement?.blur());
  check('the focused text box draws no box of its own inside the composer',
    focusedBox.focused && focusedBox.boxShadow === 'none' && focusedBox.background === 'rgba(0, 0, 0, 0)', focusedBox);
  await page.screenshot({ path: `${OUT}/ui-phone-home.png` });

  // With the keyboard up the page is shorter (resizes-content): the header and composer stay on
  // screen, and home scrolls from its title to its last recent chat.
  await page.setViewportSize({ width: 390, height: 360 });
  await page.waitForTimeout(400);
  const keyboardHome = await page.evaluate(async () => {
    const main = document.querySelector('.home-main-content');
    const titleTop = Math.round(document.querySelector('.home-title').getBoundingClientRect().top - main.getBoundingClientRect().top);
    main.scrollTop = main.scrollHeight;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const cards = document.querySelectorAll('.recent-chat-card');
    return {
      scrollable: main.scrollHeight > main.clientHeight,
      titleTopAtScrollStart: titleTop,
      lastRecentChatBottomGap: Math.round(main.getBoundingClientRect().bottom - cards[cards.length - 1].getBoundingClientRect().bottom),
      headerTop: Math.round(document.querySelector('.mobile-header').getBoundingClientRect().top),
      composerBottom: Math.round(document.querySelector('.input-wrapper').getBoundingClientRect().bottom),
      viewportHeight: innerHeight,
    };
  });
  await page.screenshot({ path: `${OUT}/ui-phone-home-keyboard.png` });
  check('with the keyboard up, home keeps the header and composer on screen and scrolls from its title to its last recent chat',
    keyboardHome.scrollable && keyboardHome.titleTopAtScrollStart >= 0 && keyboardHome.lastRecentChatBottomGap >= 0
    && keyboardHome.headerTop === 0 && keyboardHome.composerBottom <= keyboardHome.viewportHeight, keyboardHome);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);

  await page.click('.mobile-header button[aria-label="Open sidebar"]');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/ui-phone-sidebar.png` });
  await page.locator('.chat-item', { hasText: chatTitle.slice(0, 20) }).first().click();
  await page.waitForSelector('.message-assistant .reply-menu', { timeout: 30000 });
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
  check('the composer leaves the text at least 300 px on a phone', phone.textareaWidth >= 300, phone);
  const chatSurround = await composerSurround(page, '.messages-container');
  check('a chat runs down to the composer, with no band or background around it', surroundClear(chatSurround), chatSurround);
  // The conversation's widest blocks (bubbles, tables, code) against the composer card, as in CloudCLI.
  const chatGeometry = await page.evaluate(() => {
    const blocks = Array.from(document.querySelectorAll('.message-bubble, .message-content .table-scroll, .message-content .code-block'))
      .map((b) => b.getBoundingClientRect());
    const card = document.querySelector('.input-wrapper');
    const c = card.getBoundingClientRect();
    const ta = getComputedStyle(document.querySelector('textarea.chat-input'));
    return {
      conversation: { left: Math.round(Math.min(...blocks.map((b) => b.left))), right: Math.round(Math.max(...blocks.map((b) => b.right))) },
      card: { left: Math.round(c.left), right: Math.round(c.right), radius: parseFloat(getComputedStyle(card).borderTopLeftRadius) },
      text: `${ta.fontSize}/${ta.lineHeight}`,
      send: Math.round(document.querySelector('.send-button').getBoundingClientRect().width),
    };
  });
  check("the conversation stays clear of the composer card's rounded corners, so nothing is cut off at them",
    chatGeometry.conversation.left >= chatGeometry.card.left + chatGeometry.card.radius
    && chatGeometry.conversation.right <= chatGeometry.card.right - chatGeometry.card.radius, chatGeometry);
  check("at 390 px the conversation and composer use CloudCLI's dimensions: text 28 to 362 px, card 8 to 382 px, 16 px corners, 15/24 px text, 40 px Send",
    chatGeometry.conversation.left === 28 && chatGeometry.conversation.right === 362 && chatGeometry.card.left === 8
    && chatGeometry.card.right === 382 && chatGeometry.card.radius === 16 && chatGeometry.text === '15px/24px' && chatGeometry.send === 40, chatGeometry);

  // With the keyboard up, the chat keeps its newest message in view above the composer.
  await page.setViewportSize({ width: 390, height: 500 });
  await page.waitForTimeout(500);
  const keyboardChat = await page.evaluate(() => {
    const mc = document.querySelector('.messages-container');
    return { gapToBottom: Math.round(mc.scrollHeight - mc.scrollTop - mc.clientHeight), messagesHeight: mc.clientHeight };
  });
  check('with the keyboard up, the chat keeps its newest message in view', keyboardChat.gapToBottom <= 2, keyboardChat);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
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

  // A 411 px phone in Chrome at 120% page zoom lays the page out 343 px wide.
  ({ context, page } = await signedIn(browser, { viewport: { width: 343, height: 760 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }));
  const zoomedComposer = await composerLayout(page);
  check('at 120% zoom the composer keeps its layout and the placeholder fits on one line', cardLayout(zoomedComposer) && zoomedComposer.textRoom >= zoomedComposer.placeholderNeeds, zoomedComposer);
  await page.screenshot({ path: `${OUT}/ui-phone-zoomed-home.png` });
  await context.close();

  await browser.close();
  const failed = results.filter((ok) => !ok).length;
  const skipNote = skipped.length ? `; ${skipped.length} skipped` : '';
  console.log((failed ? `${failed} of ${results.length} checks failed` : `all ${results.length} checks passed`) + skipNote);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
