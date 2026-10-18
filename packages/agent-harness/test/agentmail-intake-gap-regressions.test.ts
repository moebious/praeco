import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateText, stepCountIs } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import { DEMO_TENANT_ID } from '@praeco/financial-decision-kernel';

import {
  AgentMailChannelAdapter,
  AiSdkSpecialistRunner,
  AssignmentService,
  HarnessError,
  InMemoryChannelInbox,
  InMemoryHarnessStore,
  computeAgentMailSignature,
  createEveTools,
  toAiSdkTools,
  validateAttachmentSignature,
  type AgentMailWebhookPayload,
  type ChannelInboxPort,
  type EvidencePort,
  type EvidenceRunReference,
  type ExternalPrincipalBinding,
  type InboundChannelMessage,
  type SpecialistToolDefinition,
  type TrustedExecutionContext,
} from '../src/index.js';

const SECRET = 'synthetic-agentmail-secret-key-12345';
const INSTALLATION = 'inst-agentmail-gaps';
const TENANT_B = 'tenant-competitor-corp';

const PDF_A = Buffer.from('%PDF-1.4\nInvoice A synthetic content\n%%EOF', 'utf8');
const PDF_B = Buffer.from('%PDF-1.4\nInvoice B synthetic content\n%%EOF', 'utf8');

function basePayload(overrides: Partial<AgentMailWebhookPayload> = {}): AgentMailWebhookPayload {
  return {
    tenantId: DEMO_TENANT_ID,
    installationId: INSTALLATION,
    messageId: 'msg-1001',
    from: 'billing@vendor.example',
    to: 'ap@blinka.example',
    subject: 'Invoice #1001',
    text: 'Please process the attached invoice',
    attachments: [{ filename: 'invoice-1001.pdf', mimeType: 'application/pdf', content: PDF_A }],
    ...overrides,
  };
}

function signed(payload: AgentMailWebhookPayload, secret = SECRET): AgentMailWebhookPayload {
  const withTimestamp = { ...payload, timestamp: Date.now() };
  return { ...withTimestamp, signature: computeAgentMailSignature(withTimestamp, secret) };
}

function makeAdapter(
  store: InMemoryHarnessStore,
  options: { secret?: string; evidencePort?: EvidencePort } = {}
): AgentMailChannelAdapter {
  const service = new AssignmentService({ store });
  return new AgentMailChannelAdapter({
    store,
    service,
    evidencePort: options.evidencePort,
    ...(options.secret
      ? { webhookSecret: options.secret }
      : { allowUnsignedSyntheticWebhook: true }),
  });
}

function executionContext(tenantId = DEMO_TENANT_ID, signal?: AbortSignal): TrustedExecutionContext {
  return {
    principal: {
      tenantId,
      principalId: 'principal-eve-test',
      roles: ['EVE'],
      bindingRevision: 'rev-test',
    },
    assignmentId: 'asgn-test',
    workerPrincipalId: 'worker-test',
    workerVersionId: 'v1.0.0',
    runId: 'run-test',
    ownershipEpoch: 1,
    ...(signal ? { signal } : {}),
  };
}

function adminBinding(overrides: Partial<ExternalPrincipalBinding> = {}): ExternalPrincipalBinding {
  return {
    tenantId: DEMO_TENANT_ID,
    provider: 'AGENTMAIL',
    installationId: INSTALLATION,
    providerUserId: 'cfo@blinka.example',
    principalId: 'principal-cfo',
    roles: ['FinanceAdmin'],
    bindingRevision: 'rev-1',
    revoked: false,
    ...overrides,
  };
}

function inboxMessage(overrides: Partial<InboundChannelMessage> = {}): InboundChannelMessage {
  return {
    id: 'msg-eve-1',
    tenantId: DEMO_TENANT_ID,
    connectionId: INSTALLATION,
    provider: 'AGENTMAIL',
    from: 'billing@vendor.example',
    to: 'ap@blinka.example',
    subject: 'Invoice',
    text: 'Please process the attached invoice',
    attachments: [],
    receivedAt: '2026-10-18T12:00:00Z',
    status: 'PENDING',
    ...overrides,
  };
}

