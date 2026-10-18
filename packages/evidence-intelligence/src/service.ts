import { randomUUID, createHmac } from 'node:crypto';
import { z, ZodError } from 'zod';
import type { ArtifactRef, DocumentIntelligencePort, DocumentSource, FxRateSnapshot, InvoiceEnvelope, ProcessingProvenance } from './contracts.js';
import { L1_CONTRACT_VERSION } from './contracts.js';
import { canonicalJson, digest, L1Error } from './integrity.js';
import { DEMO_RATES, NORMALIZATION_VERSION, decimal, normalize } from './financial-normalization.js';
import { LabelledTextExtractor } from './extraction.js';
import { FileEvidenceStore } from './store.js';
import type { SourceInput } from './store.js';
import { AdaptiveParser } from './parser.js';
import { LlamaCloudAdapter } from './llamacloud.js';
import type { LlamaCloudOptions } from './llamacloud.js';
import type { ExtractionPort, ExtractionDraft, ParsedDocument, ImmutablePersistencePort } from './document-processing-ports.js';
import { EvidenceVerifier, VERIFIER_VERSION } from './verifier.js';
import { ArtifactSchema, IdSchema, parseEnvelope, ReportSchema } from './schemas.js';
import { isSupplementalContext } from './context.js';

export interface L1Options {
  storageRoot: string;
  llamaCloud?: LlamaCloudOptions;
  extractor?: ExtractionPort;
  rates?: readonly FxRateSnapshot[];
  now?: () => string;
  persistence?: ImmutablePersistencePort;
}
export interface ReadyEvidence {
  envelope: Extract<InvoiceEnvelope, { processingStatus: 'READY_FOR_POLICY_EVALUATION' }>;
  integrityDigestSha256: string;
  usdRatio: { numerator: string; denominator: string };
}
export interface EvidenceReader {
  load(tenantId: string, envelopeId: string): Promise<InvoiceEnvelope>;
  loadReady(tenantId: string, envelopeId: string): Promise<ReadyEvidence>;
  loadRun(tenantId: string, runId: string): Promise<unknown>;
}
export interface L1Runtime extends DocumentIntelligencePort {
  register(input: SourceInput): Promise<DocumentSource>;
  processWithReceipt(source: DocumentSource): Promise<L1ProcessingResult>;
  replay(tenantId: string, envelopeId: string): Promise<InvoiceEnvelope>;
  readonly reader: EvidenceReader;
}
export interface L1ProcessingResult {
  pipelineRunId: string;
  sourceDisposition: 'INVOICE_OR_UNCERTAIN' | 'SUPPLEMENTAL_CONTEXT';
  envelopes: readonly InvoiceEnvelope[];
}

