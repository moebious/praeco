import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  createScenarioStore,
  FinancialAuthorizationService,
  DEMO_TENANT_ID,
  buildScenarios,
  decimal,
  type EnvelopeResolver,
  type ReadyInvoiceEnvelope,
  type TrustedActorContext,
} from '@praeco/financial-decision-kernel';
import { renderDashboardHtml } from './html.js';

class WebEnvelopeResolver implements EnvelopeResolver {
  private readonly store = new Map<string, ReadyInvoiceEnvelope>();

  public register(envelope: ReadyInvoiceEnvelope) {
    this.store.set(envelope.envelopeId, envelope);
  }

  public async resolveEnvelopes(
    tenantId: string,
    envelopeIds: readonly string[]
  ): Promise<readonly ReadyInvoiceEnvelope[]> {
    return envelopeIds.map(id => {
      const env = this.store.get(id);
      if (!env || env.source.tenantId !== tenantId) {
        throw new Error(`ENVELOPE_NOT_FOUND: ${id}`);
      }
      return env;
    });
  }
}

interface WebState {
  rules: {
    policyRevisionId: string;
    maxAutoApproveUsd: string;
    defaultRecurringTolerancePct: string;
    budgetUsd: string;
    /** True only after the company explicitly saves a custom budget; canonical per-scenario budgets apply otherwise. */
    budgetCustomized: boolean;
    spentUsd: string;
  };
  activeServices: Map<string, { service: FinancialAuthorizationService; approvalRequestId?: string }>;
}

let policyRevCounter = 1;

const state: WebState = {
  rules: {
    policyRevisionId: 'pol-blinka-demo-v1',
    maxAutoApproveUsd: '2500.00',
    defaultRecurringTolerancePct: '5.00',
    budgetUsd: '5000.00',
    budgetCustomized: false,
    spentUsd: '0.00',
  },
  activeServices: new Map(),
};

const workerActor: TrustedActorContext = {
  tenantId: DEMO_TENANT_ID,
  principalId: 'worker-agent-demo',
  roles: ['WorkerAgent'],
};

// Demo-grade authentication: every mutating endpoint requires a server-held
// token. Admin identity (the FinanceAdmin principal) derives from token
// possession, never from client-supplied headers. Set PRAECO_DASHBOARD_TOKEN
// for a stable value; otherwise a random per-process token is generated.
const dashboardToken =
  process.env.PRAECO_DASHBOARD_TOKEN || `praeco-demo-${randomUUID()}`;

const cfoActor: TrustedActorContext = {
  tenantId: DEMO_TENANT_ID,
  principalId: 'cfo-finance-admin',
  roles: ['FinanceAdmin'],
};

function hasValidToken(req: IncomingMessage): boolean {
  const provided = req.headers['x-praeco-token'];
  return typeof provided === 'string' && provided.length > 0 && provided === dashboardToken;
}

async function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-praeco-token',
  });
  res.end(JSON.stringify(data));
}

