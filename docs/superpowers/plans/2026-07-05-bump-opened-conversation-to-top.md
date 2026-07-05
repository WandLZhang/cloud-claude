# Bump Opened Conversation to Top — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the user opens an existing conversation (from Home Recent Chats, a search result, the sidebar, or Starred Chats), that conversation moves to the top of the Home conversation history.

**Architecture:** The conversation list is a live Firestore listener (`subscribeToUserChats`) ordered by `updatedAt desc`, feeding both the Home "Recent Chats" grid and the sidebar. A new thin service function `touchChatOpened(userId, chatId)` writes a fresh `updatedAt` when a chat is opened; the listener re-sorts the local cache immediately via latency compensation. The function is called from the two open-handlers in `ChatInterface.js`. The deep-link/refresh path (URL-mount effect) is deliberately left untouched.

**Tech Stack:** React 18 (Create React App / react-scripts), Firebase Web SDK v10 (Firestore), react-router-dom v7. Tests: jest (bundled with react-scripts) for the unit contract test; Playwright + Firebase Admin (Python) for the optional end-to-end check.

## Global Constraints

- Ordering source of truth is `subscribeToUserChats` with `orderBy('updatedAt', 'desc')`. Reuse `updatedAt` as the sort key — no new field, no data migration.
- Do NOT modify the URL-mount `useEffect` in `ChatInterface.js` (the block that loads a chat from the `:chatId` route param). Bumping there would reorder on refresh and can cause a write → listener → re-render → write loop.
- `touchChatOpened` MUST log its payload `{ userId, chatId }` and MUST catch and log any error; a failed bump must never block navigation (fire-and-forget, not awaited).
- Commits MUST NOT include a `Co-Authored-By` trailer or any AI attribution.
- Prose in any doc or code comment: do not use the tilde character; do not use the word "exactly".
- No fabricated/mock runtime data. The optional end-to-end test runs against real Firestore under the `test-user` uid (the app's built-in test-mode user).
- LLM model rule (gemini-3.1-pro-preview, global region): not applicable — this change adds no LLM API calls.
- Python (optional Task 3 only): activate the virtualenv first — `source .venv/bin/activate` (or `source venv/bin/activate`) — before running `python`.

---

### Task 1: `touchChatOpened` service function (with unit contract test)

**Files:**
- Modify: `src/services/firebase.js` (add one exported function; `doc`, `updateDoc`, `serverTimestamp` are already imported at the top of the file)
- Test: `src/services/firebase.test.js` (new — first jest test in the repo; jest is bundled with react-scripts, no new dependency)

**Interfaces:**
- Consumes: nothing new (uses existing `db`, `doc`, `updateDoc`, `serverTimestamp` already present in `firebase.js`).
- Produces: `touchChatOpened(userId: string, chatId: string) => Promise<void>` — writes `{ updatedAt: serverTimestamp() }` to `chats/{userId}/conversations/{chatId}`. Never throws (catches and logs). Later tasks import this by name.

- [ ] **Step 1: Write the failing test**

Create `src/services/firebase.test.js` with the full content below. The Firebase SDK modules are replaced with factory mocks so importing `firebase.js` does not run real initialization and does not need the real (ESM) SDK to load:

```javascript
// Factory mocks: every Firebase submodule firebase.js imports is stubbed so the
// module loads without touching real Firebase, and so we can assert call args.
jest.mock('firebase/app', () => ({ initializeApp: jest.fn() }));
jest.mock('firebase/auth', () => ({
  getAuth: jest.fn(),
  GoogleAuthProvider: jest.fn(),
  signInWithPopup: jest.fn(),
  signOut: jest.fn(),
}));
jest.mock('firebase/firestore', () => ({
  getFirestore: jest.fn(),
  collection: jest.fn(),
  collectionGroup: jest.fn(),
  doc: jest.fn(),
  setDoc: jest.fn(),
  getDocs: jest.fn(),
  addDoc: jest.fn(),
  updateDoc: jest.fn(),
  deleteDoc: jest.fn(),
  query: jest.fn(),
  where: jest.fn(),
  orderBy: jest.fn(),
  limit: jest.fn(),
  startAfter: jest.fn(),
  onSnapshot: jest.fn(),
  serverTimestamp: jest.fn(),
}));
jest.mock('firebase/storage', () => ({
  getStorage: jest.fn(),
  ref: jest.fn(),
  uploadBytes: jest.fn(),
  getDownloadURL: jest.fn(),
}));

import * as firestore from 'firebase/firestore';
import { touchChatOpened } from './firebase';

describe('touchChatOpened', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    firestore.doc.mockReturnValue('DOC_REF');
    firestore.serverTimestamp.mockReturnValue('SERVER_TS');
    firestore.updateDoc.mockResolvedValue(undefined);
  });

  test('writes a fresh updatedAt to the correct conversation doc', async () => {
    await touchChatOpened('user-1', 'chat-9');

    // doc(db, 'chats', userId, 'conversations', chatId) — db is the first arg,
    // assert the path segments after it.
    const docArgs = firestore.doc.mock.calls[0];
    expect(docArgs.slice(1)).toEqual(['chats', 'user-1', 'conversations', 'chat-9']);

    expect(firestore.updateDoc).toHaveBeenCalledTimes(1);
    expect(firestore.updateDoc).toHaveBeenCalledWith('DOC_REF', { updatedAt: 'SERVER_TS' });
  });

  test('never throws and logs when the write fails', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    firestore.updateDoc.mockRejectedValueOnce(new Error('permission-denied'));

    await expect(touchChatOpened('user-1', 'chat-9')).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();

    errSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/user/Projects/personal/cloud-claude && CI=true npx react-scripts test src/services/firebase.test.js --watchAll=false`
Expected: FAIL — `touchChatOpened is not a function` (the export does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

In `src/services/firebase.js`, add the following exported function. Place it right after the `toggleChatStar` function (near the other chat-doc update helpers). No new imports are needed — `doc`, `updateDoc`, and `serverTimestamp` are already imported at the top of the file.

```javascript
// Bump a conversation to the top of the history when it is OPENED (not just when
// it receives a message). The chat list is ordered by `updatedAt desc`, so
// writing a fresh serverTimestamp re-sorts it. Fire-and-forget: errors are
// logged, never thrown, so a failed write can never block navigation.
export const touchChatOpened = async (userId, chatId) => {
  try {
    console.log('[touchChatOpened] bumping chat to top of history', { userId, chatId });
    await updateDoc(doc(db, 'chats', userId, 'conversations', chatId), {
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    console.error('[touchChatOpened] failed to bump chat', { userId, chatId, error });
  }
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/user/Projects/personal/cloud-claude && CI=true npx react-scripts test src/services/firebase.test.js --watchAll=false`
Expected: PASS — `Tests: 2 passed, 2 total`.

- [ ] **Step 5: Commit**

```bash
cd /home/user/Projects/personal/cloud-claude
git add src/services/firebase.js src/services/firebase.test.js
git commit -m "feat: add touchChatOpened to bump a conversation's updatedAt"
```

---

### Task 2: Wire `touchChatOpened` into the open handlers

**Files:**
- Modify: `src/components/Chat/ChatInterface.js`
  - Import line (currently `ChatInterface.js:10`)
  - `handleSelectChat` (currently `ChatInterface.js:227-234`)
  - `handleSelectSearchResult` (currently `ChatInterface.js:252-287`)

**Interfaces:**
- Consumes: `touchChatOpened(userId, chatId)` from `../../services/firebase` (Task 1).
- Produces: no new exports. Behavior change only: opening a chat via these two handlers bumps it to the top.

- [ ] **Step 1: Add `touchChatOpened` to the firebase import**

Replace this line (`ChatInterface.js:10`):

```javascript
import { updateMessage, deleteMessage } from '../../services/firebase';
```

with:

```javascript
import { updateMessage, deleteMessage, touchChatOpened } from '../../services/firebase';
```

- [ ] **Step 2: Bump on open in `handleSelectChat`**

This handler is shared by Home "Recent Chats", the sidebar list, and Starred Chats. Replace the whole function (`ChatInterface.js:227-234`):

```javascript
  const handleSelectChat = (chat) => {
    selectChat(chat);
    switchChat(chat.id);
    setSidebarOpen(false);
    setViewMode('chat');
    setTargetMessageId(null);
    navigate(`/chat/${chat.id}`);
  };
```

with:

```javascript
  const handleSelectChat = (chat) => {
    // Opening a chat bumps it to the top of the history. Fire-and-forget: the
    // live subscribeToUserChats listener re-sorts locally at once; a failed
    // write must not delay navigation.
    touchChatOpened(user.uid, chat.id);
    selectChat(chat);
    switchChat(chat.id);
    setSidebarOpen(false);
    setViewMode('chat');
    setTargetMessageId(null);
    navigate(`/chat/${chat.id}`);
  };
```

- [ ] **Step 3: Bump on open in `handleSelectSearchResult`**

Add the bump inside the existing `if (chat) {` guard, before the branching. Replace the opening of the function (`ChatInterface.js:252-260`):

```javascript
  const handleSelectSearchResult = async (result) => {
    console.log('[ChatInterface] handleSelectSearchResult called - messageId:', result.messageId);
    
    // First, select the chat
    const chat = userChats.find(c => c.id === result.chatId);
    if (chat) {
      // Store the target message ID
      const targetId = result.messageId;
```

with:

```javascript
  const handleSelectSearchResult = async (result) => {
    console.log('[ChatInterface] handleSelectSearchResult called - messageId:', result.messageId);
    
    // First, select the chat
    const chat = userChats.find(c => c.id === result.chatId);
    if (chat) {
      // Opening from a search result also bumps the chat to the top of history.
      touchChatOpened(user.uid, result.chatId);
      // Store the target message ID
      const targetId = result.messageId;
```

- [ ] **Step 4: Verify it compiles (warnings are errors under CI)**

Run: `cd /home/user/Projects/personal/cloud-claude && CI=true npm run build`
Expected: `Compiled successfully.` and exit code 0. (If an unused-import or other lint warning appears, CI mode fails the build — fix before continuing.)

- [ ] **Step 5: Manual end-to-end verification against the real app**

This is the required behavior check. Run the dev server and sign in with an account that already has several conversations:

```bash
cd /home/user/Projects/personal/cloud-claude
npm start
```

Then in the browser at `http://localhost:3000`:
1. On Home, note the current top card under "Recent Chats".
2. Open the sidebar (menu button) and click a conversation that is NOT currently at the top.
3. Return Home (open the sidebar and use "Start New Chat", or navigate to `/`). Confirm the conversation you opened is now the first card under "Recent Chats" and the top item in the sidebar.
4. Repeat, opening a conversation from each of: a Home "Recent Chats" card that is not already first; a Starred Chats card (open the sidebar → "Starred Chats"); and a search result (type a query in the sidebar search, click a hit). After each, return Home and confirm that conversation is now at the top.

Expected: in every case, the opened conversation becomes position 1 in the Home "Recent Chats" grid and the sidebar. The Starred view's own order does not change (it is ordered by when chats were starred) — only the Home history and sidebar reorder.

- [ ] **Step 6: Commit**

```bash
cd /home/user/Projects/personal/cloud-claude
git add src/components/Chat/ChatInterface.js
git commit -m "feat: move opened conversation to top of history"
```

---

### Task 3 (OPTIONAL): Automated end-to-end test (real Firestore, no LLM calls)

Adds a deterministic end-to-end check using the repo's existing patterns: a Python Firebase-Admin seed script plus a standalone Playwright script. Runs in the app's built-in test mode (`REACT_APP_TEST_MODE=true`, uid `test-user`) against real Firestore. Skip this task if the manual check in Task 2 is sufficient for you.

**Files:**
- Create: `test_scripts/seed_test_user_chats.py`
- Create: `test_scripts/verify-bump-on-open-playwright.js`

**Interfaces:**
- Consumes: the running dev server at `http://localhost:3000` in test mode, and the seeded `test-user` conversations.
- Produces: an exit-0-on-pass / exit-1-on-fail Playwright check.

- [ ] **Step 1: Write the seed script**

Create `test_scripts/seed_test_user_chats.py`:

```python
"""Seed deterministic conversations for the app's test-mode user (`test-user`).

Used by verify-bump-on-open-playwright.js. Creates three conversations with
increasing updatedAt so their initial Home order is C (newest), B, A (oldest).
Idempotent: fixed doc ids, written with merge.

Usage:
    source .venv/bin/activate   # or source venv/bin/activate
    python test_scripts/seed_test_user_chats.py --project wz-cloud-claude
"""

import argparse
import sys
from datetime import datetime, timedelta, timezone

import firebase_admin
from firebase_admin import firestore

TEST_UID = "test-user"


def seed(project_id: str) -> int:
    if not firebase_admin._apps:
        firebase_admin.initialize_app(options={"projectId": project_id})
    db = firestore.client()

    now = datetime.now(timezone.utc)
    rows = [
        ("seed-a", "Seed Chat A", "first seeded message", now - timedelta(hours=3)),
        ("seed-b", "Seed Chat B", "second seeded message", now - timedelta(hours=2)),
        ("seed-c", "Seed Chat C", "third seeded message", now - timedelta(hours=1)),
    ]

    conv = db.collection("chats").document(TEST_UID).collection("conversations")
    for doc_id, title, last_message, updated_at in rows:
        conv.document(doc_id).set(
            {
                "title": title,
                "lastMessage": last_message,
                "createdAt": updated_at,
                "updatedAt": updated_at,
            },
            merge=True,
        )
        print(f"seeded {doc_id}: title={title!r} updatedAt={updated_at.isoformat()}")

    print()
    print("Initial expected Home order (newest first): Seed Chat C, Seed Chat B, Seed Chat A")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True, help="GCP project id")
    args = parser.parse_args()
    sys.exit(seed(args.project))


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Write the Playwright verification script**

Create `test_scripts/verify-bump-on-open-playwright.js`. Selectors come from `HomePage.js` (`.recent-chats-grid`, `.recent-chat-card`, `h4`):

```javascript
// End-to-end: opening a non-top conversation moves it to the top of the Home
// "Recent Chats" grid. Precondition: dev server running in test mode
//   REACT_APP_TEST_MODE=true npm start
// and test-user seeded via seed_test_user_chats.py.
const { chromium } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

const readOrder = (page) =>
  page.$$eval('.recent-chats-grid .recent-chat-card h4', (els) =>
    els.map((e) => e.textContent.trim())
  );

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newContext({ viewport: { width: 1280, height: 900 } }).then((c) => c.newPage());

  await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('.recent-chats-grid .recent-chat-card', { timeout: 15000 });

  const before = await readOrder(page);
  console.log('Order before:', before);
  if (before.length < 2) {
    throw new Error(`Need at least 2 recent chats; found ${before.length}. Run the seed script first.`);
  }

  // The last visible card is guaranteed to not be at the top.
  const target = before[before.length - 1];
  console.log('Opening non-top chat:', target);

  await page.click(`.recent-chats-grid .recent-chat-card:has(h4:text-is("${target}"))`);
  await page.waitForURL(/\/chat\/.+/, { timeout: 15000 });

  // Return Home; the list is re-fetched/re-sorted by the live listener.
  await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('.recent-chats-grid .recent-chat-card', { timeout: 15000 });

  const after = await readOrder(page);
  console.log('Order after:', after);

  await page.screenshot({ path: '/tmp/playwright-tests/bump-on-open.png', fullPage: true });

  if (after[0] !== target) {
    throw new Error(`Expected "${target}" at top after opening; got "${after[0]}"`);
  }

  console.log('=== PASS: opened conversation moved to top ===');
  await browser.close();
})().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
```

- [ ] **Step 3: Run the seed script**

Run:
```bash
cd /home/user/Projects/personal/cloud-claude
source .venv/bin/activate
python test_scripts/seed_test_user_chats.py --project wz-cloud-claude
```
Expected: three `seeded seed-*` lines and the "Initial expected Home order" line.

- [ ] **Step 4: Start the dev server in test mode (separate terminal)**

Run: `cd /home/user/Projects/personal/cloud-claude && REACT_APP_TEST_MODE=true npm start`
Expected: the app compiles and serves at `http://localhost:3000`, signed in as the test user (no Google sign-in prompt).