export function createL1(options: L1Options): L1Runtime {
  const now = options.now ?? (() => new Date().toISOString());
  const store = new FileEvidenceStore(options.storageRoot, now, options.persistence);
  const rates = structuredClone(options.rates ?? DEMO_RATES);
  const verifier = new EvidenceVerifier(store, rates, now);
  const reader: EvidenceReader = {
    load: (tenantId, envelopeId) => store.loadEnvelope(tenantId, envelopeId),
    async loadRun(tenantId, runId) {
      const stored = await store.lookup(tenantId, 'runs', `${runId}:finished`);
      if (stored === null) return null;
      const run = z.object({ pipelineRunId: IdSchema, sourceId: IdSchema, artifacts: z.array(ArtifactSchema).max(1000) }).safeParse(stored);
      if (!run.success || run.data.pipelineRunId !== runId) throw new L1Error('RUN_RECEIPT_INVALID', 'VERIFY');
      const source = await store.resolveSource(tenantId, run.data.sourceId);
      for (const artifact of run.data.artifacts) await store.artifact(source, artifact);
      return stored;
    },
    async loadReady(tenantId, envelopeId) {
      const envelope = await store.loadEnvelope(tenantId, envelopeId);
      if (envelope.processingStatus !== 'READY_FOR_POLICY_EVALUATION') throw new L1Error('ENVELOPE_NOT_READY', 'VERIFY');
      if (envelope.verification.sourceHashSha256 !== envelope.source.sourceHashSha256 || envelope.verification.invoiceDigestSha256 !== digest(envelope.invoice))
        throw new L1Error('VERIFICATION_BINDING_MISMATCH', 'VERIFY');
      const reportArtifact = envelope.artifacts.find(a => a.kind === 'VERIFICATION_REPORT');
      if (!reportArtifact) throw new L1Error('VERIFICATION_ARTIFACT_MISSING', 'VERIFY');
      const storedReport = ReportSchema.parse(JSON.parse((await store.artifact(envelope.source, reportArtifact)).toString('utf8')));
      if (canonicalJson(storedReport) !== canonicalJson(envelope.verification)) throw new L1Error('VERIFICATION_BINDING_MISMATCH', 'VERIFY');
      const recomputed = normalize(envelope.invoice, envelope.normalization.fx ? [envelope.normalization.fx] : []);
      if (canonicalJson(recomputed) !== canonicalJson(envelope.normalization)) throw new L1Error('NORMALIZATION_BINDING_MISMATCH', 'VERIFY');
      return { envelope, integrityDigestSha256: digest(envelope), usdRatio: {
        numerator: envelope.normalization.candidatePayable!.amount, denominator: envelope.normalization.fx?.quotePerBase ?? '1',
      } };
    },
  };
  const runtime: L1Runtime = {
    register: input => store.register(input), reader,
    async replay(tenantId, envelopeId) {
      const original = await store.loadEnvelope(tenantId, envelopeId);
      let snapshot: ReplaySnapshot | null = null;
      for (const artifact of original.artifacts.filter(a => a.kind === 'EXTRACTION_RAW')) {
        let raw: unknown;
        try { raw = JSON.parse((await store.artifact(original.source, artifact)).toString('utf8')); } catch { continue; }
        if (raw && typeof raw === 'object' && 'kind' in raw && raw.kind === 'L1_REPLAY_SNAPSHOT') snapshot = raw as ReplaySnapshot;
      }
      if (!snapshot || snapshot.snapshotVersion !== '1' || snapshot.verifierVersion !== VERIFIER_VERSION
        || snapshot.sourceId !== original.source.sourceId || snapshot.sourceHashSha256 !== original.source.sourceHashSha256
        || digest(snapshot.draft.invoice) !== original.verification?.invoiceDigestSha256
        || canonicalJson(snapshot.draft.evidence) !== canonicalJson(original.evidence)) throw new L1Error('REPLAY_SNAPSHOT_UNAVAILABLE_OR_INCOMPATIBLE', 'VERIFY');
      const pipelineRunId = `run-${randomUUID()}`;
      await store.record(tenantId, 'runs', `${pipelineRunId}:started`, { pipelineRunId, sourceId: original.source.sourceId, replayOf: envelopeId, status: 'RUNNING', startedAt: now() });
      const verified = await new EvidenceVerifier(store, snapshot.rates, now).verify(original.source, snapshot.parsed, snapshot.draft);
      const reportArtifact = await store.retain(original.source, 'VERIFICATION_REPORT', Buffer.from(canonicalJson(verified.report)));
      const replayed = parseEnvelope({ ...original, envelopeId: `env-${randomUUID()}`, pipelineRunId,
        processingStatus: verified.report.status === 'ACCEPTED' ? 'READY_FOR_POLICY_EVALUATION' : verified.report.status,
        invoice: verified.invoice, normalization: verified.normalization, verification: verified.report,
        artifacts: [...original.artifacts.filter(a => a.kind !== 'VERIFICATION_REPORT'), reportArtifact], completedAt: now(),
        provenance: { ...original.provenance, pipelineVersion: 'praeco-l1-replay-v1' }, errors: [] });
      await store.saveEnvelope(replayed);
      await store.record(tenantId, 'runs', `${pipelineRunId}:finished`, { pipelineRunId, sourceId: original.source.sourceId, replayOf: envelopeId,
        envelopeIds: [replayed.envelopeId], status: 'COMPLETED', finishedAt: now(), artifacts: replayed.artifacts });
      return replayed;
    },
    async process(input) { return (await runtime.processWithReceipt(input)).envelopes; },
    async processWithReceipt(input) {
      const bytes = await store.sourceBytes(input);
      const source = structuredClone(input), pipelineRunId = `run-${randomUUID()}`;
      const artifacts: ArtifactRef[] = [await store.retain(source, 'ORIGINAL', bytes)];
      await store.record(source.tenantId, 'runs', `${pipelineRunId}:started`, { sourceId: source.sourceId, pipelineRunId, startedAt: now(), status: 'RUNNING' });
      const cloud = options.llamaCloud ? new LlamaCloudAdapter({ ...options.llamaCloud, onEvent: async event => {
        artifacts.push(await store.retain(source, 'EXTRACTION_RAW', Buffer.from(canonicalJson(event))));
        await options.llamaCloud?.onEvent?.(event);
      } }) : undefined;
      const extractor = options.extractor ?? cloud ?? new LabelledTextExtractor();
      const parser = new AdaptiveParser(store, cloud);
      const provenance: ProcessingProvenance = { pipelineVersion: 'praeco-l1-runtime-v1', parser: { provider: 'DIRECT_TEXT', version: 'not-run' },
        classification: { provider: 'SKIPPED' }, extraction: { provider: extractor.provider, version: extractor.version, configurationDigestSha256: digest(extractor.configuration) },
        normalizationVersion: NORMALIZATION_VERSION };
      const outputs: InvoiceEnvelope[] = [];
      let sourceDisposition: 'INVOICE_OR_UNCERTAIN' | 'SUPPLEMENTAL_CONTEXT' = 'INVOICE_OR_UNCERTAIN';
      const failed = (error: unknown): InvoiceEnvelope => {
        const safe = error instanceof L1Error ? error : error instanceof ZodError
          ? new L1Error('INVALID_PROVIDER_OUTPUT', 'EXTRACT') : new L1Error('ADAPTER_EXECUTION_FAILED', 'EXTRACT', true);
        return parseEnvelope({ schemaVersion: L1_CONTRACT_VERSION,
          processingStatus: safe.code === 'INVALID_PROVIDER_OUTPUT' ? 'REJECTED' : ['UNCERTAIN_PACKET_BOUNDARIES', 'UNCERTAIN_DOCUMENT_KIND', 'UNCERTAIN_LINE_ITEM_BOUNDARIES'].includes(safe.code) ? 'REVIEW_REQUIRED' : 'PROCESSING_FAILED',
          envelopeId: `env-${randomUUID()}`, pipelineRunId, source, invoice: null, normalization: null, evidence: [], verification: null,
          artifacts: [...new Map(artifacts.map(a => [a.artifactId, a])).values()], provenance, completedAt: now(),
          errors: [{ code: safe.code, stage: safe.stage, retryable: safe.retryable, message: safe.code }] });
      };
      try {
        const parsed = await parser.parse(source, bytes);
        provenance.parser = parsed.parser;
        artifacts.push(...parsed.pages.map(p => p.artifact));
        artifacts.push(await store.retain(source, 'EXTRACTION_RAW', Buffer.from(canonicalJson(parsed.raw))));
        const supplemental = isSupplementalContext(source, parsed);
        const extracted = supplemental ? { drafts: [], raw: { classification: 'SUPPLEMENTAL_CONTEXT', ruleVersion: 'explicit-native-context-v1' } }
          : await extractor.extract({ source: structuredClone(source), bytes: new Uint8Array(bytes), parsed: structuredClone(parsed) });
        artifacts.push(await store.retain(source, 'EXTRACTION_RAW', Buffer.from(canonicalJson(extracted.raw))));
        if (extracted.drafts.length === 0 && !supplemental) throw new L1Error('UNCERTAIN_DOCUMENT_KIND', 'CLASSIFY');
        if (extracted.drafts.length > 50) throw new L1Error('INVALID_EXTRACTION_COUNT', 'EXTRACT');
        if (supplemental) sourceDisposition = 'SUPPLEMENTAL_CONTEXT';
        for (const draft of extracted.drafts) {
          try {
            const verified = await verifier.verify(source, parsed, draft);
            const snapshot: ReplaySnapshot = { kind: 'L1_REPLAY_SNAPSHOT', snapshotVersion: '1', verifierVersion: VERIFIER_VERSION,
              sourceId: source.sourceId, sourceHashSha256: source.sourceHashSha256, parsed, draft, rates };
            const replayArtifact = await store.retain(source, 'EXTRACTION_RAW', Buffer.from(canonicalJson(snapshot)));
            const reportArtifact = await store.retain(source, 'VERIFICATION_REPORT', Buffer.from(canonicalJson(verified.report)));
            const status = verified.report.status === 'ACCEPTED' ? 'READY_FOR_POLICY_EVALUATION' : verified.report.status;
            const envelope = parseEnvelope({ schemaVersion: L1_CONTRACT_VERSION, processingStatus: status, envelopeId: `env-${randomUUID()}`, pipelineRunId, source,
              ...(draft.segment ? { segment: draft.segment } : {}), invoice: verified.invoice, normalization: verified.normalization, evidence: draft.evidence,
              verification: verified.report, artifacts: [...new Map([...artifacts, replayArtifact, reportArtifact].map(a => [a.artifactId, a])).values()],
              provenance: { ...provenance, classification: { provider: draft.segment ? 'RULE' : 'SKIPPED', version: 'explicit-page-v1' } }, completedAt: now(), errors: [] });
            outputs.push(envelope);
          } catch (error) { outputs.push(failed(error)); }
        }
      } catch (error) { outputs.push(failed(error)); }
      finally { await parser.close(); }
      for (const envelope of outputs) await store.saveEnvelope(envelope);
      await store.record(source.tenantId, 'runs', `${pipelineRunId}:finished`, { sourceId: source.sourceId, pipelineRunId, finishedAt: now(),
        sourceHashSha256: source.sourceHashSha256, envelopeIds: outputs.map(e => e.envelopeId), sourceDisposition, artifacts,
        status: outputs.some(e => e.processingStatus === 'PROCESSING_FAILED') ? 'FAILED' : 'COMPLETED' });
      return { pipelineRunId, sourceDisposition, envelopes: outputs };
    },
  };
  return runtime;
}

