// Navigation end to end, signed in as the throwaway user (mint the session first):
//   functions/chat/.venv/bin/python test_scripts/e2e_session.py
//   NODE_PATH=$PWD/node_modules node test_scripts/test-navigation.js [desktop|phone]
// A local build: node test_scripts/serve-build.js, then APP_URL=http://localhost:3100.
//   functions/chat/.venv/bin/python test_scripts/e2e_session.py --cleanup
// Each send costs one short Claude reply.
const { chromium } = require('@playwright/test');
const fs = require('fs');

const APP = process.env.APP_URL || 'https://cloud-claude.web.app';
const PHONE = process.argv[2] === 'phone';
const session = JSON.parse(fs.readFileSync('/tmp/cloud-claude-e2e/session.json', 'utf8'));
const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(detail)}`);
};

// Touch devices insert a newline on Enter (ChatInput.isMobile), so phones send with the button.
async function send(page, text) {
  await page.fill('textarea.chat-input', text);
  if (PHONE) await page.click('button[aria-label="Send message"]');
  else await page.keyboard.press('Enter');
}

async function lastReplyIncludes(page, text, timeoutMs) {
  for (let waited = 0; waited < timeoutMs; waited += 1000) {
    const found = await page.evaluate((t) => {
      const replies = document.querySelectorAll('.message-assistant');
      return (replies[replies.length - 1]?.querySelector('.message-content')?.innerText || '').includes(t);
    }, text);
    if (found) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(PHONE
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
    : { viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`    PAGEERROR: ${e.message}`));
  await page.goto(`${APP}/`, { waitUntil: 'load' });
  await page.evaluate(async ({ apiKey, user }) => {
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
  await page.waitForTimeout(2000);

  const view = () => page.evaluate(() => ({
    path: location.pathname,
    chat: !!document.querySelector('.chat-container'),
    home: !!document.querySelector('.home-page'),
    starred: !!document.querySelector('.starred-chats-container'),
    user: document.querySelectorAll('.message-user').length,
    assistant: document.querySelectorAll('.message-assistant').length,
  }));
  // Desktop always shows the sidebar; a phone opens it from the header's menu button.
  const openSidebar = async () => {
    if (PHONE && !(await page.locator('.chat-sidebar.open').count())) {
      await page.click('.mobile-header button[aria-label="Open sidebar"]');
      await page.waitForTimeout(400);
    }
  };

  // Sending from the home page opens the new chat (it used to stay on home; see ChatInterface).
  await send(page, 'Reply with exactly: navigation check');
  let v = null;
  for (let waited = 0; waited < 10000; waited += 250) {
    await page.waitForTimeout(250);
    v = await view();
    if (v.chat && v.user >= 1) break;
  }
  const chatPath = v.path;
  check('sending from home opens the new chat', v.chat && chatPath.startsWith('/chat/') && v.user === 1, v);
  check('the reply arrives in that chat', await lastReplyIncludes(page, 'navigation check', 90000), await view());

  await openSidebar();
  await page.click('.chat-sidebar button[aria-label="New chat"]');
  await page.waitForTimeout(1500);
  v = await view();
  check('New chat goes home', v.home && v.path === '/', v);

  await openSidebar();
  await page.locator('.chat-item').first().click();
  await page.waitForTimeout(2500);
  v = await view();
  check('a sidebar click opens the chat', v.chat && v.path === chatPath && v.user >= 1, v);

  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(3500);
  v = await view();
  check('reload keeps the chat open', v.chat && v.path === chatPath && v.user >= 1, v);

  await page.goBack();
  await page.waitForTimeout(1500);
  v = await view();
  check('back leaves the chat', !v.chat && v.path !== chatPath, v);

  await page.goForward();
  await page.waitForTimeout(2000);
  v = await view();
  check('forward returns to the chat', v.chat && v.path === chatPath, v);

  await openSidebar();
  await page.click('.chat-sidebar button[aria-label="Starred chats"]');
  await page.waitForTimeout(1500);
  v = await view();
  check('Starred opens the starred view', v.starred && v.path === '/starred', v);

  await page.goto(`${APP}/chat/does-not-exist`, { waitUntil: 'load' });
  await page.waitForTimeout(4000);
  v = await view();
  check('a dead chat link goes home', v.home && v.path === '/', v);

  await page.goto(`${APP}${chatPath}`, { waitUntil: 'load' });
  await page.waitForSelector('.message-user', { timeout: 30000 });
  await page.waitForTimeout(1500);
  await send(page, 'Reply with exactly: second turn');
  const replied = await lastReplyIncludes(page, 'second turn', 90000);
  v = await view();
  check('a follow-up stays in the chat and gets its reply', v.chat && v.path === chatPath && v.user === 2 && replied, v);

  await browser.close();
  const failed = results.filter((ok) => !ok).length;
  console.log(failed ? `${failed} of ${results.length} checks failed` : `all ${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
