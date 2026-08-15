import RealtimeService from '../../services/v1/RealtimeService.js';
import LukeService from '../../services/v1/LukeService.js';
import MessageService from '../../services/v1/MessageService.js';
import SessionService from '../../services/v1/SessionService.js';

/**
 * Create a Realtime API session
 * Expects SDP offer in the request body and session ID in header
 */
export const createRealtimeSession = async (req, res, next) => {
  try {
    const sessionId = req.headers['x-session-id'];
    const sdpOffer = req.body;

    if (!sessionId) {
      const error = new Error('Session ID is required in X-Session-Id header');
      error.statusCode = 400;
      throw error;
    }

    if (!sdpOffer || typeof sdpOffer !== 'string') {
      const error = new Error('SDP offer is required in request body');
      error.statusCode = 400;
      throw error;
    }

    const result = await RealtimeService.createRealtimeSession(sessionId, sdpOffer);

    // Return JSON with SDP answer and session config for data channel update
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

/**
 * Save audio transcription as a message
 * Used to persist audio conversation transcripts
 */
export const saveAudioTranscription = async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const { transcript, isLeia } = req.body;

    if (!transcript) {
      const error = new Error('Transcript is required');
      error.statusCode = 400;
      throw error;
    }

    if (typeof isLeia !== 'boolean') {
      const error = new Error('isLeia must be a boolean');
      error.statusCode = 400;
      throw error;
    }

    // Verify session exists
    const session = await SessionService.findById(sessionId);
    if (!session) {
      const error = new Error('Session not found');
      error.statusCode = 404;
      throw error;
    }

    // Save transcription as a message
    const message = await MessageService.create(transcript, isLeia, sessionId);
    if (message) {
      await SessionService.addMessage(sessionId, message.id);
    }

    res.status(201).json({
      message: 'Transcription saved successfully',
      messageId: message?.id,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Create a Luke WebSocket auth token
 * Returns JWT token and luke config for frontend connection
 */
export const createLukeToken = async (req, res, next) => {
  try {
    const { sessionId } = req.params;

    if (!sessionId) {
      const error = new Error('Session ID is required');
      error.statusCode = 400;
      throw error;
    }

    const result = await LukeService.createLukeToken(sessionId);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};
