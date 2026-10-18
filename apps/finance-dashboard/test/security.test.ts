import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';

const DASHBOARD_TOKEN = 'test-fixed-dashboard-token';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  // Must be set before the server module loads (the token is captured at import time).
  process.env.PRAECO_DASHBOARD_TOKEN = DASHBOARD_TOKEN;
  const { startWebServer } = await import('../src/server.js');
  server = startWebServer(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

function post(path: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-praeco-token': token } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('finance-dashboard admin endpoint security', () => {
  it('keeps read endpoints public', async () => {
    const res = await fetch(`${baseUrl}/api/rules`);
    expect(res.status).toBe(200);
  });

  it('rejects policy rule changes without the dashboard token', async () => {
    const res = await post('/api/rules', { maxAutoApproveUsd: '3000.00' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain('DASHBOARD_TOKEN_REQUIRED');
  });

  it('rejects policy rule changes with a wrong dashboard token', async () => {
    const res = await post('/api/rules', { maxAutoApproveUsd: '3000.00' }, 'wrong-token');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain('DASHBOARD_TOKEN_REQUIRED');
  });

  it('accepts policy rule changes with the correct dashboard token', async () => {
    const res = await post('/api/rules', { maxAutoApproveUsd: '3000.00' }, DASHBOARD_TOKEN);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { maxAutoApproveUsd: string }).maxAutoApproveUsd).toBe('3000.00');
  });

  it('rejects the reset endpoint without the token and accepts it with the token', async () => {
    const denied = await post('/api/reset', {});
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: string }).error).toContain('DASHBOARD_TOKEN_REQUIRED');

    const allowed = await post('/api/reset', {}, DASHBOARD_TOKEN);
    expect(allowed.status).toBe(200);
    expect(((await allowed.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('rejects run-all without the token and accepts it with the token', async () => {
    const denied = await post('/api/run-all', {});
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: string }).error).toContain('DASHBOARD_TOKEN_REQUIRED');

    const allowed = await post('/api/run-all', {}, DASHBOARD_TOKEN);
    expect(allowed.status).toBe(200);
    const body = (await allowed.json()) as { decisions: unknown[]; spentUsd: string };
    expect(body.decisions).toHaveLength(8);
  });

  it('rejects approve and reject without the dashboard token', async () => {
    const approve = await post('/api/approve', { approvalRequestId: 'x', scenarioId: 'BLINKA-03' });
    expect(approve.status).toBe(403);
    expect(((await approve.json()) as { error: string }).error).toContain('DASHBOARD_TOKEN_REQUIRED');

    const reject = await post('/api/reject', { approvalRequestId: 'x', scenarioId: 'BLINKA-03' });
    expect(reject.status).toBe(403);
    expect(((await reject.json()) as { error: string }).error).toContain('DASHBOARD_TOKEN_REQUIRED');
  });
});
