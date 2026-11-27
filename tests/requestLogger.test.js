import { describe, expect, test, beforeEach, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  default: { debug: vi.fn(), isLevelEnabled: vi.fn() },
}));

import logger from '../src/utils/logger.js';
import requestLogger from '../src/middlewares/requestLogger.js';

const request = (path, body) => ({
  method: 'POST',
  originalUrl: `/api/v1${path}`,
  path: `/api/v1${path}`,
  headers: {},
  query: {},
  body,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('requestLogger', () => {
  test('no serializa nada si el nivel debug está desactivado', () => {
    logger.isLevelEnabled.mockReturnValue(false);
    const next = vi.fn();

    requestLogger(request('/interactions/s1/messages', { message: 'hi' }), {}, next);

    expect(logger.debug).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('en debug registra la petición, pero nunca el cuerpo de los eventos de interacción', () => {
    logger.isLevelEnabled.mockReturnValue(true);

    requestLogger(request('/interactions/s1/messages', { message: 'hi' }), {}, vi.fn());
    expect(logger.debug.mock.calls[0][0]).toContain('"message": "hi"');

    requestLogger(
      request('/interactions/s1/events', { events: [{ type: 'clipboard_paste', content: 'pasted secret' }] }),
      {},
      vi.fn()
    );
    expect(logger.debug.mock.calls[1][0]).not.toContain('pasted secret');
    expect(logger.debug.mock.calls[1][0]).toContain('interaction events omitted');
  });
});
