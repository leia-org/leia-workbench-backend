// A test run is stored as an event of type `test_run`. This is its typed view:
// the shape the test-run endpoints, the CSV and the LEIA note work with.

const plain = (event) => (event && typeof event.toJSON === 'function' ? event.toJSON() : { ...event });

/**
 * @param {object} event - An Event document or its JSON.
 * @param {object} [options]
 * @param {boolean} [options.withCode] - Include the code snapshot (the event
 *   must have been loaded with its content).
 */
export function toTestRun(event, { withCode = false } = {}) {
  const data = plain(event);
  const payload = data.payload || {};
  return {
    id: data.id ?? (data._id ? String(data._id) : undefined),
    session: data.session,
    replication: data.replication,
    trigger: data.actor,
    language: payload.language,
    fnName: payload.fnName ?? '',
    ...(withCode ? { code: data.content ?? '' } : {}),
    codeTruncated: data.contentTruncated === true,
    status: payload.status,
    passed: payload.passed ?? 0,
    failed: payload.failed ?? 0,
    total: payload.total ?? 0,
    results: Array.isArray(payload.results) ? payload.results : [],
    error: payload.error ?? null,
    durationMs: payload.durationMs ?? 0,
    clientRunAt: data.clientAt,
    clientRunId: data.clientEventId,
    reportedToLeiaAt: data.reportedToLeiaAt ?? null,
    createdAt: data.createdAt,
  };
}
