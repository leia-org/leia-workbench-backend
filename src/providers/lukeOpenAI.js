import WebSocket from 'ws';

// Luke 0.2's OpenAI adapter uses the retired Realtime beta protocol.
// Keep Luke's ProviderConnection interface while speaking Realtime GA.
export function openai({ apiKey, model = 'gpt-realtime-2025-08-28' }) {
  return {
    id: 'openai',
    name: 'openai',
    sampleRate: 24000,
    voices: ['alloy', 'ash', 'ballad', 'cedar', 'coral', 'echo', 'marin', 'sage', 'shimmer', 'verse']
      .map((id) => ({ id, name: id })),
    connect: (config) => connect(apiKey, model, config),
  };
}

async function connect(apiKey, model, config) {
  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const handlers = {};
  const calls = new Map();
  let responseActive = false;
  let disconnected = false;
  let transcript = '';

  const send = (event) => {
    if (ws.readyState !== WebSocket.OPEN) throw new Error('OpenAI Realtime connection is not open');
    ws.send(JSON.stringify(event));
  };

  // The socket opening is not enough: reject invalid configuration before
  // Luke tells the browser session_ready or claims the initial greeting.
  await new Promise((resolve, reject) => {
    let ready = false;
    const timeout = setTimeout(() => fail(new Error('OpenAI Realtime setup timed out')), 15000);
    const fail = (error) => {
      if (ready) { handlers.error?.(error); return; }
      clearTimeout(timeout);
      disconnected = true;
      ws.terminate();
      reject(error);
    };
    ws.on('error', fail);
    ws.on('close', () => {
      if (!disconnected) fail(new Error('OpenAI Realtime connection closed'));
    });
    ws.on('open', () => {
      const session = {
        type: 'realtime',
        output_modalities: ['audio'],
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            turn_detection: { type: 'server_vad' },
          },
          output: {
            format: { type: 'audio/pcm', rate: 24000 },
            voice: config.voice || 'alloy',
          },
        },
      };
      if (config.systemInstruction) session.instructions = config.systemInstruction;
      if (config.transcription?.input) session.audio.input.transcription = { model: 'whisper-1' };
      if (config.tools?.length) session.tools = config.tools.map((tool) => ({ type: 'function', ...tool }));
      send({ type: 'session.update', session });
    });
    ws.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString());
        if (event.type === 'error') {
          const message = event.error?.message || 'OpenAI Realtime error';
          if (message.includes('Cancellation failed: no active response')) { responseActive = false; return; }
          fail(new Error(message));
          return;
        }
        if (event.type === 'session.updated' && !ready) {
          for (const message of config.history || []) {
            send({ type: 'conversation.item.create', item: {
              type: 'message', role: message.role,
              content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: message.text }],
            } });
          }
          ready = true;
          clearTimeout(timeout);
          resolve();
          return;
        }
        switch (event.type) {
          case 'response.created':
            responseActive = true;
            transcript = '';
            break;
          case 'response.output_audio.delta':
            handlers.audio?.(new Uint8Array(Buffer.from(event.delta, 'base64')));
            break;
          case 'response.output_audio_transcript.delta':
            transcript += event.delta;
            handlers.transcription?.({ role: 'assistant', text: transcript, final: false });
            break;
          case 'response.output_audio_transcript.done':
            handlers.transcription?.({ role: 'assistant', text: event.transcript, final: true });
            transcript = '';
            break;
          case 'conversation.item.input_audio_transcription.completed':
            handlers.transcription?.({ role: 'user', text: event.transcript, final: true });
            break;
          case 'input_audio_buffer.speech_started':
            handlers.interrupted?.();
            break;
          case 'response.done':
            responseActive = false;
            if (event.response?.status === 'failed') {
              handlers.error?.(new Error(event.response.status_details?.error?.message || 'OpenAI Realtime response failed'));
            } else handlers.turnComplete?.();
            break;
          case 'response.output_item.added':
            if (event.item?.type === 'function_call') calls.set(event.item.call_id, { name: event.item.name, arguments: '' });
            break;
          case 'response.function_call_arguments.delta': {
            const call = calls.get(event.call_id);
            if (call) call.arguments += event.delta;
            break;
          }
          case 'response.function_call_arguments.done': {
            const call = calls.get(event.call_id);
            calls.delete(event.call_id);
            if (event.name || call?.name) handlers.toolCall?.({
              callId: event.call_id, name: event.name || call.name,
              arguments: JSON.parse(event.arguments || call?.arguments || '{}'),
            });
            break;
          }
        }
      } catch (error) { fail(error); }
    });
  });

  return {
    send(message) {
      if (message.type === 'audio') send({ type: 'input_audio_buffer.append', audio: Buffer.from(message.data).toString('base64') });
      else if (message.type === 'text') {
        send({ type: 'conversation.item.create', item: {
          type: 'message', role: 'user', content: [{ type: 'input_text', text: message.content }],
        } });
        send({ type: 'response.create' });
      }
    },
    onAudio: (handler) => { handlers.audio = handler; },
    onTranscription: (handler) => { handlers.transcription = handler; },
    onTurnComplete: (handler) => { handlers.turnComplete = handler; },
    onInterrupted: (handler) => { handlers.interrupted = handler; },
    onToolCall: (handler) => { handlers.toolCall = handler; },
    onError: (handler) => { handlers.error = handler; },
    interrupt() {
      if (!responseActive) return;
      responseActive = false;
      send({ type: 'response.cancel' });
    },
    sendToolResult(callId, result) {
      send({ type: 'conversation.item.create', item: {
        type: 'function_call_output', call_id: callId,
        output: typeof result === 'string' ? result : JSON.stringify(result ?? null),
      } });
      send({ type: 'response.create' });
    },
    async disconnect() {
      disconnected = true;
      ws.close();
    },
  };
}
