import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({ default: { error: vi.fn() } }));
import errorHandler from '../src/middlewares/errorHandler.js';

beforeEach(() => vi.clearAllMocks());

describe('external API errors', () => {
  test.each([
    [{ message: 'Provider unavailable' }, 'Provider unavailable'],
    [{ error: 'Internal error sending message to LEIA' }, 'Internal error sending message to LEIA'],
    [{ error: { message: 'Invalid request' } }, 'Invalid request'],
    ['Upstream failed', 'Upstream failed'],
    [{}, 'Request failed with status code 500'],
  ])('reports the upstream error from %j', (data, message) => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    errorHandler({ isAxiosError: true, message: 'Request failed with status code 500', response: { status: 500, data } }, {}, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: `External API error: ${message}`, details: data }));
  });

  test('reports connection errors without a response', () => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    errorHandler({ isAxiosError: true, message: 'connect ECONNREFUSED' }, {}, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'External API error: connect ECONNREFUSED' }));
  });
});