function scriptedEvidencePort(options: { failOnName?: string; corruptHashFor?: string } = {}) {
  const calls: Array<{ displayName: string; originMessageId: string; bytes: Uint8Array }> = [];
  const port: EvidencePort = {
    async ingestSource(params): Promise<EvidenceRunReference> {
      calls.push({
        displayName: params.displayName ?? '',
        originMessageId: params.originMessageId ?? '',
        bytes: params.bytes,
      });
      if (options.failOnName !== undefined && params.displayName === options.failOnName) {
        throw new HarnessError('L1_PROCESSING_FAILED', `Synthetic L1 failure for ${params.displayName}`);
      }
      const hash = createHash('sha256').update(params.bytes).digest('hex');
      return {
        sourceId: `src-${hash.slice(0, 12)}`,
        sourceHashSha256:
          options.corruptHashFor !== undefined && params.displayName === options.corruptHashFor
            ? `corrupted-${hash.slice(0, 8)}`
            : hash,
        pipelineRunId: `pipe-${hash.slice(0, 8)}`,
        sourceDisposition: 'SUPPLEMENTAL_CONTEXT',
        envelopeIds: [],
      };
    },
    async loadRun(reference: EvidenceRunReference): Promise<EvidenceRunReference> {
      return reference;
    },
    async loadReady(): Promise<never> {
      throw new Error('loadReady is not exercised by these tests');
    },
  };
  return { port, calls };
}

