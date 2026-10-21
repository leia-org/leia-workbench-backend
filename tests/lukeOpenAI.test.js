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
    emit(socket, { type: 'response.created' });
    emit(socket, { type: 'response.output_audio.delta', delta: Buffer.from([1, 2]).toString('base64') });
    emit(socket, { type: 'response.output_audio_transcript.delta', delta: 'Hola' });
    emit(socket, { type: 'response.output_audio_transcript.delta', delta: ', estudiante' });
    emit(socket, { type: 'response.output_audio_transcript.done', transcript: 'Hola, estudiante' });
    emit(socket, { type: 'response.done', response: { status: 'completed' } });
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
