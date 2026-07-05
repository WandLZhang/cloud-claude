# Bump opened conversation to top of history

**Date:** 2026-07-05
**Status:** Approved — ready for implementation planning

## Goal

When the user opens an existing conversation, that conversation should move to
the top of the Home conversation history. Opening covers every deliberate click
that enters a chat: a Home "Recent Chats" card, a search result, a left-sidebar
chat item, and a Starred Chats card.

Today a conversation only rises to the top when it has *activity* (a message is
sent/edited/deleted, or it is renamed/starred). Merely opening and reading a
conversation leaves its position unchanged. This feature makes "open" count.

## Background: how ordering works today

- `subscribeToUserChats(userId, callback)` (`src/services/firebase.js`) is a live
  Firestore listener with `orderBy('updatedAt', 'desc')`. It is the single source
  of order for the conversation list.
- Its output (`userChats`) drives **both**:
  - the Home **"Recent Chats"** grid — `HomePage.js` renders `userChats.slice(0, 6)`;
  - the left **sidebar** list — `ChatSidebar.js` renders `userChats`.
- `updatedAt` is currently written by `addMessage`, `updateMessage`,
  `deleteMessage`, `updateChatTitle`, and `toggleChatStar`. It is **not** written
  when a chat is merely opened.
- All "open a chat" clicks converge on two handlers in
  `src/components/Chat/ChatInterface.js`:
  - `handleSelectChat(chat)` — used by Home cards, the sidebar, **and** Starred
    Chats (`StarredChats` receives `onSelectChat={handleSelectChat}`);
  - `handleSelectSearchResult(result)` — used by search results.

## Requirements (decided)

1. **Trigger on deliberate opens only:** Home Recent Chats, search results, the
   sidebar list, and Starred Chats. Opening via a raw URL / page refresh does
   **not** reorder.
2. **Reuse `updatedAt`** as the sort key — bump it on open. No new field, no data
   migration. Accepted consequence: the small time label shown next to a chat in
   the sidebar and starred cards (`formatDate(chat.updatedAt)`) now reflects
   "last opened or updated" rather than strictly "last message time."

## Design

### Data model

No schema change. Continue ordering by `updatedAt desc`. "Opening" a chat is now
treated as a touch of `updatedAt`.

### New service function

Add to `src/services/firebase.js`, alongside the existing update helpers:

```js
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

- Logs the payload (userId, chatId) per the project's logging rule.
- Catches and logs errors so a failed bump never blocks navigation.

### Call sites (`src/components/Chat/ChatInterface.js`)

- In `handleSelectChat(chat)`: call `touchChatOpened(user.uid, chat.id)`.
  This single handler covers Home Recent Chats, the sidebar, and Starred Chats.
- In `handleSelectSearchResult(result)`: inside the existing `if (chat)` guard,
  call `touchChatOpened(user.uid, result.chatId)`. This also covers the
  "already on this chat" branch (harmless re-bump).

The call is fire-and-forget (not awaited): the live `subscribeToUserChats`
listener re-sorts the local cache immediately via Firestore latency
compensation, so navigation is never gated on the write.

### Deliberately excluded

The URL-mount `useEffect` in `ChatInterface.js` (the block that loads a chat
from the `:chatId` route param) is **not** modified. That path fires on deep
links and page refreshes, where reordering is unwanted, and writing there could
create a write → listener → re-render → write loop.

## Behavior and edge cases

- **Reopening the current chat** (e.g., a search hit inside the chat you're
  already viewing): harmless; `updatedAt` bumps to now.
- **Brand-new chat from Home send:** the chat doc already exists with a fresh
  `updatedAt` from its first message, so the extra bump is a near-no-op.
- **Starred grid ordering:** `getStarredChats` orders by `starredAt`, so the
  Starred view itself does not reshuffle when a chat is opened — only the Home
  history and sidebar reorder. This is intended.
- **Firestore rules:** the owner can already `updateDoc` this conversation doc
  (rename and star do the same), so no rules change is expected. Confirm
  `firestore.rules` during implementation.

## Non-goals (YAGNI)

- No separate `lastOpenedAt` field and no data migration/backfill.
- No client-only in-memory reordering (would not persist and would be clobbered
  by the live listener).
- No change to the Starred view's ordering.
- No change to the time-label display logic.

## Verification

- **Manual:** From each entry point — Home "Recent Chats" card, sidebar item,
  Starred Chats card, and search result — open a conversation that is **not**
  currently at the top, then return Home and confirm it is now at position 1 in
  both the Home "Recent Chats" grid and the sidebar.
- **Optional automated:** A Playwright test under `test_scripts/` using
  `REACT_APP_TEST_MODE=true` that seeds a few chats, opens a non-top one, and
  asserts it becomes first in the list.

## Files touched

- `src/services/firebase.js` — add `touchChatOpened`.
- `src/components/Chat/ChatInterface.js` — call it from `handleSelectChat` and
  `handleSelectSearchResult`.
