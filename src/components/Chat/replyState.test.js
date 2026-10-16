import { replyState } from './replyState';

// Firestore Timestamps expose toDate(); these stand-ins carry hand-picked instants.
const NOW = Date.UTC(2026, 9, 16, 15, 0, 0);
const at = (msAgo) => ({ toDate: () => new Date(NOW - msAgo) });
const MIN = 60 * 1000;

test('a streaming reply with a fresh server update shows its status', () => {
  const message = { isStreaming: true, status: 'Searching the web: emerald gym levels', streamUpdatedAt: at(20 * 1000), timestamp: at(5 * MIN) };
  expect(replyState(message, NOW)).toEqual({ kind: 'streaming', status: 'Searching the web: emerald gym levels' });
});

test('a streaming reply without a status shows no status', () => {
  const message = { isStreaming: true, streamUpdatedAt: at(5 * 1000), timestamp: at(MIN) };
  expect(replyState(message, NOW)).toEqual({ kind: 'streaming', status: null });
});

test('a streaming reply with no server update for over 3 minutes has stopped', () => {
  const message = { isStreaming: true, status: 'Thinking', streamUpdatedAt: at(3 * MIN + 1000), timestamp: at(10 * MIN) };
  expect(replyState(message, NOW)).toEqual({ kind: 'stopped' });
});

test('an old reply that never got a server update has stopped (the Aug 22 bubbles)', () => {
  const message = { isStreaming: true, content: "I'", timestamp: at(55 * 24 * 60 * MIN) };
  expect(replyState(message, NOW)).toEqual({ kind: 'stopped' });
});

test('a reply whose server timestamp is still pending is streaming', () => {
  const message = { isStreaming: true, timestamp: null };
  expect(replyState(message, NOW)).toEqual({ kind: 'streaming', status: null });
});

test('a finished reply with an error has failed', () => {
  const message = { isStreaming: false, error: 'image exceeds 5 MB maximum', timestamp: at(MIN) };
  expect(replyState(message, NOW)).toEqual({ kind: 'failed', error: 'image exceeds 5 MB maximum' });
});

test('a finished reply without an error is done', () => {
  const message = { isStreaming: false, content: 'Hi', timestamp: at(MIN) };
  expect(replyState(message, NOW)).toEqual({ kind: 'done' });
});
