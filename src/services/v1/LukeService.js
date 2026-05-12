import { createLukeServer, openai, gemini } from '@leia-org/luke-server';
import SessionRepository from '../../repositories/v1/SessionRepository.js';
import ReplicationService from './ReplicationService.js';
import MessageService from './MessageService.js';
import SessionService from './SessionService.js';
import logger from '../../utils/logger.js';
import jwt from 'jsonwebtoken';

class LukeService {
  initialize(httpServer) {
    const providers = [];

    if (process.env.OPENAI_API_KEY) {
      providers.push(openai({ apiKey: process.env.OPENAI_API_KEY }));
    }
    if (process.env.GEMINI_API_KEY) {
      providers.push(gemini({
        apiKey: process.env.GEMINI_API_KEY,
        model: 'gemini-3.1-flash-live-preview',
      }));
    }

    if (providers.length === 0) {
      logger.warn('No AI provider API keys found for Luke. Skipping Luke initialization.');
      return;
    }

    const lukeServer = createLukeServer({
      server: httpServer,
      path: '/luke',
      providers,
      auth: {
        jwt: {
          secret: process.env.JWT_SECRET || 'secret',
        },
        validate: async (decoded) => {
          if (!decoded.sessionId) return null;
          return { sessionId: decoded.sessionId, leiaId: decoded.leiaId };
        },
      },
      session: {
        create: async (user) => {
          const session = await SessionRepository.findById(user.sessionId);
          if (!session) return null;

          const leia = await ReplicationService.findLeia(session.replication, session.leia);
          if (!leia) return null;

          return { session, leia, sessionId: user.sessionId };
        },
        getSystemInstruction: async (userSession) => {
          if (!userSession?.leia) return undefined;
          return buildInstructions(userSession.leia);
        },
        saveHistory: async (userSession, transcription) => {
          if (!userSession?.sessionId || !transcription.final) return;
          try {
            const isLeia = transcription.role === 'assistant';
            const message = await MessageService.create(transcription.text, isLeia, userSession.sessionId);
            await SessionService.addMessage(userSession.sessionId, message.id);
          } catch (err) {
            logger.error(`Failed to save luke transcription: ${err.message}`);
          }
        },
        getHistory: async (userSession) => {
          if (!userSession?.sessionId) return [];
          try {
            const messages = await MessageService.findBySession(userSession.sessionId);
            return messages.map((msg) => ({
              role: msg.isLeia ? 'assistant' : 'user',
              text: msg.text,
              final: true,
            }));
          } catch (err) {
            logger.error(`Failed to load luke history: ${err.message}`);
            return [];
          }
        },
      },
      config: {
        transcription: { input: true, output: true },
      },
    });

    logger.info('Luke WebSocket server initialized on path /luke');
    this.lukeServer = lukeServer;
  }

  async createLukeToken(sessionId) {
    const session = await SessionRepository.findById(sessionId);
    if (!session) {
      const error = new Error('Session not found');
      error.statusCode = 404;
      throw error;
    }

    const leia = await ReplicationService.findLeia(session.replication, session.leia);
    if (!leia) {
      const error = new Error('Leia not found');
      error.statusCode = 404;
      throw error;
    }

    const runnerConfiguration = leia.runnerConfiguration || {};
    if (runnerConfiguration.audioMode !== 'luke') {
      const error = new Error('Luke audio mode is not enabled for this LEIA');
      error.statusCode = 403;
      throw error;
    }

    const lukeConfig = runnerConfiguration.lukeConfig || {};

    const token = jwt.sign(
      { sessionId, leiaId: session.leia },
      process.env.JWT_SECRET || 'secret',
      { expiresIn: '24h' }
    );

    return {
      token,
      provider: lukeConfig.provider || 'gemini',
      voice: lukeConfig.voice || 'Puck',
    };
  }
}