describe('AgentMail intake gap regressions (PR #34 follow-up)', () => {
  it('requires an explicit webhook secret or explicit synthetic-only mode', () => {
    const store = new InMemoryHarnessStore();
    const service = new AssignmentService({ store });
    expect(() => new AgentMailChannelAdapter({ store, service })).toThrow('WEBHOOK_SECRET_REQUIRED');
    expect(
      () =>
        new AgentMailChannelAdapter({
          store,
          service,
          webhookSecret: SECRET,
          allowUnsignedSyntheticWebhook: true,
        })
    ).toThrow('INVALID_WEBHOOK_CONFIGURATION');
  });

  it('accepts unsigned payloads only through the explicit synthetic-only mode', async () => {
    const store = new InMemoryHarnessStore();
    const adapter = makeAdapter(store);
    const res = await adapter.handleAgentMailWebhook(basePayload());
    expect(res.isDuplicate).toBe(false);
    expect(res.evidenceRefs).toEqual([]);
  });

  it('never grants binding roles to an email sender address', async () => {
    const store = new InMemoryHarnessStore();
    await store.registerPrincipalBinding(adminBinding());
    const adapter = makeAdapter(store, { secret: SECRET });
    const res = await adapter.handleAgentMailWebhook(
      signed({ ...basePayload(), from: 'cfo@blinka.example' })
    );
    expect(res.principal.roles).toEqual(['InboundSender']);
    expect(res.principal.principalId).toBe('agentmail-sender-cfo_blinka_example');
    expect(res.principal.bindingRevision).toBe('revocation-checked:rev-1');
    const assignment = await store.getAssignment(DEMO_TENANT_ID, res.assignmentId);
    expect(assignment?.requestedByPrincipalId).toBe('agentmail-sender-cfo_blinka_example');
  });

  it('still rejects revoked address bindings', async () => {
    const store = new InMemoryHarnessStore();
    await store.registerPrincipalBinding(adminBinding({ revoked: true }));
    const adapter = makeAdapter(store, { secret: SECRET });
    await expect(
      adapter.handleAgentMailWebhook(signed({ ...basePayload(), from: 'cfo@blinka.example' }))
    ).rejects.toThrow('REVOKED_CHANNEL_USER');
  });

  it('processes every attachment through L1 and links all of them before queueing', async () => {
    const store = new InMemoryHarnessStore();
    const { port, calls } = scriptedEvidencePort();
    const adapter = makeAdapter(store, { secret: SECRET, evidencePort: port });
    const res = await adapter.handleAgentMailWebhook(
      signed(
        basePayload({
          attachments: [
            { filename: 'invoice-a.pdf', mimeType: 'application/pdf', content: PDF_A },
            { filename: 'invoice-b.pdf', mimeType: 'application/pdf', content: PDF_B },
          ],
        })
      )
    );
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((c) => c.originMessageId)).size).toBe(2);
    expect(calls.map((c) => c.originMessageId).every((o) => o.startsWith('agentmail-evt-msg-1001:'))).toBe(true);
    expect(res.evidenceRefs).toHaveLength(2);
    expect(res.evidenceRef?.sourceId).toBe(res.evidenceRefs[0]?.sourceId);
    const caseData = await store.getCase(DEMO_TENANT_ID, res.caseId);
    const documents = caseData?.sourceLinks.filter((link) => link.kind === 'DOCUMENT') ?? [];
    expect(documents).toHaveLength(2);
  });

  it('leaves no accepted work when L1 processing fails, and a retry repairs it', async () => {
    const store = new InMemoryHarnessStore();
    const failing = scriptedEvidencePort({ failOnName: 'invoice-b.pdf' });
    const adapter = makeAdapter(store, { secret: SECRET, evidencePort: failing.port });
    const payload = signed(
      basePayload({
        attachments: [
          { filename: 'invoice-a.pdf', mimeType: 'application/pdf', content: PDF_A },
          { filename: 'invoice-b.pdf', mimeType: 'application/pdf', content: PDF_B },
        ],
      })
    );
    await expect(adapter.handleAgentMailWebhook(payload)).rejects.toThrow('L1_PROCESSING_FAILED');
    expect(await store.listAssignments(DEMO_TENANT_ID)).toHaveLength(0);
    expect(
      await store.getInboundReceipt(DEMO_TENANT_ID, 'AGENTMAIL', INSTALLATION, 'agentmail-evt-msg-1001')
    ).toBeNull();
    expect(store.outboxEvents).toHaveLength(0);

    const working = scriptedEvidencePort();
    const repaired = await makeAdapter(store, { secret: SECRET, evidencePort: working.port }).handleAgentMailWebhook(payload);
    expect(repaired.isDuplicate).toBe(false);
    const caseData = await store.getCase(DEMO_TENANT_ID, repaired.caseId);
    expect(caseData?.sourceLinks.filter((link) => link.kind === 'DOCUMENT')).toHaveLength(2);
  });

  it('fails closed when the L1 reference hash does not match the attachment bytes', async () => {
    const store = new InMemoryHarnessStore();
    const { port } = scriptedEvidencePort({ corruptHashFor: 'invoice-1001.pdf' });
    const adapter = makeAdapter(store, { secret: SECRET, evidencePort: port });
    await expect(adapter.handleAgentMailWebhook(signed(basePayload()))).rejects.toThrow(
      'EVIDENCE_SOURCE_HASH_MISMATCH'
    );
    expect(await store.listAssignments(DEMO_TENANT_ID)).toHaveLength(0);
  });

  it('redelivery is idempotent: same assignment, no duplicated documentary links', async () => {
    const store = new InMemoryHarnessStore();
    const { port } = scriptedEvidencePort();
    const adapter = makeAdapter(store, { secret: SECRET, evidencePort: port });
    const payload = signed(basePayload());
    const first = await adapter.handleAgentMailWebhook(payload);
    const replay = await adapter.handleAgentMailWebhook(payload);
    expect(replay.assignmentId).toBe(first.assignmentId);
    expect(replay.isDuplicate).toBe(true);
    const caseData = await store.getCase(DEMO_TENANT_ID, first.caseId);
    expect(caseData?.sourceLinks.filter((link) => link.kind === 'DOCUMENT')).toHaveLength(1);
  });

  it('rejects unsupported attachment types before any work is accepted', async () => {
    expect(() => validateAttachmentSignature('text/plain', 'notes.txt', Buffer.from('notes'))).toThrow(
      'UNSUPPORTED_ATTACHMENT_TYPE'
    );
    const store = new InMemoryHarnessStore();
    const adapter = makeAdapter(store, { secret: SECRET });
    await expect(
      adapter.handleAgentMailWebhook(
        signed(
          basePayload({
            attachments: [{ filename: 'notes.txt', mimeType: 'text/plain', content: Buffer.from('notes') }],
          })
        )
      )
    ).rejects.toThrow('UNSUPPORTED_ATTACHMENT_TYPE');
    expect(await store.listAssignments(DEMO_TENANT_ID)).toHaveLength(0);
  });
});

