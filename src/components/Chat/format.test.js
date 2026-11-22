import { relativeTime, formatElapsed, thinkingLabel, modelLabel, codeFromNode, mergePending, waitingPending, chatTitle } from './format';

const NOW = new Date('2026-11-22T15:00:00Z').getTime();
const ago = (ms) => new Date(NOW - ms);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('relativeTime', () => {
  test('reads a Firestore Timestamp, a Date, or a number', () => {
    expect(relativeTime({ toDate: () => ago(5 * MIN) }, NOW)).toBe('5m');
    expect(relativeTime(ago(5 * MIN), NOW)).toBe('5m');
    expect(relativeTime(NOW - 5 * MIN, NOW)).toBe('5m');
  });

  test('steps from now to minutes, hours, days, then a date', () => {
    expect(relativeTime(ago(20 * 1000), NOW)).toBe('now');
    expect(relativeTime(ago(59 * MIN), NOW)).toBe('59m');
    expect(relativeTime(ago(3 * HOUR), NOW)).toBe('3h');
    expect(relativeTime(ago(2 * DAY), NOW)).toBe('2d');
    expect(relativeTime(new Date('2026-10-03T12:00:00Z'), NOW)).toBe('Oct 3');
    expect(relativeTime(new Date('2025-10-03T12:00:00Z'), NOW)).toBe('Oct 3, 2025');
  });

  test('a pending server timestamp or a clock ahead of ours reads as now or blank', () => {
    expect(relativeTime(null, NOW)).toBe('');
    expect(relativeTime(NOW + 30 * 1000, NOW)).toBe('now');
  });
});

describe('formatElapsed', () => {
  test('seconds, then minutes and seconds, then hours and minutes', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(12400)).toBe('12s');
    expect(formatElapsed(65 * 1000)).toBe('1m 05s');
    expect(formatElapsed(62 * MIN)).toBe('1h 02m');
  });
});

describe('thinkingLabel', () => {
  test('rounds to whole seconds, at least one', () => {
    expect(thinkingLabel(7.7)).toBe('Thought for 8s');
    expect(thinkingLabel(0.2)).toBe('Thought for 1s');
    expect(thinkingLabel(95)).toBe('Thought for 1m 35s');
  });

  test('a reply saved before durations were recorded still gets a label', () => {
    expect(thinkingLabel(undefined)).toBe('Thought process');
  });
});

describe('modelLabel', () => {
  test('names the models the chat function uses, and passes others through', () => {
    expect(modelLabel('claude-opus-5')).toBe('Opus 5');
    expect(modelLabel('claude-opus-4-8')).toBe('Opus 4.8');
    expect(modelLabel('claude-sonnet-4-6')).toBe('Sonnet 4.6');
    expect(modelLabel('some-new-model')).toBe('some-new-model');
    expect(modelLabel(undefined)).toBe('');
  });
});

describe('codeFromNode', () => {
  const text = (value) => ({ type: 'text', value });
  const el = (tagName, properties, children) => ({ type: 'element', tagName, properties, children });

  test('takes the language from the code class and the text from every descendant', () => {
    const node = el('pre', {}, [el('code', { className: ['language-python'] }, [
      text('print("hi")'), el('span', {}, [text('\nx = 1')]), text('\n'),
    ])]);
    expect(codeFromNode(node)).toEqual({ language: 'python', text: 'print("hi")\nx = 1' });
  });

  test('a fence with no language gives an empty language', () => {
    const node = el('pre', {}, [el('code', {}, [text('plain\n')])]);
    expect(codeFromNode(node)).toEqual({ language: '', text: 'plain' });
  });
});

describe('mergePending', () => {
  const saved = [
    { id: 'u1', role: 'user', content: 'first' },
    { id: 'a1', role: 'assistant', content: 'reply', replyTo: 'u1' },
  ];

  test('shows a sent message and its reply placeholder until Firestore has them', () => {
    const pending = [
      { id: 'u2', role: 'user', content: 'second', pending: true },
      { id: 'pending-reply-u2', role: 'assistant', content: '', isStreaming: true, replyTo: 'u2', pending: true },
    ];
    expect(mergePending(saved, pending).map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'pending-reply-u2']);
  });

  test('drops each pending entry once its saved copy arrives', () => {
    const pending = [
      { id: 'u2', role: 'user', content: 'second', pending: true },
      { id: 'pending-reply-u2', role: 'assistant', content: '', isStreaming: true, replyTo: 'u2', pending: true },
    ];
    const withUser = [...saved, { id: 'u2', role: 'user', content: 'second' }];
    expect(mergePending(withUser, pending).map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'pending-reply-u2']);
    const withReply = [...withUser, { id: 'a2', role: 'assistant', content: '', replyTo: 'u2' }];
    expect(mergePending(withReply, pending).map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
  });

  test('no pending entries returns the saved list as it is', () => {
    expect(mergePending(saved, [])).toBe(saved);
  });
});

describe('waitingPending', () => {
  test('returns only the pending entries Firestore has not confirmed', () => {
    const pending = [
      { id: 'u2', role: 'user', pending: true },
      { id: 'pending-reply-u2', role: 'assistant', replyTo: 'u2', pending: true },
    ];
    const saved = [{ id: 'u2', role: 'user' }];
    expect(waitingPending(saved, pending).map((p) => p.id)).toEqual(['pending-reply-u2']);
  });
});

describe('chatTitle', () => {
  test('the first 40 characters of the message on one line, or a name for a photo', () => {
    expect(chatTitle('  Hello\nthere  ', false)).toBe('Hello there');
    expect(chatTitle('a'.repeat(45), false)).toBe(`${'a'.repeat(40)}...`);
    expect(chatTitle('', true)).toBe('Image Chat');
    expect(chatTitle('', false)).toBe('New Chat');
  });
});
