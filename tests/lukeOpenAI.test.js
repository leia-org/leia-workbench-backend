import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const sockets = vi.hoisted(() => []);
vi.mock('ws', () => ({ default: class extends EventEmitter {
  static OPEN = 1;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
  terminate = vi.fn();
  constructor(url, options) { super(); this.url = url; this.options = options; sockets.push(this); }
} }));
import { openai } from '../src/providers/lukeOpenAI.js';

const emit = (socket, event) => socket.emit('message', Buffer.from(JSON.stringify(event)));
const commitInput = (socket, id) => emit(socket, { type: 'input_audio_buffer.committed', item_id: id });
const completeInput = (socket, id, text) => emit(socket, {
  type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: text,
});
function startReply(socket, id) {
  emit(socket, { type: 'response.created', response: { id: `response-${id}` } });
  emit(socket, { type: 'response.output_item.added', response_id: `response-${id}`, item: { id, type: 'message', role: 'assistant' } });
}
function completeReply(socket, id, text) {
  emit(socket, { type: 'response.output_audio_transcript.done', item_id: id, transcript: text });
  emit(socket, { type: 'response.done', response: { id: `response-${id}`, status: 'completed' } });
}
async function ready(config = {}) {
  const pending = openai({ apiKey: 'test' }).connect(config);
  const socket = sockets.at(-1);
  socket.emit('open');
  emit(socket, { type: 'session.updated' });
  return { socket, connection: await pending };
}
beforeEach(() => { sockets.length = 0; });
afterEach(() => vi.useRealTimers());

