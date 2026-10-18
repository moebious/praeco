import "server-only"

import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { createL1, summarize, type InvoiceEnvelope, type L1Runtime } from "@praeco/evidence-intelligence"
import {
  DEMO_TENANT_ID,
  FinancialAuthorizationService,
  L1EvidenceReaderAdapter,
  createScenarioStore,
  type FinancialDecisionCommand,
  type FinancialDecisionRecord,
  type FinancialEvaluation,
  type HumanApprovalCommand,
  type ScenarioId,
  type TransactionalFinancialStore,
  type TrustedActorContext,
} from "@praeco/financial-decision-kernel"

import {
  getPayableCase,
  type PayableCaseDefinition,
  type PayableScenarioId,
  type PayableSourceDefinition,
} from "@/lib/finance/cases"
import {
  FINANCE_ADMIN_ROLE,
  FinanceWorkspaceError,
  idempotencyKeySchema,
  type PayableApprovalView,
  type PayableCaseView,
  type PayableEvidenceView,
  type PayableSourceView,
} from "@/lib/finance/contracts"

/**
 * Composition root of the payable surface.
 *
 * - Everything here is server-only and derived from the L1/L2 packages; nothing
 *   opens a resource at import time. `getFinanceRuntime()` is a lazy singleton.
 * - The runtime is in-process and demo-scoped (ADR-007): L1 evidence artifacts
 *   are file-backed and content-addressed, while the authorization ledger lives
 *   in memory and is empty again after a restart. Cross-process durability must
 *   never be claimed on any surface.
 * - Decisions are always derived by the kernel from verified evidence. This
 *   module never encodes an expected outcome.
 */

/** Synthetic worker and grant seeded by `createScenarioStore` for every case. */
const SYNTHETIC_WORKER_ID = "worker-agent-demo"
const SYNTHETIC_WORKER_GRANT_REF = "grant-synthetic-worker"

/** Directory holding the raw synthetic inputs; injected so tests stay isolated. */
export const DEFAULT_SOURCES_ROOT = join(process.cwd(), "fixtures", "payable-sources")
/** Ignored-dir default for L1 artifacts; never inside `public/`. */
export const DEFAULT_STORAGE_ROOT = join(process.cwd(), ".praeco-demo", "l1")

export interface FinanceRuntimeOptions {
  readonly sourcesRoot: string
  readonly storageRoot: string
}

interface CaseIntake {
  readonly sources: readonly PayableSourceView[]
  readonly readyEnvelopeIds: readonly string[]
}

export class FinanceRuntime {
  private readonly l1: L1Runtime
  private readonly sourcesRoot: string
  /** One ledger per case: isolated replay must never share a ledger. */
  private readonly services = new Map<string, FinancialAuthorizationService>()
  private readonly intakes = new Map<string, Promise<CaseIntake>>()
  private readonly histories = new Map<string, FinancialDecisionRecord[]>()
  private readonly previews = new Map<string, FinancialEvaluation>()

  constructor(options: FinanceRuntimeOptions) {
    this.sourcesRoot = resolve(options.sourcesRoot)
    this.l1 = createL1({ storageRoot: resolve(options.storageRoot) })
  }

  private requireCase(caseId: string): PayableCaseDefinition {
    const definition = getPayableCase(caseId)
    if (!definition) throw new FinanceWorkspaceError("CASE_NOT_FOUND")
    return definition
  }

  private serviceFor(caseId: string, scenarioId: PayableScenarioId): FinancialAuthorizationService {
    const existing = this.services.get(caseId)
    if (existing) return existing
    const store: TransactionalFinancialStore = createScenarioStore(scenarioId as ScenarioId)
    const service = new FinancialAuthorizationService(
      store,
      new L1EvidenceReaderAdapter(this.l1.reader)
    )
    this.services.set(caseId, service)
    return service
  }

  /** Raw bytes only: file names come from our own catalog, never from a request. */
  private async readSource(source: PayableSourceDefinition): Promise<Buffer> {
    try {
      return await readFile(join(this.sourcesRoot, source.file))
    } catch {
      throw new FinanceWorkspaceError("EVIDENCE_UNAVAILABLE")
    }
  }

