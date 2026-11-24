// runAssistantTurn with fakes for its two external sides: Firestore (addMessage/updateMessage) and
// the function's SSE stream. Each fake records what the turn asked of it.
import { runAssistantTurn } from './assistantTurn';

const TURN = { userId: 'user1', chatId: 'c1', userMessageId: 'u1', history: [], content: 'hi', image: null, config: {} };

function fakes({ stream, getIdToken = async () => 'tok' } = {}) {
  const calls = { added: [], updates: [], streamArgs: null };
  return {
    calls,
    deps: {
      addMessage: async (userId, chatId, message) => {
        calls.added.push({ userId, chatId, message });
        return 'm1';
      },
      updateMessage: async (userId, chatId, messageId, updates) => {
        calls.updates.push({ userId, chatId, messageId, updates });
      },
      getIdToken,
      stream: (...args) => {
        calls.streamArgs = args;
        return stream();
      },
    },
  };
}

function failure(message, serverStarted) {
  return Object.assign(new Error(message), { serverStarted });
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('creates the placeholder and hands its id and the ID token to the function as persist', async () => {
  const { deps, calls } = fakes({ stream: async function* () { yield { type: 'done', content: 'ok' }; } });

  const messageId = await runAssistantTurn(TURN, deps);

  expect(messageId).toBe('m1');
  expect(calls.added[0].message).toMatchObject({ role: 'assistant', content: '', isStreaming: true, replyTo: 'u1' });
  expect(calls.streamArgs[4]).toEqual({ chatId: 'c1', messageId: 'm1', idToken: 'tok' });
});

test('writes nothing to the reply while the function streams and saves it', async () => {
  const { deps, calls } = fakes({
    stream: async function* () {
      yield { type: 'status', status: 'Thinking' };
      yield { type: 'chunk', text: 'Hi' };
      yield { type: 'done', content: 'Hi' };
    },
  });

  await runAssistantTurn(TURN, deps);

  expect(calls.updates).toEqual([]);
});

test('marks the reply failed when the request never started', async () => {
  const { deps, calls } = fakes({
    stream: async function* () { throw failure('HTTP error! status: 500', false); },
  });

  await expect(runAssistantTurn(TURN, deps)).rejects.toThrow('HTTP error! status: 500');

  expect(calls.updates).toEqual([{
    userId: 'user1', chatId: 'c1', messageId: 'm1',
    updates: { isStreaming: false, status: null, error: 'HTTP error! status: 500' },
  }]);
});

test('leaves the reply to the function when the stream breaks after it started', async () => {
  const { deps, calls } = fakes({
    stream: async function* () {
      yield { type: 'status', status: 'Thinking' };
      throw failure('network error', true);
    },
  });

  await expect(runAssistantTurn(TURN, deps)).resolves.toBe('m1');

  expect(calls.updates).toEqual([]);
});

test('marks the reply failed when there is no ID token', async () => {
  const { deps, calls } = fakes({
    stream: async function* () { yield { type: 'done', content: 'never' }; },
    getIdToken: async () => { throw new Error('Not signed in'); },
  });

  await expect(runAssistantTurn(TURN, deps)).rejects.toThrow('Not signed in');

  expect(calls.streamArgs).toBeNull();
  expect(calls.updates[0].updates).toEqual({ isStreaming: false, status: null, error: 'Not signed in' });
});

// The page shows the reply from this stream as well as from Firestore: a phone whose live Firestore
// connection had gone quiet (on 2026-11-24 it listened over Wi-Fi while requests went over cellular)
// got the whole reply over the stream and still showed "thinking".
test('hands every stream event to onEvent with the reply\'s id', async () => {
  const seen = [];
  const { deps } = fakes({
    stream: async function* () {
      yield { type: 'status', status: 'Thinking' };
      yield { type: 'chunk', text: 'Hi' };
      yield { type: 'done', content: 'Hi' };
    },
  });
  deps.onEvent = (messageId, event) => seen.push([messageId, event.type]);

  await runAssistantTurn(TURN, deps);

  expect(seen).toEqual([['m1', 'status'], ['m1', 'chunk'], ['m1', 'done']]);
});

test('tells onEvent when the stream breaks after the function started, so the page can reset Firestore', async () => {
  const seen = [];
  const { deps } = fakes({
    stream: async function* () {
      yield { type: 'chunk', text: 'Hi' };
      throw failure('network error', true);
    },
  });
  deps.onEvent = (messageId, event) => seen.push([messageId, event.type]);

  await expect(runAssistantTurn(TURN, deps)).resolves.toBe('m1');

  expect(seen).toEqual([['m1', 'chunk'], ['m1', 'lost']]);
});
