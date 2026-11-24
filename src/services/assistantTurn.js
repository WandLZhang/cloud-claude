/**
 * One assistant turn from the browser's side.
 *
 * The chat function saves the reply to Firestore itself (persist), so the browser only creates the
 * placeholder, starts the stream with the placeholder's id and the user's ID token, and reads the
 * stream to learn when the turn ends. The UI renders the reply from Firestore.
 *
 * `replyTo` binds the reply to the user message it answers, so display order doesn't depend on the
 * timestamps lining up. The placeholder's timestamp is never overwritten.
 *
 * The only failure recorded here is one the function can't record: a request that never started
 * (HTTP error, no network, no ID token). Once the stream has started, the function owns the reply
 * and saves its outcome, even if this page loses the stream.
 *
 * `deps` carries the side effects: { addMessage, updateMessage, getIdToken, stream }, and optionally
 * onEvent(messageId, event), which gets every stream event so the page can show the reply from the
 * stream while Firestore's live connection lags or has gone quiet.
 */
export async function runAssistantTurn({ userId, chatId, userMessageId, history, content, image, config }, deps) {
  const { addMessage, updateMessage, getIdToken, stream, onEvent } = deps;
  const messageId = await addMessage(userId, chatId, {
    role: 'assistant',
    content: '',
    timestamp: new Date(),
    isStreaming: true,
    replyTo: userMessageId,
  });

  try {
    const idToken = await getIdToken();
    for await (const event of stream(history, content || '', image, config, { chatId, messageId, idToken })) {
      if (event.type !== 'chunk') console.log('[assistantTurn] event:', event);
      if (onEvent) onEvent(messageId, event);
    }
  } catch (error) {
    if (error.serverStarted) {
      console.warn('[assistantTurn] lost the stream; the function keeps going and saves the reply:', error);
      if (onEvent) onEvent(messageId, { type: 'lost' });
    } else {
      console.error('[assistantTurn] the turn never started:', error);
      await updateMessage(userId, chatId, messageId, { isStreaming: false, status: null, error: error.message });
      throw error;
    }
  }
  return messageId;
}
