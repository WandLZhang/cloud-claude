// streamMessageToClaud against a fake network: the fetch stand-in returns the parts of a real
// Response the service reads (ok, status, body.getReader()), fed with real SSE text.
import { TextDecoder, TextEncoder } from 'util';
import { streamMessageToClaud } from './messageService';

global.TextDecoder = TextDecoder; // the Jest 27 jsdom environment doesn't provide it

const encoder = new TextEncoder();

function sseResponse(lines, { breakAfter = null } = {}) {
  const chunks = lines.map((l) => encoder.encode(l));
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => {
          if (breakAfter !== null && i === breakAfter) throw new TypeError('network error');
          return i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined };
        },
      }),
    },
  };
}

async function collect(stream) {
  const out = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

beforeEach(() => {
  global.fetch = jest.fn();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('an error event from the function comes through as an error event', async () => {
  global.fetch.mockResolvedValue(sseResponse([
    'data: {"type": "status", "status": "Thinking"}\n\n',
    'data: {"type": "error", "error": "image exceeds 5 MB maximum"}\n\n',
  ]));

  const events = await collect(streamMessageToClaud([], 'hi', null));

  expect(events).toContainEqual({ type: 'error', error: 'image exceeds 5 MB maximum' });
});

test('status events come through, and keepalive comments are skipped', async () => {
  global.fetch.mockResolvedValue(sseResponse([
    'data: {"type": "status", "status": "Thinking"}\n\n',
    ': keepalive\n\n',
    'data: {"type": "status", "status": "Searching the web: emerald gym levels"}\n\n',
    'data: {"type": "chunk", "text": "Hi"}\n\n',
    'data: {"type": "done", "content": "Hi", "model": "claude-opus-5"}\n\n',
  ]));

  const events = await collect(streamMessageToClaud([], 'hi', null));

  expect(events.map((e) => e.type)).toEqual(['status', 'status', 'chunk', 'done']);
  expect(events[1]).toEqual({ type: 'status', status: 'Searching the web: emerald gym levels' });
});

test('persist sends the placeholder ids in the body and the ID token as a bearer header', async () => {
  global.fetch.mockResolvedValue(sseResponse(['data: {"type": "done", "content": "ok"}\n\n']));

  await collect(streamMessageToClaud([], 'hi', null, {}, { chatId: 'c1', messageId: 'm1', idToken: 'tok' }));

  const [, options] = global.fetch.mock.calls[0];
  expect(options.headers.Authorization).toBe('Bearer tok');
  expect(JSON.parse(options.body).persist).toEqual({ chat_id: 'c1', message_id: 'm1' });
});

test('an HTTP error throws, marked as never started', async () => {
  global.fetch.mockResolvedValue({ ok: false, status: 401, body: null });

  const error = await collect(streamMessageToClaud([], 'hi', null)).catch((e) => e);

  expect(error.message).toBe('HTTP error! status: 401');
  expect(error.serverStarted).toBe(false);
});

test('a stream that breaks after it started throws, marked as started', async () => {
  global.fetch.mockResolvedValue(sseResponse(
    ['data: {"type": "status", "status": "Thinking"}\n\n', 'data: {"type": "chunk", "text": "Hi"}\n\n'],
    { breakAfter: 1 },
  ));

  const error = await collect(streamMessageToClaud([], 'hi', null)).catch((e) => e);

  expect(error.message).toBe('network error');
  expect(error.serverStarted).toBe(true);
});
