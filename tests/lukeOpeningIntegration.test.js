import { describe, expect, test } from 'vitest';
import { gemini } from '@leia-org/luke-server';
import { openai } from '../src/providers/lukeOpenAI.js';
import { appendOpeningPrompt, buildOpeningPrompt } from '../src/utils/openingPrompt.js';

// Opt in explicitly: these tests generate real audio using synthetic scenarios.
const enabled = process.env.RUN_LUKE_LIVE_TESTS === '1';
const persona = [
  'Role-play Morgan, a busy restaurant owner speaking to an engineer gathering requirements for a reservation platform.',
  'Diners reserve tables for a date, time, and party size. Staff confirm reservations. Stay in character as the business owner.',
  'Be strict, pragmatic, concise, passive, and very busy. The participant must guide the interview.',
  'Only respond to concrete questions. Never offer assistance or additional suggestions. Never end your responses with questions. Let the participant lead.',
].join('\n\n');

function receiveTurn(connection) {
  return new Promise((resolve, reject) => {
    let text = '';
    let audioBytes = 0;
    const timeout = setTimeout(() => reject(new Error('Luke provider turn timed out')), 25000);
    connection.onAudio((audio) => {
      audioBytes += audio.length;
    });
    connection.onTranscription((transcription) => {
      if (transcription.role === 'assistant') text = transcription.text;
    });
    connection.onTurnComplete(() => {
      clearTimeout(timeout);
      resolve({ text, audioBytes });
    });
    connection.onError((error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

const spokenWords = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

const providers = [
  {
    name: 'Gemini',
    apiKey: process.env.GEMINI_API_KEY,
    create: gemini,
    model: 'gemini-3.1-flash-live-preview',
    voice: 'Puck',
  },
  {
    name: 'OpenAI',
    apiKey: process.env.OPENAI_API_KEY,
    create: openai,
    model: 'gpt-realtime-2025-08-28',
    voice: 'marin',
  },
];

for (const { name, apiKey, create, model, voice } of providers) {
  describe.skipIf(!enabled || !apiKey)(`${name} Luke instructor opening`, () => {
    test.each([
      { firstMessage: 'Say exactly: "Hello! What\'s your name?"', exactText: "Hello! What's your name?" },
      {
        firstMessage:
          'Greet the participant briefly and ask for their name. Do not introduce yourself or mention the business.',
      },
      {
        firstMessage:
          'Introduce yourself as Morgan, mention that you only have five minutes, and ask the participant for their name.',
        introduction: true,
      },
    ])(
      'executes opening instructions in character: $firstMessage',
      { timeout: 90000 },
      async ({ firstMessage, exactText, introduction }) => {
        const provider = create({ apiKey, model });
        const connection = await provider.connect({
          voice,
          systemInstruction: appendOpeningPrompt(persona, firstMessage),
          transcription: { input: true, output: true },
        });
        try {
          const pendingOpening = receiveTurn(connection);
          // Mirror Luke's audio-ready path, followed by its internal startup text.
          connection.send({ type: 'audio', data: new Uint8Array(640) });
          connection.send({ type: 'text', content: buildOpeningPrompt(firstMessage) });
          const opening = await pendingOpening;
          expect(opening.audioBytes).toBeGreaterThan(0);
          if (exactText) expect(spokenWords(opening.text)).toBe(spokenWords(exactText));
          else {
            expect(opening.text).toMatch(/name|call you/i);
            expect(opening.text).not.toMatch(
              /greet the participant|ask the participant|introduce yourself|mention that you/i
            );
            if (introduction) {
              expect(opening.text).toMatch(/Morgan/i);
              expect(opening.text).toMatch(/(?:I|we).*?(?:five|5) minutes/i);
            } else expect(opening.text).not.toMatch(/restaurant|reservation|Morgan/i);
          }
          const pendingReply = receiveTurn(connection);
          connection.send({ type: 'text', content: 'My name is Alex. Say hello to me using my name.' });
          const reply = await pendingReply;
          expect(reply.audioBytes).toBeGreaterThan(0);
          expect(reply.text).toMatch(/Alex/i);
          expect(reply.text).not.toMatch(/what.*(?:name|call you)/i);
        } finally {
          await connection.disconnect();
        }
      }
    );
  });
}