interface ReplaySnapshot {
  kind: 'L1_REPLAY_SNAPSHOT'; snapshotVersion: '1'; verifierVersion: string;
  sourceId: string; sourceHashSha256: string; parsed: ParsedDocument; draft: ExtractionDraft; rates: readonly FxRateSnapshot[];
}

/** Arithmetic only; callers own whether a given limit is financial policy. No USD rounding. */
export function compareUsdRatio(ratio: ReadyEvidence['usdRatio'], usdAmount: string): -1 | 0 | 1 {
  const numerator = decimal(ratio.numerator), denominator = decimal(ratio.denominator);
  if (denominator.lte(0)) throw new L1Error('INVALID_FX_RATE', 'NORMALIZE');
  const compared = numerator.comparedTo(decimal(usdAmount).times(denominator));
  return compared < 0 ? -1 : compared > 0 ? 1 : 0;
}

/** Safe operational summary: raw invoices, quotes and account identifiers remain restricted. */
export function summarize(envelope: InvoiceEnvelope) {
  return { envelopeId: envelope.envelopeId, pipelineRunId: envelope.pipelineRunId, processingStatus: envelope.processingStatus,
    usdEquivalent: envelope.normalization?.usdEquivalent ?? null, verificationStatus: envelope.verification?.status ?? null,
    issues: [...new Set([...(envelope.verification?.checks.filter(c => c.status !== 'PASS').map(c => c.code) ?? []), ...envelope.errors.map(e => e.code)])] };
}

/** Backend-only audit correlation; never a beneficiary/account authorization check. */
export function accountAuditReference(envelope: InvoiceEnvelope, tenantKey: Uint8Array): { redacted: string; fingerprint: string } | null {
  if (tenantKey.byteLength < 32) throw new L1Error('ACCOUNT_FINGERPRINT_KEY_REQUIRED', 'VERIFY');
  const account = envelope.invoice?.beneficiary.paymentAccount;
  if (account?.state !== 'OBSERVED') return null;
  return { redacted: `***${account.value.accountIdentifier.slice(-4)}`, fingerprint: `acct-${createHmac('sha256', tenantKey)
    .update(canonicalJson({ tenantId: envelope.source.tenantId, account: account.value })).digest('hex')}` };
}
