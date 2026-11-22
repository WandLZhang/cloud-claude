// Small formatters shared by the chat views. Each takes plain values so it can be tested alone.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function toMillis(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  return null;
}

/** "now", "5m", "3h", "2d", then "Oct 3" this year or "Oct 3, 2025" before it. */
export function relativeTime(value, nowMs = Date.now()) {
  const ms = toMillis(value);
  if (ms === null) return '';
  const diff = nowMs - ms;
  if (diff < MIN) return 'now';
  if (diff < HOUR) return `${Math.floor(diff / MIN)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d`;
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(nowMs).getFullYear();
  return date.toLocaleDateString('en-US', sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "12s", "1m 05s", "1h 02m". */
export function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const pad = (n) => String(n).padStart(2, '0');
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${pad(totalSeconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`;
}

/** The label on a reply's thinking toggle. Replies saved before the function timed thinking have no duration. */
export function thinkingLabel(seconds) {
  if (typeof seconds !== 'number') return 'Thought process';
  return `Thought for ${formatElapsed(Math.max(1, Math.round(seconds)) * 1000)}`;
}

const MODEL_NAMES = {
  'claude-opus-5-5': 'Opus 5.5',
  'claude-opus-5': 'Opus 5',
  'claude-opus-4-8': 'Opus 4.8',
  'claude-opus-4-7': 'Opus 4.7',
  'claude-opus-4-6': 'Opus 4.6',
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-haiku-5-5': 'Haiku 5.5',
  'claude-haiku-4-5': 'Haiku 4.5',
};

/** A short name for the model a reply came from; an unknown ID shows as it is. */
export function modelLabel(id) {
  if (!id) return '';
  return MODEL_NAMES[id] || id;
}

function textOf(node) {
  if (node.type === 'text') return node.value;
  return (node.children || []).map(textOf).join('');
}

/** The language and text of a fenced code block, from react-markdown's hast `pre` node. */
export function codeFromNode(node) {
  const code = (node.children || []).find((child) => child.tagName === 'code') || node;
  const classes = (code.properties && code.properties.className) || [];
  const languageClass = classes.find((c) => typeof c === 'string' && c.startsWith('language-'));
  const text = textOf(code);
  return {
    language: languageClass ? languageClass.slice('language-'.length) : '',
    text: text.endsWith('\n') ? text.slice(0, -1) : text,
  };
}

/**
 * The pending entries Firestore hasn't confirmed. A pending user message waits until a saved
 * message has its id; a pending reply waits until a saved reply answers the same message.
 */
export function waitingPending(messages, pending) {
  const savedIds = new Set(messages.map((m) => m.id));
  const answered = new Set(messages.filter((m) => m.role === 'assistant' && m.replyTo).map((m) => m.replyTo));
  return pending.filter((p) => (p.role === 'user' ? !savedIds.has(p.id) : !answered.has(p.replyTo)));
}

/** Saved messages plus the ones sent but not saved yet. */
export function mergePending(messages, pending) {
  if (!pending || pending.length === 0) return messages;
  const waiting = waitingPending(messages, pending);
  return waiting.length ? [...messages, ...waiting] : messages;
}

/** A new chat's title: the message's first 40 characters on one line, or a name for a photo. */
export function chatTitle(content, hasImage) {
  const clean = (content || '').split('\n').map((line) => line.trim()).filter(Boolean).join(' ');
  if (clean) return clean.length > 40 ? `${clean.substring(0, 40)}...` : clean;
  return hasImage ? 'Image Chat' : 'New Chat';
}
