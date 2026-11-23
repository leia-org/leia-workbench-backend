import { describe, expect, test } from 'vitest';
import { buildTestRunNote, MAX_NOTE_LENGTH } from '../src/utils/testRunNote.js';

const now = new Date('2026-11-13T10:10:00.000Z');

const failedRun = {
  status: 'failed',
  language: 'javascript',
  passed: 1,
  total: 3,
  results: [
    { name: 'basic', ok: true },
    { name: 'empty list', ok: false, expected: '[]', actual: 'undefined' },
    { name: 'negative numbers', ok: false, error: 'TypeError: x is not iterable' },
  ],
  createdAt: new Date('2026-11-13T10:07:00.000Z'),
};

describe('buildTestRunNote — contexto oculto para el LEIA', () => {
  test('sin ejecuciones no hay nota', () => {
    expect(buildTestRunNote([])).toBeNull();
    expect(buildTestRunNote(null)).toBeNull();
  });

  test('describe la última ejecución fallida con sus tests', () => {
    const note = buildTestRunNote([failedRun], { now });

    expect(note.startsWith('[Automatic context from the code editor. Not written by the student.]')).toBe(true);
    expect(note).toContain('ran the test suite themself 1 time with');
    expect(note).toContain('Most recent run (3 min before this message, javascript): 1/3 tests passed.');
    expect(note).toContain('- empty list: expected [], got undefined');
    expect(note).toContain('- negative numbers: error: TypeError: x is not iterable');
    expect(note).not.toContain('- basic');
    expect(note).toContain('do not mention this note');
  });

  test('cuenta todas las ejecuciones pendientes aunque solo describa la última', () => {
    const earlier = { ...failedRun, createdAt: new Date('2026-11-13T10:01:00.000Z') };
    const note = buildTestRunNote([earlier, failedRun], { now, totalCount: 7 });

    expect(note).toContain('7 times');
  });

  test('variante: todos los tests pasan', () => {
    const note = buildTestRunNote(
      [{ status: 'passed', language: 'python', passed: 4, total: 4, results: [], createdAt: now }],
      { now }
    );

    expect(note).toContain('(less than a minute before this message, python): All 4 tests passed.');
    expect(note).not.toContain('Failing tests');
  });

  test('variante: la suite no pudo ejecutarse', () => {
    const note = buildTestRunNote(
      [{ status: 'error', language: 'python', error: 'SyntaxError: invalid syntax', results: [], createdAt: now }],
      { now }
    );

    expect(note).toContain('The run could not execute: SyntaxError: invalid syntax');
  });

  test('limita los tests fallidos listados y recorta valores largos', () => {
    const results = Array.from({ length: 9 }, (_, index) => ({
      name: `case ${index}`,
      ok: false,
      expected: 'e'.repeat(500),
      actual: 'a'.repeat(500),
    }));
    const note = buildTestRunNote([{ ...failedRun, passed: 0, total: 9, results }], { now });

    expect(note.match(/^- case /gm)).toHaveLength(5);
    expect(note).toContain('(+4 more)');
    expect(note).not.toContain('e'.repeat(201));
    expect(note.length).toBeLessThanOrEqual(MAX_NOTE_LENGTH);
  });
});
