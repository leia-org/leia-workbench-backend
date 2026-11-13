import { describe, expect, test } from 'vitest';
import { createTestRunValidator, MAX_CODE_LENGTH, MAX_RESULTS } from '../src/validators/v1/testRunValidator.js';
import { csvCell, csvRow } from '../src/utils/csv.js';

const valid = {
  clientRunId: 'b6f6b0a2-6f0a-4d0e-9a55-2f1f3f7d9c11',
  trigger: 'student',
  language: 'python',
  fnName: 'two_sum',
  code: 'def two_sum(nums, target):\n    return []',
  results: [{ name: 't1', ok: false, expected: '[0, 1]', actual: '[]' }],
  durationMs: 40,
  clientRunAt: '2026-11-13T10:00:00.000Z',
};

const validate = (body) => createTestRunValidator.validateAsync(body, { stripUnknown: true });

describe('createTestRunValidator', () => {
  test('acepta un informe válido y descarta los contadores que envíe el cliente', async () => {
    const value = await validate({ ...valid, passed: 50, status: 'passed', reportedToLeiaAt: '2026-01-01' });

    expect(value).not.toHaveProperty('passed');
    expect(value).not.toHaveProperty('status');
    expect(value).not.toHaveProperty('reportedToLeiaAt');
    expect(value.codeTruncated).toBe(false);
    expect(value.error).toBeNull();
  });

  test('acepta un error de suite sin resultados', async () => {
    const value = await validate({ ...valid, results: [], error: 'SyntaxError' });
    expect(value.results).toEqual([]);
  });

  test('exige resultados o error', async () => {
    await expect(validate({ ...valid, results: [] })).rejects.toMatchObject({ isJoi: true });
  });

  test.each([
    ['trigger desconocido', { trigger: 'teacher' }],
    ['lenguaje no ejecutable', { language: 'text' }],
    ['código demasiado largo', { code: 'x'.repeat(MAX_CODE_LENGTH + 1) }],
    ['demasiados resultados', { results: Array.from({ length: MAX_RESULTS + 1 }, () => ({ name: 't', ok: true })) }],
    ['resultado sin ok', { results: [{ name: 't' }] }],
    ['valor esperado no serializado', { results: [{ name: 't', ok: false, expected: [1, 2] }] }],
  ])('rechaza %s', async (_label, override) => {
    await expect(validate({ ...valid, ...override })).rejects.toMatchObject({ isJoi: true });
  });
});

describe('utilidades CSV', () => {
  test('solo entrecomilla cuando hace falta y dobla las comillas', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell(12)).toBe('12');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  test('csvRow une las celdas y termina la fila', () => {
    expect(csvRow(['a', 'b,c', 3])).toBe('a,"b,c",3\n');
  });
});