function buildInstructions(leia) {
  const personaSpec = leia.leia?.spec?.persona?.spec || {};
  const problemSpec = leia.leia?.spec?.problem?.spec || {};
  const behaviourSpec = leia.leia?.spec?.behaviour?.spec || {};

  const instructionParts = [];

  instructionParts.push('LANGUAGE REQUIREMENT:');
  instructionParts.push('- Detect the language the user speaks and respond in the same language.');
  instructionParts.push('- If you cannot detect the language, respond in the language of the instructions below.\n');

  instructionParts.push('=== PERSONA ===');
  if (personaSpec.fullName) instructionParts.push(`Full Name: ${personaSpec.fullName}`);
  if (personaSpec.firstName) instructionParts.push(`First Name: ${personaSpec.firstName}`);
  if (personaSpec.description) instructionParts.push(`Description: ${personaSpec.description}`);
  if (personaSpec.personality) instructionParts.push(`Personality: ${personaSpec.personality}`);
  if (personaSpec.subjectPronoum) instructionParts.push(`Subject Pronoun: ${personaSpec.subjectPronoum}`);
  if (personaSpec.objectPronoum) instructionParts.push(`Object Pronoun: ${personaSpec.objectPronoum}`);
  if (personaSpec.possesivePronoum) instructionParts.push(`Possessive Pronoun: ${personaSpec.possesivePronoum}`);
  if (personaSpec.possesiveAdjective) instructionParts.push(`Possessive Adjective: ${personaSpec.possesiveAdjective}`);

  Object.keys(personaSpec).forEach((key) => {
    if (
      !['fullName', 'firstName', 'description', 'personality', 'subjectPronoum', 'objectPronoum', 'possesivePronoum', 'possesiveAdjective'].includes(key) &&
      personaSpec[key]
    ) {
      instructionParts.push(`${key}: ${personaSpec[key]}`);
    }
  });

  instructionParts.push('\n=== PROBLEM/CONTEXT ===');
  if (problemSpec.description) instructionParts.push(`Description: ${problemSpec.description}`);
  if (problemSpec.personaBackground) instructionParts.push(`Persona Background: ${problemSpec.personaBackground}`);
  if (problemSpec.details) instructionParts.push(`Details: ${problemSpec.details}`);
  if (problemSpec.process && Array.isArray(problemSpec.process) && problemSpec.process.length > 0) {
    instructionParts.push(`Process: ${problemSpec.process.join(', ')}`);
  }

  Object.keys(problemSpec).forEach((key) => {
    if (
      !['description', 'personaBackground', 'details', 'solution', 'solutionFormat', 'process', 'extends', 'overrides', 'constrainedTo'].includes(key) &&
      problemSpec[key] &&
      typeof problemSpec[key] !== 'object'
    ) {
      instructionParts.push(`${key}: ${problemSpec[key]}`);
    }
  });

  instructionParts.push('\n=== BEHAVIOR ===');
  if (behaviourSpec.description) instructionParts.push(`Description: ${behaviourSpec.description}`);
  if (behaviourSpec.role) instructionParts.push(`Role: ${behaviourSpec.role}`);
  if (behaviourSpec.character) instructionParts.push(`Character: ${behaviourSpec.character}`);
  if (behaviourSpec.process && Array.isArray(behaviourSpec.process) && behaviourSpec.process.length > 0) {
    instructionParts.push(`Process: ${behaviourSpec.process.join(', ')}`);
  }

  Object.keys(behaviourSpec).forEach((key) => {
    if (!['description', 'role', 'character', 'process'].includes(key) && behaviourSpec[key]) {
      if (typeof behaviourSpec[key] === 'object') {
        instructionParts.push(`${key}: ${JSON.stringify(behaviourSpec[key])}`);
      } else {
        instructionParts.push(`${key}: ${behaviourSpec[key]}`);
      }
    }
  });

  const widgets = leia.runnerConfiguration?.lukeConfig?.widgets || [];
  const widgetHints = widgets
    .map((w) => describeWidget(w.widgetType, w.slot))
    .filter(Boolean);
  if (widgetHints.length > 0) {
    instructionParts.push('\n=== AVAILABLE TOOLS (voice-mode widgets) ===');
    instructionParts.push(
      'The user interface has live widgets you can interact with via tool calls. Use them proactively whenever they can help — for example, read the editor before answering code questions, or annotate code the user is discussing.',
    );
    widgetHints.forEach((h) => instructionParts.push(h));
  }

  return instructionParts.filter((part) => part.trim() !== '').join('\n');
}

// Static catalog mirror for the few widgets the workbench renders in
// voice mode. Must be kept in sync with leia-workbench-frontend/src/widgets/catalog.ts.
function describeWidget(widgetType, slot) {
  switch (widgetType) {
    case 'codeEditor':
      return [
        `- Widget "codeEditor" (in the ${slot} panel): a live Monaco code editor the user can see and edit, with a configured problem and test suite. Supports JavaScript and Python (Python runs in-browser via PyScript). Three tools are available:`,
        '    * codeEditor_read() → returns { content, language, fnName }. Call FIRST whenever you need to know what the user wrote, before commenting on or editing the code. Never claim you cannot see the editor — always read.',
        '    * codeEditor_applyDiff({ edits: [{find, replace}, ...] }) → edits the user\'s code with search-and-replace pairs. Each `find` must appear exactly ONCE in the current content (include surrounding context to make it unique). Returns { applied, errors, content }. Use this to fix bugs, add comments, or rewrite a function — always read first so you know the exact text to target. If errors come back saying \'find not present\' or \'multiple occurrences\', read again and retry with a more specific anchor.',
        '    * codeEditor_runTests() → executes the user\'s current code against the problem\'s test suite and returns { passed, failed, total, language, fnName, results: [{name, ok, error?, expected?, actual?}], error? }. Call this when the user asks you to "check", "run", "verify", "test", or says "I think I got it" / "try it". After running, summarise the outcome out loud: which tests passed, which failed, why (using `expected` vs `actual` or the `error` field), and suggest a fix if any failed. The widget shows the results visually but the user is in voice mode and relies on you.',
      ].join('\n');
    default:
      return null;
  }
}

export default new LukeService();