  /** Safe projection: only the fields of `summarize()`, never accounts or raw invoice text. */
  private summarizeEnvelope(envelope: InvoiceEnvelope): PayableEvidenceView {
    const safe = summarize(envelope)
    return {
      envelopeId: safe.envelopeId,
      processingStatus: safe.processingStatus,
      verificationStatus: safe.verificationStatus,
      usdEquivalent: safe.usdEquivalent,
      issues: safe.issues,
      ready: safe.processingStatus === "READY_FOR_POLICY_EVALUATION",
    }
  }

  /** Runs the real L1 pipeline once per case and caches the derived envelope ids. */
  async intake(caseId: string): Promise<CaseIntake> {
    const cached = this.intakes.get(caseId)
    if (cached) return cached
    const definition = this.requireCase(caseId)
    const pending = this.runIntake(definition)
    this.intakes.set(caseId, pending)
    try {
      return await pending
    } catch (error) {
      this.intakes.delete(caseId)
      throw error
    }
  }

  private async runIntake(definition: PayableCaseDefinition): Promise<CaseIntake> {
    const sources: PayableSourceView[] = []
    const readyEnvelopeIds: string[] = []

    for (const source of definition.sources) {
      const bytes = await this.readSource(source)
      const registered = await this.l1.register({
        tenantId: DEMO_TENANT_ID,
        bytes,
        channel: source.channel,
        mimeType: source.mimeType,
        displayName: source.displayName,
      })
      const result = await this.l1.processWithReceipt(registered)
      const envelopes = result.envelopes.map((envelope) => this.summarizeEnvelope(envelope))
      for (const envelope of envelopes) if (envelope.ready) readyEnvelopeIds.push(envelope.envelopeId)
      sources.push({
        file: source.file,
        displayName: source.displayName,
        channel: source.channel,
        role: source.role,
        disposition: result.sourceDisposition,
        envelopes,
      })
    }

    return { sources, readyEnvelopeIds }
  }

  private command(
    caseId: string,
    envelopeIds: readonly string[],
    idempotencyKey: string
  ): FinancialDecisionCommand {
    return {
      proposal: { payableCaseId: caseId, envelopeIds },
      idempotencyKey,
      workerId: SYNTHETIC_WORKER_ID,
      agentGrantRef: SYNTHETIC_WORKER_GRANT_REF,
    }
  }

  private async commandWithEvidence(caseId: string, idempotencyKey: string) {
    const definition = this.requireCase(caseId)
    const { readyEnvelopeIds } = await this.intake(caseId)
    if (readyEnvelopeIds.length === 0) throw new FinanceWorkspaceError("EVIDENCE_NOT_READY")
    return {
      definition,
      service: this.serviceFor(caseId, definition.scenarioId),
      command: this.command(caseId, readyEnvelopeIds, idempotencyKey),
    }
  }

  private append(caseId: string, decision: FinancialDecisionRecord): void {
    const history = this.histories.get(caseId) ?? []
    if (!history.some((entry) => entry.decisionId === decision.decisionId)) history.push(decision)
    this.histories.set(caseId, history)
  }

  private previewKey(caseId: string, actor: TrustedActorContext): string {
    return `${caseId}:${actor.principalId}`
  }

  /** Evaluation only: no obligation, budget or receipt is written by the kernel. */
  async preview(caseId: string, actor: TrustedActorContext): Promise<FinancialEvaluation> {
    const { service, command } = await this.commandWithEvidence(caseId, `preview-${randomUUID()}`)
    const evaluation = await service.preview(command, actor)
    this.previews.set(this.previewKey(caseId, actor), evaluation)
    return evaluation
  }

  async decide(
    caseId: string,
    actor: TrustedActorContext,
    idempotencyKey: string
  ): Promise<FinancialDecisionRecord> {
    const key = parseIdempotencyKey(idempotencyKey)
    const { service, command } = await this.commandWithEvidence(caseId, key)
    const decision = await service.decideAndCommit(command, actor)
    this.previews.delete(this.previewKey(caseId, actor))
    this.append(caseId, decision)
    return decision
  }