describe('Luke OpenAI Realtime GA adapter', () => {
  test('does not use the rejected beta header and waits for setup acknowledgement', async () => {
    const pending = openai({ apiKey: 'test' }).connect({ voice: 'marin', transcription: { input: true } });
    const socket = sockets[0];
    expect(socket.options.headers).toEqual({ Authorization: 'Bearer test' });
    socket.emit('open');
    const setup = JSON.parse(socket.send.mock.calls[0][0]);
    expect(setup.session).toMatchObject({ type: 'realtime', output_modalities: ['audio'], audio: {
      input: { format: { type: 'audio/pcm', rate: 24000 }, transcription: { model: 'whisper-1' } },
      output: { voice: 'marin' },
    } });
    let resolved = false;
    pending.then(() => { resolved = true; });
    emit(socket, { type: 'session.created' });
    await Promise.resolve();
    expect(resolved).toBe(false);
    emit(socket, { type: 'session.updated' });
    await pending;
    expect(resolved).toBe(true);
  });

  test('delivers GA audio and accumulated captions through Luke handlers', async () => {
    const { socket, connection } = await ready();
    const audio = vi.fn(), transcription = vi.fn(), complete = vi.fn();
    connection.onAudio(audio);
    connection.onTranscription(transcription);
    connection.onTurnComplete(complete);
    connection.send({ type: 'text', content: 'Welcome the student' });
    expect(JSON.parse(socket.send.mock.calls.at(-1)[0])).toEqual({ type: 'response.create' });
    startReply(socket, 'reply');
    emit(socket, { type: 'response.output_audio.delta', delta: Buffer.from([1, 2]).toString('base64') });
    emit(socket, { type: 'response.output_audio_transcript.delta', item_id: 'reply', delta: 'Hola' });
    emit(socket, { type: 'response.output_audio_transcript.delta', item_id: 'reply', delta: ', estudiante' });
    completeReply(socket, 'reply', 'Hola, estudiante');
    expect(audio).toHaveBeenCalledWith(new Uint8Array([1, 2]));
    expect(transcription).toHaveBeenNthCalledWith(2, { role: 'assistant', text: 'Hola, estudiante', final: false });
    expect(transcription).toHaveBeenLastCalledWith({ role: 'assistant', text: 'Hola, estudiante', final: true });
    expect(complete).toHaveBeenCalledOnce();
  });

  test('rejects a setup error instead of reporting a connected but silent session', async () => {
    const pending = openai({ apiKey: 'test' }).connect({});
    const assertion = expect(pending).rejects.toThrow('Invalid voice');
    emit(sockets[0], { type: 'error', error: { message: 'Invalid voice' } });
    await assertion;
    expect(sockets[0].terminate).toHaveBeenCalledOnce();
  });

  test('keeps a delayed user transcript before the reply without delaying audio or turn completion', async () => {
    const { socket, connection } = await ready({ transcription: { input: true } });
    const transcription = vi.fn(), audio = vi.fn(), complete = vi.fn();
    connection.onTranscription(transcription);
    connection.onAudio(audio);
    connection.onTurnComplete(complete);
    emit(socket, { type: 'input_audio_buffer.committed', item_id: 'user-1', previous_item_id: null });
    emit(socket, { type: 'response.created', response: { id: 'response-1' } });
    emit(socket, { type: 'response.output_item.added', response_id: 'response-1', item: { id: 'assistant-1', type: 'message', role: 'assistant' } });
    emit(socket, { type: 'response.output_audio.delta', delta: Buffer.from([1, 2]).toString('base64') });
    emit(socket, { type: 'response.output_audio_transcript.delta', item_id: 'assistant-1', delta: 'Hola' });
    emit(socket, { type: 'response.output_audio_transcript.done', item_id: 'assistant-1', transcript: 'Hola, Alex' });
    emit(socket, { type: 'response.done', response: { id: 'response-1', status: 'completed' } });
    expect(audio).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
    expect(transcription).not.toHaveBeenCalled();
    emit(socket, { type: 'conversation.item.input_audio_transcription.completed', item_id: 'user-1', transcript: 'Me llamo Alex' });
    expect(transcription.mock.calls.map(([message]) => message)).toEqual([
      { role: 'user', text: 'Me llamo Alex', final: true },
      { role: 'assistant', text: 'Hola, Alex', final: true },
    ]);
  });

  test('preserves multiple turns when ASR completions arrive in reverse order', async () => {
    const { socket, connection } = await ready({ transcription: { input: true } });
    const transcription = vi.fn(), interrupted = vi.fn();
    connection.onTranscription(transcription);
    connection.onInterrupted(interrupted);
    commitInput(socket, 'user-1');
    startReply(socket, 'reply-1');
    emit(socket, { type: 'response.output_audio_transcript.delta', item_id: 'reply-1', delta: 'Primera ' });
    emit(socket, { type: 'input_audio_buffer.speech_started', item_id: 'user-2' });
    commitInput(socket, 'user-2');
    // An interruption may commit the next user before the previous reply ends.
    completeReply(socket, 'reply-1', 'Primera respuesta');
    startReply(socket, 'reply-2');
    completeReply(socket, 'reply-2', 'Segunda respuesta');
    completeInput(socket, 'user-2', 'Segunda pregunta');
    expect(interrupted).toHaveBeenCalledOnce();
    expect(transcription).not.toHaveBeenCalled();
    completeInput(socket, 'user-1', 'Primera pregunta');
    expect(transcription.mock.calls.map(([message]) => message)).toEqual([
      { role: 'user', text: 'Primera pregunta', final: true },
      { role: 'assistant', text: 'Primera respuesta', final: true },
      { role: 'user', text: 'Segunda pregunta', final: true },
      { role: 'assistant', text: 'Segunda respuesta', final: true },
    ]);
    completeInput(socket, 'user-1', 'Primera pregunta');
    completeReply(socket, 'reply-1', 'Primera respuesta');
    expect(transcription).toHaveBeenCalledTimes(4);
  });

  test('resumes accumulated streaming captions as soon as preceding ASR completes', async () => {
    const { socket, connection } = await ready({ transcription: { input: true } });
    const transcription = vi.fn();
    connection.onTranscription(transcription);
    commitInput(socket, 'user');
    startReply(socket, 'reply');
    emit(socket, { type: 'response.output_audio_transcript.delta', item_id: 'reply', delta: 'Hola' });
    emit(socket, { type: 'response.output_audio_transcript.delta', item_id: 'reply', delta: ', Alex' });
    completeInput(socket, 'user', 'Soy Alex');
    emit(socket, { type: 'response.output_audio_transcript.delta', item_id: 'reply', delta: '.' });
    completeReply(socket, 'reply', 'Hola, Alex.');
    expect(transcription.mock.calls.map(([message]) => message)).toEqual([
      { role: 'user', text: 'Soy Alex', final: true },
      { role: 'assistant', text: 'Hola, Alex', final: false },
      { role: 'assistant', text: 'Hola, Alex.', final: false },
      { role: 'assistant', text: 'Hola, Alex.', final: true },
    ]);
  });

  test.each(['empty', 'failed'])('%s input transcription releases replies and later turns', async (kind) => {
    const { socket, connection } = await ready({ transcription: { input: true } });
    const transcription = vi.fn(), error = vi.fn();
    connection.onTranscription(transcription);
    connection.onError(error);
    commitInput(socket, 'user');
    startReply(socket, 'reply');
    completeReply(socket, 'reply', '¿Puedes repetir?');
    if (kind === 'empty') completeInput(socket, 'user', '  ');
    else emit(socket, { type: 'conversation.item.input_audio_transcription.failed', item_id: 'user', error: { message: 'ASR failed' } });
    commitInput(socket, 'next-user');
    completeInput(socket, 'next-user', 'Hola');
    expect(transcription.mock.calls.map(([message]) => message.text)).toEqual(['¿Puedes repetir?', 'Hola']);
    expect(error).toHaveBeenCalledTimes(kind === 'failed' ? 1 : 0);
  });

  test.each(['cancelled', 'failed'])('a %s response does not block following captions or pending ASR', async (status) => {
    const { socket, connection } = await ready({ transcription: { input: true } });
    const transcription = vi.fn();
    connection.onTranscription(transcription);
    commitInput(socket, 'user');
    startReply(socket, 'reply');
    emit(socket, { type: 'response.output_audio_transcript.delta', item_id: 'reply', delta: 'Respuesta parcial' });
    emit(socket, { type: 'response.done', response: { id: 'response-reply', status } });
    expect(transcription).not.toHaveBeenCalled();
    completeInput(socket, 'user', 'Pregunta');
    startReply(socket, 'next-reply');
    completeReply(socket, 'next-reply', 'Nueva respuesta');
    expect(transcription.mock.calls.map(([message]) => message)).toEqual([
      { role: 'user', text: 'Pregunta', final: true },
      { role: 'assistant', text: 'Respuesta parcial', final: true },
      { role: 'assistant', text: 'Nueva respuesta', final: true },
    ]);
  });

  test('does not wait for disabled input transcription or captions from tool calls', async () => {
    const { socket, connection } = await ready({ transcription: { input: false } });
    const transcription = vi.fn(), tool = vi.fn();
    connection.onTranscription(transcription);
    connection.onToolCall(tool);
    commitInput(socket, 'user');
    emit(socket, { type: 'response.output_item.added', item: { id: 'tool', type: 'function_call', call_id: 'call', name: 'read' } });
    emit(socket, { type: 'response.function_call_arguments.done', call_id: 'call', arguments: '{}' });
    startReply(socket, 'reply');
    completeReply(socket, 'reply', 'Resultado');
    expect(tool).toHaveBeenCalledOnce();
    expect(transcription).toHaveBeenCalledExactlyOnceWith({ role: 'assistant', text: 'Resultado', final: true });
  });

  test('seeds assistant history using output_text and dispatches tool calls', async () => {
    const { socket, connection } = await ready({ history: [{ role: 'assistant', text: 'Welcome' }] });
    expect(JSON.parse(socket.send.mock.calls[1][0]).item.content).toEqual([{ type: 'output_text', text: 'Welcome' }]);
    const tool = vi.fn();
    connection.onToolCall(tool);
    emit(socket, { type: 'response.function_call_arguments.done', call_id: 'call', name: 'read', arguments: '{"slot":"right"}' });
    expect(tool).toHaveBeenCalledWith({ callId: 'call', name: 'read', arguments: { slot: 'right' } });
    connection.sendToolResult('call', { content: 'code' });
    expect(JSON.parse(socket.send.mock.calls.at(-2)[0]).item).toMatchObject({ type: 'function_call_output', call_id: 'call' });
  });

  test('reports failed generation and ignores intentional disconnect', async () => {
    const { socket, connection } = await ready();
    const error = vi.fn(), complete = vi.fn();
    connection.onError(error);
    connection.onTurnComplete(complete);
    emit(socket, { type: 'response.done', response: { status: 'failed', status_details: { error: { message: 'Quota exhausted' } } } });
    expect(error.mock.calls[0][0].message).toBe('Quota exhausted');
    expect(complete).not.toHaveBeenCalled();
    error.mockClear();
    await connection.disconnect();
    socket.emit('close');
    expect(error).not.toHaveBeenCalled();
  });
});