describe('AI SDK boundary gap regressions (PR #34 follow-up)', () => {
  const eveProbe: SpecialistToolDefinition<{ value: string }, { result: string }> = {
    name: 'eve_probe',
    description: 'Eve probe tool',
    allowedRoles: ['EVE'],
    schema: z.object({ value: z.string() }),
    async execute(params) {
      return { result: params.value };
    },
  };

  const novaProbe: SpecialistToolDefinition<{ value: string }, { result: string }> = {
    name: 'nova_probe',
    description: 'Nova probe tool',
    allowedRoles: ['NOVA'],
    schema: z.object({ value: z.string() }),
    async execute(params) {
      return { result: params.value };
    },
  };

  it('filters the tool map by the server-bound role', () => {
    const eveMap = toAiSdkTools([eveProbe, novaProbe], executionContext(), 'EVE');
    expect(Object.keys(eveMap)).toEqual(['eve_probe']);
    const novaMap = toAiSdkTools([eveProbe, novaProbe], executionContext(), 'NOVA');
    expect(Object.keys(novaMap)).toEqual(['nova_probe']);
  });

  it('executes adapted tools through the pinned AI SDK with an offline mock model', async () => {
    const contexts: TrustedExecutionContext[] = [];
    const probe: SpecialistToolDefinition<{ value: string }, { result: string }> = {
      name: 'probe',
      description: 'Synthetic probe',
      allowedRoles: ['EVE'],
      schema: z.object({ value: z.string() }).strict(),
      async execute(params, context) {
        contexts.push(context);
        return { result: params.value };
      },
    };
    const tools = toAiSdkTools([probe], executionContext(), 'EVE');
    expect(tools['probe']?.inputSchema).toBeDefined();

    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [
          { type: 'tool-call' as const, toolCallId: 'offline-call', toolName: 'probe', input: '{"value":"synthetic"}' },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 10, text: 10, reasoning: 0 },
        },
        warnings: [],
      }),
    });
    const result = await generateText({
      model,
      tools,
      prompt: 'Run the synthetic probe',
      stopWhen: stepCountIs(1),
      maxRetries: 0,
    });
    expect(result.toolResults[0]?.output).toEqual({ result: 'synthetic' });
    expect(contexts[0]?.principal.tenantId).toBe(DEMO_TENANT_ID);
  });

  it('honors the real SDK abortSignal option and the trusted context signal', async () => {
    const tools = toAiSdkTools([eveProbe], executionContext(), 'EVE');
    const sdkShaped = new AbortController();
    sdkShaped.abort();
    await expect(
      tools['eve_probe']!.execute({ value: 'x' }, { toolCallId: 'probe-1', messages: [], abortSignal: sdkShaped.signal })
    ).rejects.toThrow('EXECUTION_ABORTED');

    const contextSignal = new AbortController();
    contextSignal.abort();
    const boundTools = toAiSdkTools([eveProbe], executionContext(DEMO_TENANT_ID, contextSignal.signal), 'EVE');
    await expect(
      boundTools['eve_probe']!.execute({ value: 'x' }, { toolCallId: 'probe-2', messages: [] })
    ).rejects.toThrow('EXECUTION_ABORTED');
  });

  it('redacts raw tool inputs and outputs from step records', async () => {
    const probe: SpecialistToolDefinition<{ value: string }, { secret: string }> = {
      name: 'secret_probe',
      description: 'Secret probe',
      allowedRoles: ['EVE'],
      schema: z.object({ value: z.string() }),
      async execute(params) {
        return { secret: params.value };
      },
    };
    const runner = new AiSdkSpecialistRunner({ limits: { maxSteps: 2, timeoutMs: 5_000 } });
    const result = await runner.executeBoundedLoop(
      'EVE',
      toAiSdkTools([probe], executionContext(), 'EVE'),
      [{ toolName: 'secret_probe', params: { value: 'SYNTHETIC-SECRET-PAYLOAD' } }],
      executionContext()
    );
    expect(result.history[0]?.inputSummary).toBe('(redacted)');
    expect(result.history[0]?.outputSummary).toBe('(redacted)');
    expect(JSON.stringify(result.history)).not.toContain('SYNTHETIC-SECRET-PAYLOAD');
  });

  it('swallows late rejections from tools that outlive the deadline', async () => {
    const unhandled: unknown[] = [];
    const handler = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', handler);
    try {
      const lateTool: SpecialistToolDefinition<any, any> = {
        name: 'late_tool',
        description: 'Rejects after the deadline',
        allowedRoles: ['EVE'],
        schema: z.object({}),
        async execute() {
          await new Promise((_, reject) => {
            setTimeout(() => reject(new Error('late rejection')), 60);
          });
        },
      };
      const runner = new AiSdkSpecialistRunner({ limits: { maxSteps: 1, timeoutMs: 10 } });
      await expect(
        runner.executeBoundedLoop(
          'EVE',
          toAiSdkTools([lateTool], executionContext(), 'EVE'),
          [{ toolName: 'late_tool', params: {} }],
          executionContext()
        )
      ).rejects.toThrow('EXECUTION_DEADLINE_EXCEEDED');
      await new Promise((resolve) => {
        setTimeout(resolve, 150);
      });
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', handler);
    }
  });
});

