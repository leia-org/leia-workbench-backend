const PRE_WORKBENCH_ORIGIN = 'https://pre.workbench.leia.ovh';
const PRODUCTION_WORKBENCH_ORIGIN = 'https://workbench.leia.ovh';

export function isTestRunsPreviewEnabled() {
  const origins = (process.env.FRONTEND_URL || '').split(',').map((origin) => origin.trim().replace(/\/$/, ''));
  return origins.includes(PRE_WORKBENCH_ORIGIN) && !origins.includes(PRODUCTION_WORKBENCH_ORIGIN);
}

export function requireTestRunsPreview(_req, res, next) {
  if (!isTestRunsPreviewEnabled()) {
    return res.status(404).json({ error: 'Test runs are unavailable' });
  }
  return next();
}
