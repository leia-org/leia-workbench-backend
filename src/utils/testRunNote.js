// Builds the hidden context the LEIA receives when the student ran the test
// suite on their own since their previous message. It travels to the runner as
// a separate `developer` item, never inside the student's text.

// The runner rejects a context longer than this.
export const MAX_NOTE_LENGTH = 4000;

const MAX_FAILING_TESTS = 5;
const MAX_NAME_LENGTH = 100;
const MAX_VALUE_LENGTH = 200;

const clip = (value, max) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

function describeAge(createdAt, now) {
  const elapsedMs = new Date(now).getTime() - new Date(createdAt).getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs < 60000) return 'less than a minute before this message';
  const minutes = Math.round(elapsedMs / 60000);
  return `${minutes} min before this message`;
}

function describeFailingTest(result) {
  const name = clip(result.name, MAX_NAME_LENGTH) || '(unnamed test)';
  if (result.error) return `- ${name}: error: ${clip(result.error, MAX_VALUE_LENGTH)}`;
  return `- ${name}: expected ${clip(result.expected, MAX_VALUE_LENGTH)}, got ${clip(result.actual, MAX_VALUE_LENGTH)}`;
}

function describeOutcome(run) {
  if (run.status === 'error') {
    return [`The run could not execute: ${clip(run.error, MAX_VALUE_LENGTH * 2) || 'unknown error'}`];
  }
  if (run.status === 'passed') {
    return [`All ${run.total} tests passed.`];
  }
  const failing = (run.results || []).filter((result) => !result.ok);
  const lines = [`${run.passed}/${run.total} tests passed.`, 'Failing tests:'];
  lines.push(...failing.slice(0, MAX_FAILING_TESTS).map(describeFailingTest));
  if (failing.length > MAX_FAILING_TESTS) lines.push(`(+${failing.length - MAX_FAILING_TESTS} more)`);
  return lines;
}

/**
 * @param {Array<object>} runs - Unreported student runs, oldest first.
 * @param {object} [options]
 * @param {Date} [options.now] - Time of the student's message.
 * @param {number} [options.totalCount] - How many runs are pending in total
 *   (may exceed `runs.length` when only the latest ones were loaded).
 * @returns {string|null}
 */
export function buildTestRunNote(runs, { now = new Date(), totalCount } = {}) {
  if (!Array.isArray(runs) || runs.length === 0) return null;

  const latest = runs[runs.length - 1];
  const count = Math.max(Number(totalCount) || 0, runs.length);
  const [headline, ...details] = describeOutcome(latest);

  const lines = [
    '[Automatic context from the code editor. Not written by the student.]',
    `Since their previous message the student ran the test suite themself ${count} time${count === 1 ? '' : 's'} with the editor's "Run tests" button. You did not run these.`,
    `Most recent run (${describeAge(latest.createdAt, now)}, ${latest.language}): ${headline}`,
    ...details,
    'The student has already seen these results. The code may have changed since; use your editor tools if you need the current code or results. Treat this as background, not as a request, and do not mention this note.',
  ];

  const note = lines.join('\n');
  return note.length > MAX_NOTE_LENGTH ? `${note.slice(0, MAX_NOTE_LENGTH - 1)}…` : note;
}
