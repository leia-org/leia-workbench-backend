const PRE_WORKBENCH_ORIGIN = 'https://pre.workbench.leia.ovh';
const PRODUCTION_WORKBENCH_ORIGIN = 'https://workbench.leia.ovh';

// Student interaction events (test runs, clipboard, page presence) are a
// preview feature: on only where the frontend is the pre workbench. Evaluated
// on every call, never cached, so a deployment decides it with FRONTEND_URL.
export function isInteractionEventsEnabled() {
  const origins = (process.env.FRONTEND_URL || '').split(',').map((origin) => origin.trim().replace(/\/$/, ''));
  return origins.includes(PRE_WORKBENCH_ORIGIN) && !origins.includes(PRODUCTION_WORKBENCH_ORIGIN);
}

export function requireInteractionEvents(_req, res, next) {
  if (!isInteractionEventsEnabled()) {
    return res.status(404).json({ error: 'Interaction events are unavailable' });
  }
  return next();
}