  /** Approval resolution: `FinanceAdmin` only, re-checked here and inside the kernel. */
  async resolveApproval(
    caseId: string,
    command: HumanApprovalCommand,
    actor: TrustedActorContext
  ): Promise<FinancialDecisionRecord> {
    if (!actor.roles.includes(FINANCE_ADMIN_ROLE)) throw new FinanceWorkspaceError("ROLE_REQUIRED")
    if (command.action !== "APPROVE" && command.action !== "REJECT") {
      throw new FinanceWorkspaceError("INVALID_ACTION")
    }
    const definition = this.requireCase(caseId)
    const service = this.serviceFor(caseId, definition.scenarioId)
    const request = service.store.approvalRequests.get(command.approvalRequestId)
    if (!request) throw new FinanceWorkspaceError("APPROVAL_NOT_FOUND")
    if (request.payableCaseId !== caseId) {
      throw new FinanceWorkspaceError("APPROVAL_REQUEST_MISMATCH")
    }

    const decision = await service.resolveApproval(
      { ...command, idempotencyKey: parseIdempotencyKey(command.idempotencyKey) },
      actor
    )
    this.append(caseId, decision)
    return decision
  }

  /** Current case state for rendering, including the last in-process decision. */
  async view(caseId: string, actor: TrustedActorContext): Promise<PayableCaseView> {
    const definition = this.requireCase(caseId)
    let intakeResult: CaseIntake | null = null
    let evidenceError: PayableCaseView["evidenceError"] = null

    try {
      intakeResult = await this.intake(caseId)
    } catch (error) {
      if (error instanceof FinanceWorkspaceError) evidenceError = error.code
      else throw error
    }

    const decision = this.histories.get(caseId)?.at(-1) ?? null
    const approvalRequest = decision?.approvalRequestId
      ? this.serviceFor(caseId, definition.scenarioId).store.approvalRequests.get(
          decision.approvalRequestId
        )
      : undefined
    const approval: PayableApprovalView | null = approvalRequest
      ? {
          approvalRequestId: approvalRequest.approvalRequestId,
          status: approvalRequest.status,
          unroundedUsd: approvalRequest.unroundedUsd,
          createdAt: approvalRequest.createdAt,
          expiresAt: approvalRequest.expiresAt,
          resolvedAt: approvalRequest.resolvedAt,
        }
      : null

    return {
      caseId: definition.caseId,
      scenarioId: definition.scenarioId,
      title: definition.title,
      summary: definition.summary,
      sources: intakeResult?.sources ?? [],
      readyEnvelopeCount: intakeResult?.readyEnvelopeIds.length ?? 0,
      decision,
      approval,
      preview: this.previews.get(this.previewKey(caseId, actor)) ?? null,
      evidenceError,
    }
  }
}

function parseIdempotencyKey(value: string): string {
  const parsed = idempotencyKeySchema.safeParse(value)
  if (!parsed.success) throw new FinanceWorkspaceError("INVALID_IDEMPOTENCY_KEY")
  return parsed.data
}

export function createFinanceRuntime(options: FinanceRuntimeOptions): FinanceRuntime {
  return new FinanceRuntime(options)
}

const processResources = globalThis as typeof globalThis & {
  praecoFinanceRuntime?: FinanceRuntime
}

/**
 * Lazy singleton, shared across dev reloads like the database accessor. The
 * optional `PRAECO_FINANCE_DEMO_ROOT` directory keeps demo artifacts out of the
 * repository tree; it defaults to the ignored `.praeco-demo/` folder.
 */
export function getFinanceRuntime(): FinanceRuntime {
  if (!processResources.praecoFinanceRuntime) {
    const configuredRoot = process.env.PRAECO_FINANCE_DEMO_ROOT?.trim()
    processResources.praecoFinanceRuntime = createFinanceRuntime({
      sourcesRoot: DEFAULT_SOURCES_ROOT,
      storageRoot: configuredRoot ? join(configuredRoot, "l1") : DEFAULT_STORAGE_ROOT,
    })
  }
  return processResources.praecoFinanceRuntime
}