- [ ] **Step 5: Run the Playwright check**

Run: `cd /home/user/Projects/personal/cloud-claude && mkdir -p /tmp/playwright-tests && node test_scripts/verify-bump-on-open-playwright.js`
Expected: logs `Order before:` / `Order after:` and `=== PASS: opened conversation moved to top ===`, exit code 0. Before-order starts with `Seed Chat C`; after-order starts with `Seed Chat A`.

- [ ] **Step 6: Commit**

```bash
cd /home/user/Projects/personal/cloud-claude
git add test_scripts/seed_test_user_chats.py test_scripts/verify-bump-on-open-playwright.js
git commit -m "test: E2E seed + Playwright for bump-on-open"
```

---

## Notes for the implementer

- The reorder is driven entirely by the existing `subscribeToUserChats` listener; there is no client-side array sorting to write. Do not add manual reordering of `userChats`.
- Do not call `touchChatOpened` from the URL-mount `useEffect` — see Global Constraints.
- `handleSelectChat` intentionally covers Home, sidebar, and Starred in one place; do not duplicate the bump into `StarredChats.js` or `ChatSidebar.js`.
- Firestore rules: no change is expected — the owner can already `updateDoc` a conversation doc (rename and star do the same in `firebase.js`). Confirm by checking `firestore.rules` before relying on it; if the manual/E2E reorder silently does not happen, check the browser console for a `[touchChatOpened] failed` permission error, which would indicate a rules gap.