export function startWebServer(port = Number(process.env.PORT || 3000)) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-praeco-token',
      });
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderDashboardHtml());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/rules') {
      sendJson(res, 200, state.rules);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/rules') {
      try {
        if (!hasValidToken(req)) {
          sendJson(res, 403, { error: 'DASHBOARD_TOKEN_REQUIRED: set the x-praeco-token header (token is printed at server startup)' });
          return;
        }
        const body = await parseBody(req);
        if (body.maxAutoApproveUsd) state.rules.maxAutoApproveUsd = body.maxAutoApproveUsd;
        if (body.defaultRecurringTolerancePct) state.rules.defaultRecurringTolerancePct = body.defaultRecurringTolerancePct;
        if (body.budgetUsd) {
          state.rules.budgetUsd = body.budgetUsd;
          state.rules.budgetCustomized = true;
        }
        state.rules.policyRevisionId = `pol-blinka-demo-v${++policyRevCounter}`;
        sendJson(res, 200, state.rules);
      } catch (err: any) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/reset') {
      if (!hasValidToken(req)) {
        sendJson(res, 403, { error: 'DASHBOARD_TOKEN_REQUIRED: set the x-praeco-token header (token is printed at server startup)' });
        return;
      }
      state.activeServices.clear();
      state.rules.policyRevisionId = 'pol-blinka-demo-v1';
      state.rules.maxAutoApproveUsd = '2500.00';
      state.rules.defaultRecurringTolerancePct = '5.00';
      state.rules.budgetUsd = '5000.00';
      state.rules.budgetCustomized = false;
      state.rules.spentUsd = '0.00';
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/run-all') {
      try {
        const scenarios = buildScenarios();
        state.activeServices.clear();
        const results = [];

        for (const s of scenarios) {
          const store = createScenarioStore(s.id);
          // Apply custom rules if configured with updated policyRevisionId
          store.policy.policyRevisionId = state.rules.policyRevisionId;
          store.policy.maxAutoApproveUsd = state.rules.maxAutoApproveUsd;
          store.policy.defaultRecurringTolerancePct = state.rules.defaultRecurringTolerancePct;

          // Apply a custom budget only when the company explicitly saved one;
          // otherwise each scenario keeps its canonical seeded budget.
          if (state.rules.budgetCustomized) {
            const octBudget = store.budgets.get('BUDGET-2026-10');
            if (octBudget) {
              octBudget.limitUsd = state.rules.budgetUsd;
              // Structural change to the limit entry: approvals must be
              // re-grounded against the new budget envelope.
              octBudget.limitRevision += 1;
            }
          }

          const resolver = new WebEnvelopeResolver();
          resolver.register(s.envelope);
          const service = new FinancialAuthorizationService(store, resolver);

          const record = await service.decideAndCommit(
            {
              proposal: {
                payableCaseId: `case-${s.id.toLowerCase()}`,
                envelopeIds: [s.envelope.envelopeId],
              },
              idempotencyKey: `idem-web-${s.id}`,
              workerId: 'worker-agent-demo',
              agentGrantRef: 'grant-synthetic-worker',
            },
            workerActor
          );

          state.activeServices.set(s.id, {
            service,
            approvalRequestId: record.approvalRequestId ?? undefined,
          });

          results.push({
            scenarioId: s.id,
            title: s.title,
            claim: s.claim,
            expected: s.expected,
            ...record,
          });
        }

        // Sum actual commitments across all active stores using exact decimals
        let totalSpent = decimal(0);
        for (const entry of state.activeServices.values()) {
          for (const c of entry.service.store.commitments.values()) {
            totalSpent = totalSpent.add(decimal(c.unroundedUsd));
          }
        }
        state.rules.spentUsd = totalSpent.toFixed(2);
        sendJson(res, 200, { decisions: results, spentUsd: state.rules.spentUsd });
      } catch (err: any) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/approve') {
      try {
        if (!hasValidToken(req)) {
          sendJson(res, 403, { error: 'DASHBOARD_TOKEN_REQUIRED: set the x-praeco-token header (token is printed at server startup)' });
          return;
        }

        const { approvalRequestId, scenarioId } = await parseBody(req);
        const entry = state.activeServices.get(scenarioId);
        if (!entry) throw new Error('SESSION_NOT_FOUND');

        const record = await entry.service.resolveApproval(
          {
            approvalRequestId,
            idempotencyKey: `idem-approve-${approvalRequestId}`,
            action: 'APPROVE',
          },
          cfoActor
        );

        // Update spent dynamically from actual store commitments
        let totalSpent = decimal(0);
        for (const e of state.activeServices.values()) {
          for (const c of e.service.store.commitments.values()) {
            totalSpent = totalSpent.add(decimal(c.unroundedUsd));
          }
        }
        state.rules.spentUsd = totalSpent.toFixed(2);
        sendJson(res, 200, record);
      } catch (err: any) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/reject') {
      try {
        if (!hasValidToken(req)) {
          sendJson(res, 403, { error: 'DASHBOARD_TOKEN_REQUIRED: set the x-praeco-token header (token is printed at server startup)' });
          return;
        }

        const { approvalRequestId, scenarioId } = await parseBody(req);
        const entry = state.activeServices.get(scenarioId);
        if (!entry) throw new Error('SESSION_NOT_FOUND');

        const record = await entry.service.resolveApproval(
          {
            approvalRequestId,
            idempotencyKey: `idem-reject-${approvalRequestId}`,
            action: 'REJECT',
          },
          cfoActor
        );
        sendJson(res, 200, record);
      } catch (err: any) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    sendJson(res, 404, { error: 'NOT_FOUND' });
  });

  // Bind to loopback by default so the demo dashboard is never exposed beyond
  // the local machine; set PRAECO_DASHBOARD_HOST to override deliberately.
  const host = process.env.PRAECO_DASHBOARD_HOST ?? '127.0.0.1';
  server.listen(port, host, () => {
    console.log(`\n🚀 Praeco Financial Dashboard running on http://${host === '127.0.0.1' ? 'localhost' : host}:${port}`);
    if (!process.env.PRAECO_DASHBOARD_TOKEN) {
      console.log(`🔑 FinanceAdmin token for this session (set PRAECO_DASHBOARD_TOKEN to override): ${dashboardToken}\n`);
    }
  });

  return server;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  startWebServer();
}
