import express from 'express';
import {
  createRealtimeSession,
  saveAudioTranscription,
} from '../../controllers/v1/realtimeController.js';

const router = express.Router();

// POST /api/v1/realtime/session - Create WebRTC session with OpenAI Realtime API
// Body: SDP offer (text/plain or application/sdp)
// Headers: X-Session-Id (required)
router.post('/session', express.text({ type: ['application/sdp', 'text/plain'] }), createRealtimeSession);

// POST /api/v1/realtime/transcriptions/:sessionId - Save audio transcription
router.post('/transcriptions/:sessionId', saveAudioTranscription);

export default router;