describe('Eve hardening gap regressions (PR #34 follow-up)', () => {
  it('correlates as the unprivileged InboundSender even for a registered admin address', async () => {
    const store = new InMemoryHarnessStore();
    const service = new AssignmentService({ store });
    await store.registerPrincipalBinding(adminBinding());
    const inbox = new InMemoryChannelInbox();
    inbox.addMessage(inboxMessage({ from: 'cfo@blinka.example' }));
    const tools = createEveTools({ store, service, inbox });
    const correlate = tools.find((t) => t.name === 'eve_correlate_payable_case')!;
    const view = await correlate.execute({ messageId: 'msg-eve-1' }, executionContext());
    const assignment = await store.getAssignment(DEMO_TENANT_ID, view.assignmentId);
    expect(assignment?.requestedByPrincipalId).toBe('agentmail-sender-cfo_blinka_example');
  });

  it('rejects rows a faulty inbox port returns for another tenant', async () => {
    const store = new InMemoryHarnessStore();
    const service = new AssignmentService({ store });
    const faulty: ChannelInboxPort = {
      async listMessages() {
        return [];
      },
      async getMessage() {
        return inboxMessage({ tenantId: TENANT_B });
      },
      async markProcessed() {
        // faulty port: no-op
      },
    };
    const tools = createEveTools({ store, service, inbox: faulty });
    const inspect = tools.find((t) => t.name === 'eve_inspect_inbound_message')!;
    await expect(inspect.execute({ messageId: 'msg-eve-1' }, executionContext())).rejects.toThrow(
      'CROSS_TENANT_MESSAGE'
    );
  });

  it('returns detached message copies that cannot mutate stored attachments', async () => {
    const inbox = new InMemoryChannelInbox();
    const content = Buffer.from('%PDF-1.4\nOriginal bytes\n%%EOF', 'utf8');
    inbox.addMessage(
      inboxMessage({
        attachments: [{ filename: 'doc.pdf', mimeType: 'application/pdf', content }],
      })
    );
    const first = await inbox.getMessage(DEMO_TENANT_ID, 'msg-eve-1');
    expect(first).toBeDefined();
    first!.attachments[0]!.content[0] = 0x24;
    const second = await inbox.getMessage(DEMO_TENANT_ID, 'msg-eve-1');
    expect(second!.attachments[0]!.content[0]).toBe(0x25);
  });
});
