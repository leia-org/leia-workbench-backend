import Joi from 'joi';
import { createHash } from 'crypto';

// Registry of the student interaction events the workbench records. Every
// event shares one envelope (see models/Event.js); what differs per type lives
// here: who may send it and from where, its payload, whether it carries heavy
// `content`, how consent applies and how many a session may store.
//
// Adding a kind of event = adding an entry here (plus capturing it in the
// frontend and rendering it for the instructor). Storage, ingestion, consent,
// caps, exports and the live feed need no change.

// Where in the student UI the event happened.
export const EVENT_SOURCES = [
  'chat_input',
  'code_editor',
  'solution_editor',
  'notes',
  'previous_solution',
  'page',
  'other',
];
export const EVENT_ACTORS = ['student', 'leia'];
export const EVENT_VIEWS = ['chat', 'edit'];

// Heavy text of an event (code under test, clipboard text). Longer content is
// cut and flagged, never rejected.
export const MAX_CONTENT_LENGTH = 60000;
// Upper bounds of what one session may store. The ingest endpoint is
// unauthenticated (the session id is the credential), so these cap it.
export const MAX_EVENTS_PER_SESSION = 3000;
export const MAX_BATCH_EVENTS = 50;

const MAX_RESULTS = 200;
const MAX_STRING_LENGTH = 2000;
const PREVIEW_LENGTH = 120;

const SURFACES = EVENT_SOURCES.filter((source) => source !== 'page');

// Widgets live in the problem definition; LEIAs configured before that
// migration carry them in the runner's luke configuration (same dual-read as
// InteractionService.getSessionData).
export function hasCodeEditorWidget(leia) {
  const problemWidgets = leia?.leia?.spec?.problem?.spec?.widgets;
  const legacyWidgets = leia?.runnerConfiguration?.lukeConfig?.widgets;
  const widgets =
    Array.isArray(problemWidgets) && problemWidgets.length > 0
      ? problemWidgets
      : Array.isArray(legacyWidgets)
        ? legacyWidgets
        : [];
  return widgets.some((widget) => widget?.widgetType === 'codeEditor');
}

// Counters and status come from the per-test results, never from the client.
export function deriveOutcome(results, error) {
  const list = Array.isArray(results) ? results : [];
  const passed = list.filter((result) => result.ok === true).length;
  const total = list.length;
  const failed = total - passed;
  const status = error ? 'error' : failed > 0 ? 'failed' : 'passed';
  return { passed, failed, total, status };
}

const normaliseLineEndings = (text) => text.replace(/\r\n?/g, '\n');

const shortText = Joi.string().allow('', null).max(MAX_STRING_LENGTH);

const testRunPayload = Joi.object({
  language: Joi.string().valid('javascript', 'python').required(),
  fnName: Joi.string().allow('').max(200).default(''),
  results: Joi.array()
    .items(
      Joi.object({
        name: Joi.string().allow('').max(MAX_STRING_LENGTH).default(''),
        ok: Joi.boolean().required(),
        error: shortText,
        expected: shortText,
        actual: shortText,
      })
    )
    .max(MAX_RESULTS)
    .default([]),
  error: shortText.default(null),
  durationMs: Joi.number().min(0).max(3600000).default(0),
}).custom((value, helpers) => {
  // A run with neither per-test results nor a suite-level error says nothing.
  if (value.results.length === 0 && !value.error) {
    return helpers.message('either "results" or "error" is required');
  }
  return value;
});

function deriveTestRun(payload) {
  const results = payload.results.map((result) => ({
    name: result.name || '',
    ok: result.ok === true,
    ...(result.error ? { error: result.error } : {}),
    ...(result.expected !== undefined && result.expected !== null ? { expected: result.expected } : {}),
    ...(result.actual !== undefined && result.actual !== null ? { actual: result.actual } : {}),
  }));
  const error = payload.error || null;
  return {
    language: payload.language,
    fnName: payload.fnName || '',
    results,
    error,
    durationMs: payload.durationMs || 0,
    ...deriveOutcome(results, error),
  };
}

const clipboardFields = {
  // How the action was triggered, as far as the browser lets the client tell.
  method: Joi.string().valid('keyboard', 'menu', 'button', 'drop', 'unknown').default('unknown'),
  // Length of the original text; larger than the stored content when it was cut.
  length: Joi.number().integer().min(0),
  wholeLine: Joi.boolean(),
  // MIME types offered by the clipboard (e.g. text/html hints at a web page).
  clipboardTypes: Joi.array().items(Joi.string().max(100)).max(20),
};

const clipboardPayload = Joi.object(clipboardFields);

const pastePayload = Joi.object({
  ...clipboardFields,
  // internal: the text matches something copied or cut inside the workbench.
  origin: Joi.string().valid('internal', 'external', 'unknown').default('unknown'),
  match: Joi.object({
    clientEventId: Joi.string().max(100).required(),
    sessionId: Joi.string().max(100),
    source: Joi.string().valid(...EVENT_SOURCES),
    kind: Joi.string().valid('exact', 'trimmed'),
    ageMs: Joi.number().min(0),
  }),
});

// Server-side facts about clipboard text, so exports and lists need not load it.
function deriveClipboard(payload, content) {
  const raw = content || '';
  // Lines, hash and preview ignore the line-ending style, so the same text
  // copied from different places compares equal.
  const text = normaliseLineEndings(raw);
  return {
    ...payload,
    length: payload.length ?? raw.length,
    lines: text ? text.split('\n').length : 0,
    hash: createHash('sha256').update(text).digest('hex'),
    preview: text.slice(0, PREVIEW_LENGTH),
  };
}

const clipboardType = (payload) => ({
  // observational: recorded for research, so it follows the student's consent.
  consent: 'observational',
  cap: 300,
  sources: SURFACES,
  actors: ['student'],
  content: 'optional',
  payload,
  derive: deriveClipboard,
});

const REGISTRY = {
  test_run: {
    // functional: the LEIA is told about these, so they are kept like messages.
    consent: 'functional',
    cap: 300,
    sources: ['code_editor'],
    actors: ['student', 'leia'],
    content: 'required',
    payload: testRunPayload,
    guard: ({ leia }) => (hasCodeEditorWidget(leia) ? null : 'not_applicable'),
    needsLeia: true,
    derive: deriveTestRun,
  },
  clipboard_copy: clipboardType(clipboardPayload),
  clipboard_cut: clipboardType(clipboardPayload),
  clipboard_paste: clipboardType(pastePayload),
  page_leave: {
    consent: 'observational',
    cap: 1000,
    sources: ['page'],
    actors: ['student'],
    content: 'none',
    payload: Joi.object({ reason: Joi.string().valid('hidden', 'blur').required() }),
    derive: (payload) => payload,
  },
  page_return: {
    consent: 'observational',
    cap: 1000,
    sources: ['page'],
    actors: ['student'],
    content: 'none',
    payload: Joi.object({
      awayMs: Joi.number().min(0).required(),
      reason: Joi.string().valid('hidden', 'blur'),
      becameHidden: Joi.boolean(),
    }),
    derive: (payload) => payload,
  },
};

export const EVENT_TYPES = Object.keys(REGISTRY);

export function getEventType(type) {
  return Object.hasOwn(REGISTRY, type) ? REGISTRY[type] : null;
}
