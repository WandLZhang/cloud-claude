// A streaming reply whose last server update is older than this has stopped: its turn died without
// saving an outcome. While a turn runs, the function writes at least every 15 seconds
// (TurnStore.HEARTBEAT_GAP in functions/chat/main.py).
export const STALE_AFTER_MS = 3 * 60 * 1000;

function millis(timestamp) {
  return timestamp && typeof timestamp.toDate === 'function' ? timestamp.toDate().getTime() : null;
}

/**
 * What an assistant reply bubble should show at `nowMs`:
 *   { kind: 'streaming', status }  the turn is running; status is the line under the text, or null
 *   { kind: 'stopped' }            still marked streaming, but nothing has updated it for too long
 *   { kind: 'failed', error }      the turn ended with an error
 *   { kind: 'done' }               the turn finished
 * Replies from before the function saved them have no streamUpdatedAt; their timestamp stands in.
 */
export function replyState(message, nowMs) {
  if (message.isStreaming) {
    const lastUpdate = millis(message.streamUpdatedAt) ?? millis(message.timestamp);
    if (lastUpdate !== null && nowMs - lastUpdate > STALE_AFTER_MS) return { kind: 'stopped' };
    return { kind: 'streaming', status: message.status || null };
  }
  if (message.error) return { kind: 'failed', error: message.error };
  return { kind: 'done' };
}
