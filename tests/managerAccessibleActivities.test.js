import { afterEach, describe, expect, test, vi } from 'vitest';
vi.mock('axios', () => ({ default: { get: vi.fn() } }));
import axios from 'axios';
import ManagerService from '../src/services/v1/ManagerService.js';
import { getAllExperimentsByQuery } from '../src/controllers/v1/managerController.js';
afterEach(() => vi.restoreAllMocks());
describe('Workbench accessible activities', () => {
  test('forwards user authentication, search, ownership and cursor to Designer accessible endpoint', async () => {
    const page = { experiments: [{ id: 'shared' }], nextCursor: 'cursor' };
    axios.get.mockResolvedValue({ data: page });
    expect(await ManagerService.findAccessibleExperiments('Bearer user-token', 'cursor', 'activity', 'true')).toEqual(page);
    const [url, options] = axios.get.mock.lastCall;
    expect(url).toMatch(/\/api\/v1\/experiments\/accessible$/);
    expect(options.headers.Authorization).toBe('Bearer user-token');
    expect(options.params).toEqual({ lastActivityId: 'cursor', text: 'activity', ownedOnly: 'true' });
  });
  test.each(['admin', 'advanced'])('uses accessible scope for %s', async (role) => {
    const page = { experiments: [], nextCursor: null };
    const spy = vi.spyOn(ManagerService, 'findAccessibleExperiments').mockResolvedValue(page);
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await getAllExperimentsByQuery({ auth: { payload: { role } }, headers: { authorization: 'Bearer token' }, query: {} }, res, vi.fn());
    expect(spy).toHaveBeenCalledWith('Bearer token', undefined, undefined, undefined);
    expect(res.json).toHaveBeenCalledWith(page);
  });
  test('propagates Designer failures', async () => {
    const error = new Error('Designer unavailable');
    vi.spyOn(ManagerService, 'findAccessibleExperiments').mockRejectedValue(error);
    const next = vi.fn();
    await getAllExperimentsByQuery({ headers: {}, query: {} }, {}, next);
    expect(next).toHaveBeenCalledWith(error);
  });
});
