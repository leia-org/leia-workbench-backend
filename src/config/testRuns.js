import { isInteractionEventsEnabled } from './features.js';

// Test runs are one kind of interaction event and share its preview switch.
// Kept for the test-run specific routes until they are folded into events.
export function isTestRunsPreviewEnabled() {
  return isInteractionEventsEnabled();
}

export function requireTestRunsPreview(_req, res, next) {
  if (!isTestRunsPreviewEnabled()) {
    return res.status(404).json({ error: 'Test runs are unavailable' });
  }
  return next();
}
