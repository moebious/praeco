import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import type { ArtifactRef, DocumentIntelligencePort, DocumentSource, FxRateSnapshot, InvoiceEnvelope, ProcessingProvenance } from './contracts.js';
import { L1_CONTRACT_VERSION } from './contracts.js';
import { canonicalJson, digest, L1Error } from './integrity.js';
import { DEMO_RATES, NORMALIZATION_VERSION, decimal, normalize } from './money.js';
import { LabelledTextExtractor } from './extraction.js';
import { FileEvidenceStore } from './store.js';
import type { SourceInput } from './store.js';
import { AdaptiveParser } from './parser.js';
import { LlamaCloudAdapter } from './llamacloud.js';
import type { LlamaCloudOptions } from './llamacloud.js';
import type { ExtractionPort } from './ports.js';
import { EvidenceVerifier } from './verifier.js';
import { parseEnvelope, ReportSchema } from './schemas.js';

export interface L1Options {
  storageRoot: string;
  llamaCloud?: LlamaCloudOptions;
  /** Explicit offline/third-party adapter. Default is LlamaExtract when cloud is configured. */
  extractor?: ExtractionPort;
  rates?: readonly FxRateSnapshot[];
  now?: () => string;
}
export interface ReadyEvidence {
  envelope: Extract<InvoiceEnvelope, { processingStatus: 'READY_FOR_POLICY_EVALUATION' }>;
  integrityDigestSha256: string;
  /** L2 compares exact ratios against its policy limits; usdEquivalent is rounded for display. */
  usdRatio: { numerator: string; denominator: string };
}
export interface EvidenceReader {
  load(tenantId: string, envelopeId: string): Promise<InvoiceEnvelope>;
  loadReady(tenantId: string, envelopeId: string): Promise<ReadyEvidence>;
}
export interface L1Runtime extends DocumentIntelligencePort {
  register(input: SourceInput): Promise<DocumentSource>;
  readonly reader: EvidenceReader;
}

/** Trusted backend composition root. L3 receives register/process; L2 receives only reader. */
export function createL1(options: L1Options): L1Runtime {
  const now = options.now ?? (() => new Date().toISOString());
  const store = new FileEvidenceStore(options.storageRoot, now);
  const rates = structuredClone(options.rates ?? DEMO_RATES);
  const verifier = new EvidenceVerifier(store, rates, now);
  const reader: EvidenceReader = {
    load: (tenantId, envelopeId) => store.loadEnvelope(tenantId, envelopeId),
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
  return {
    register: input => store.register(input), reader,
    async process(input) {
      // Reject unregistered/cross-tenant/mutated source descriptors before doing any provider work.
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
      const failed = (error: unknown): InvoiceEnvelope => {
        const safe = error instanceof L1Error ? error : error instanceof ZodError
          ? new L1Error('INVALID_PROVIDER_OUTPUT', 'EXTRACT') : new L1Error('ADAPTER_EXECUTION_FAILED', 'EXTRACT', true);
        return parseEnvelope({ schemaVersion: L1_CONTRACT_VERSION,
          processingStatus: safe.code === 'INVALID_PROVIDER_OUTPUT' ? 'REJECTED' : safe.code === 'UNCERTAIN_PACKET_BOUNDARIES' ? 'REVIEW_REQUIRED' : 'PROCESSING_FAILED',
          envelopeId: `env-${randomUUID()}`, pipelineRunId, source, invoice: null, normalization: null, evidence: [], verification: null,
          artifacts: [...new Map(artifacts.map(a => [a.artifactId, a])).values()], provenance, completedAt: now(),
          errors: [{ code: safe.code, stage: safe.stage, retryable: safe.retryable, message: safe.code }] });
      };
      try {
        const parsed = await parser.parse(source, bytes);
        provenance.parser = parsed.parser;
        artifacts.push(...parsed.pages.map(p => p.artifact));
        artifacts.push(await store.retain(source, 'EXTRACTION_RAW', Buffer.from(canonicalJson(parsed.raw))));
        const extracted = await extractor.extract({ source: structuredClone(source), bytes: new Uint8Array(bytes), parsed: structuredClone(parsed) });
        artifacts.push(await store.retain(source, 'EXTRACTION_RAW', Buffer.from(canonicalJson(extracted.raw))));
        if (extracted.drafts.length === 0 || extracted.drafts.length > 50) throw new L1Error('INVALID_EXTRACTION_COUNT', 'EXTRACT');
        for (const draft of extracted.drafts) {
          try {
            const verified = await verifier.verify(source, parsed, draft);
            const reportArtifact = await store.retain(source, 'VERIFICATION_REPORT', Buffer.from(canonicalJson(verified.report)));
            const status = verified.report.status === 'ACCEPTED' ? 'READY_FOR_POLICY_EVALUATION' : verified.report.status;
            const envelope = parseEnvelope({ schemaVersion: L1_CONTRACT_VERSION, processingStatus: status, envelopeId: `env-${randomUUID()}`, pipelineRunId, source,
              ...(draft.segment ? { segment: draft.segment } : {}), invoice: verified.invoice, normalization: verified.normalization, evidence: draft.evidence,
              verification: verified.report, artifacts: [...new Map([...artifacts, reportArtifact].map(a => [a.artifactId, a])).values()],
              provenance: { ...provenance, classification: { provider: draft.segment ? 'RULE' : 'SKIPPED', version: 'explicit-page-v1' } }, completedAt: now(), errors: [] });
            outputs.push(envelope);
          } catch (error) { outputs.push(failed(error)); }
        }
      } catch (error) { outputs.push(failed(error)); }
      finally { await parser.close(); }
      for (const envelope of outputs) await store.saveEnvelope(envelope);
      await store.record(source.tenantId, 'runs', `${pipelineRunId}:finished`, { sourceId: source.sourceId, pipelineRunId, finishedAt: now(),
        envelopeIds: outputs.map(e => e.envelopeId), status: outputs.some(e => e.processingStatus === 'PROCESSING_FAILED') ? 'FAILED' : 'COMPLETED' });
      return outputs;
    },
  };
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
