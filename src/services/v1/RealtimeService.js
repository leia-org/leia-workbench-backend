import SessionRepository from '../../repositories/v1/SessionRepository.js';
import ReplicationService from './ReplicationService.js';
import logger from '../../utils/logger.js';

class RealtimeService {
  async createRealtimeSession(sessionId, sdpOffer) {
    logger.info(`Creating Realtime session for session ${sessionId}`);

    const session = await SessionRepository.findById(sessionId);
    if (!session) {
      const error = new Error('Session not found');
      error.statusCode = 404;
      throw error;
    }
    if (
      !session.isTest &&
      session.dataUsage?.config?.dataUsageConsentRequired &&
      !['accepted', 'declined', 'not_required'].includes(session.dataUsage?.consentStatus)
    ) {
      const error = new Error('Data usage consent decision is required before starting this activity');
      error.statusCode = 403;
      throw error;
    }

    const leia = await ReplicationService.findLeia(session.replication, session.leia);
    if (!leia) {
      const error = new Error('Leia not found');
      error.statusCode = 404;
      throw error;
    }

    const runnerConfiguration = leia.runnerConfiguration || {};
    if (!runnerConfiguration.audioMode || runnerConfiguration.audioMode !== 'realtime') {
      const error = new Error('Audio mode is not enabled for this LEIA');
      error.statusCode = 403;
      throw error;
    }

    const realtimeConfig = runnerConfiguration.realtimeConfig || {};

    const personaSpec = leia.leia?.spec?.persona?.spec || {};
    const problemSpec = leia.leia?.spec?.problem?.spec || {};
    const behaviourSpec = leia.leia?.spec?.behaviour?.spec || {};

    let instructions = realtimeConfig.instructions;
    if (!instructions) {
      const instructionParts = [];

      instructionParts.push('CRITICAL LANGUAGE REQUIREMENT:');
      instructionParts.push('- You MUST speak ONLY in English at all times.');
      instructionParts.push('- ALL your responses MUST be in English.');
      instructionParts.push('- Even if the user speaks in another language, respond in English.');
      instructionParts.push('- The transcriptions will be in English.\n');

      instructionParts.push('=== PERSONA ===');
      if (personaSpec.fullName) {
        instructionParts.push(`Full Name: ${personaSpec.fullName}`);
      }
      if (personaSpec.firstName) {
        instructionParts.push(`First Name: ${personaSpec.firstName}`);
      }
      if (personaSpec.description) {
        instructionParts.push(`Description: ${personaSpec.description}`);
      }
      if (personaSpec.personality) {
        instructionParts.push(`Personality: ${personaSpec.personality}`);
      }
      if (personaSpec.subjectPronoum) {
        instructionParts.push(`Subject Pronoun: ${personaSpec.subjectPronoum}`);
      }
      if (personaSpec.objectPronoum) {
        instructionParts.push(`Object Pronoun: ${personaSpec.objectPronoum}`);
      }
      if (personaSpec.possesivePronoum) {
        instructionParts.push(`Possessive Pronoun: ${personaSpec.possesivePronoum}`);
      }
      if (personaSpec.possesiveAdjective) {
        instructionParts.push(`Possessive Adjective: ${personaSpec.possesiveAdjective}`);
      }

      Object.keys(personaSpec).forEach((key) => {
        if (
          ![
            'fullName',
            'firstName',
            'description',
            'personality',
            'subjectPronoum',
            'objectPronoum',
            'possesivePronoum',
            'possesiveAdjective',
          ].includes(key) &&
          personaSpec[key]
        ) {
          instructionParts.push(`${key}: ${personaSpec[key]}`);
        }
      });

      instructionParts.push('\n=== PROBLEM/CONTEXT ===');
      if (problemSpec.description) {
        instructionParts.push(`Description: ${problemSpec.description}`);
      }
      if (problemSpec.personaBackground) {
        instructionParts.push(`Persona Background: ${problemSpec.personaBackground}`);
      }
      if (problemSpec.details) {
        instructionParts.push(`Details: ${problemSpec.details}`);
      }
      if (problemSpec.process && Array.isArray(problemSpec.process) && problemSpec.process.length > 0) {
        instructionParts.push(`Process: ${problemSpec.process.join(', ')}`);
      }

      Object.keys(problemSpec).forEach((key) => {
        if (
          ![
            'description',
            'personaBackground',
            'details',
            'solution',
            'solutionFormat',
            'process',
            'extends',
            'overrides',
            'constrainedTo',
          ].includes(key) &&
          problemSpec[key] &&
          typeof problemSpec[key] !== 'object'
        ) {
          instructionParts.push(`${key}: ${problemSpec[key]}`);
        }
      });

      instructionParts.push('\n=== BEHAVIOR ===');
      if (behaviourSpec.description) {
        instructionParts.push(`Description: ${behaviourSpec.description}`);
      }
      if (behaviourSpec.role) {
        instructionParts.push(`Role: ${behaviourSpec.role}`);
      }
      if (behaviourSpec.character) {
        instructionParts.push(`Character: ${behaviourSpec.character}`);
      }
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

      instructions = instructionParts.filter((part) => part.trim() !== '').join('\n');
    }

    const sessionConfig = {
      type: 'realtime',
      model: realtimeConfig.model || 'gpt-4o-realtime-preview',
      audio: {
        output: {
          voice: realtimeConfig.voice || 'marin',
        },
      },
    };

    logger.info(`Realtime session config: ${JSON.stringify(sessionConfig)}`);

    const formData = new FormData();
    formData.set('sdp', sdpOffer);
    formData.set('session', JSON.stringify(sessionConfig));

    const fullSessionConfig = {
      instructions: instructions || 'CRITICAL: You MUST speak ONLY in English at all times. ALL your responses MUST be in English. Even if the user speaks in another language, respond in English.',
      voice: realtimeConfig.voice || 'marin',
      input_audio_transcription: {
        model: 'whisper-1',
        language: 'en',
      },
      turn_detection: realtimeConfig.turnDetection || {
        type: 'server_vad',
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 500,
      },
    };

    logger.info(`Full session config (for data channel update): ${JSON.stringify(fullSessionConfig)}`);

    try {
      const response = await fetch('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(`OpenAI Realtime API error: ${response.status} - ${errorText}`);
        throw new Error(`OpenAI Realtime API error: ${response.status}`);
      }

      const sdpAnswer = await response.text();
      logger.info(`Realtime session created successfully for session ${sessionId}`);

      return {
        sdpAnswer,
        sessionConfig: fullSessionConfig,
      };
    } catch (error) {
      logger.error(`Failed to create Realtime session: ${error.message}`);
      throw error;
    }
  }
}

export default new RealtimeService();
