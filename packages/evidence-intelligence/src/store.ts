import { mkdir, readFile, writeFile, link, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ArtifactRef, DocumentSource, InvoiceEnvelope } from './contracts.js';
import { canonicalJson, digest, L1Error, sha256 } from './integrity.js';
import { DocumentSourceSchema, IdSchema, parseEnvelope } from './schemas.js';

export interface SourceInput {
  tenantId: string;
  bytes: Uint8Array;
  channel: DocumentSource['channel'];
  mimeType: string;
  displayName?: string;
  originMessageId?: string;
}
export interface ArtifactBinding {
  sourceId: string;
  sourceHashSha256: string;
  artifact: ArtifactRef;
  page?: number;
}

/** Server-only store. Never give agents raw storage access or an arbitrary write tool. */
export class FileEvidenceStore {
  readonly root: string;
  constructor(root: string, private readonly now = () => new Date().toISOString()) { this.root = resolve(root); }

  private async writeOnce(key: string, bytes: Uint8Array): Promise<void> {
    // Keys are constructed internally, never accepted from storageKey values or URLs.
    const target = join(this.root, key);
    await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
    try { await link(temp, target); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      const existing = await readFile(target);
      if (!existing.equals(Buffer.from(bytes))) throw new L1Error('IMMUTABLE_RECORD_CONFLICT', 'INTAKE');
    } finally { await unlink(temp); }
  }
  private namespace(tenantId: string): string { return sha256(IdSchema.parse(tenantId)); }
  private recordKey(tenantId: string, kind: string, id: string): string {
    return `records/${this.namespace(tenantId)}/${kind}/${sha256(id)}.json`;
  }
  async record(tenantId: string, kind: 'sources' | 'origins' | 'bindings' | 'receipts' | 'runs', id: string, value: unknown): Promise<void> {
    await this.writeOnce(this.recordKey(tenantId, kind, id), Buffer.from(canonicalJson(value)));
  }
  async lookup(tenantId: string, kind: 'sources' | 'origins' | 'bindings' | 'receipts' | 'runs', id: string): Promise<unknown | null> {
    try { return JSON.parse(await readFile(join(this.root, this.recordKey(tenantId, kind, id)), 'utf8')) as unknown; }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw new L1Error('STORE_RECORD_INVALID', 'VERIFY');
    }
  }
  async putBlob(tenantId: string, bytes: Uint8Array): Promise<{ sha256: string; storageKey: string }> {
    const hash = sha256(bytes), key = `objects/${this.namespace(tenantId)}/${hash}`;
    await this.writeOnce(key, bytes);
    return { sha256: hash, storageKey: key };
  }
  async blob(tenantId: string, hash: string): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new L1Error('INVALID_ARTIFACT_HASH', 'VERIFY');
    let bytes: Buffer;
    try { bytes = await readFile(join(this.root, `objects/${this.namespace(tenantId)}/${hash}`)); }
    catch { throw new L1Error('ARTIFACT_UNAVAILABLE', 'VERIFY'); }
    if (sha256(bytes) !== hash) throw new L1Error('ARTIFACT_HASH_MISMATCH', 'VERIFY');
    return bytes;
  }
  async register(input: SourceInput): Promise<DocumentSource> {
    IdSchema.parse(input.tenantId);
    if (input.bytes.length === 0 || input.bytes.length > 20_000_000) throw new L1Error('SOURCE_SIZE_LIMIT', 'INTAKE');
    const blob = await this.putBlob(input.tenantId, input.bytes);
    const sourceId = `src-${digest({ tenant: input.tenantId, channel: input.channel, mimeType: input.mimeType,
      origin: input.originMessageId ?? null, hash: blob.sha256 })}`;
    const prior = await this.lookup(input.tenantId, 'sources', sourceId);
    if (prior) return DocumentSourceSchema.parse(prior);
    const source = DocumentSourceSchema.parse({ tenantId: input.tenantId, sourceId, sourceHashSha256: blob.sha256, storageKey: blob.storageKey,
      channel: input.channel, mimeType: input.mimeType, byteLength: input.bytes.length, receivedAt: this.now(),
      ...(input.displayName ? { displayName: input.displayName } : {}), ...(input.originMessageId ? { originMessageId: input.originMessageId } : {}) });
    if (input.originMessageId) await this.record(input.tenantId, 'origins', `${input.channel}:${input.originMessageId}`, { sourceId });
    // Concurrent first registration may have a different timestamp; the first committed source wins.
    try { await this.record(input.tenantId, 'sources', sourceId, source); }
    catch (error) {
      const winner = await this.lookup(input.tenantId, 'sources', sourceId);
      if (!winner) throw error;
      return DocumentSourceSchema.parse(winner);
    }
    return source;
  }
  async resolveSource(tenantId: string, sourceId: string): Promise<DocumentSource> {
    const stored = await this.lookup(tenantId, 'sources', sourceId);
    if (!stored) throw new L1Error('SOURCE_NOT_REGISTERED', 'INTAKE');
    const source = DocumentSourceSchema.parse(stored);
    if (source.tenantId !== tenantId || source.sourceId !== sourceId) throw new L1Error('SOURCE_BINDING_MISMATCH', 'VERIFY');
    const bytes = await this.blob(tenantId, source.sourceHashSha256);
    if (bytes.length !== source.byteLength || source.storageKey !== `objects/${this.namespace(tenantId)}/${source.sourceHashSha256}`)
      throw new L1Error('SOURCE_BINDING_MISMATCH', 'VERIFY');
    return source;
  }
  async sourceBytes(source: DocumentSource): Promise<Buffer> {
    const registered = await this.resolveSource(source.tenantId, source.sourceId);
    if (canonicalJson(registered) !== canonicalJson(source)) throw new L1Error('SOURCE_BINDING_MISMATCH', 'VERIFY');
    return this.blob(source.tenantId, source.sourceHashSha256);
  }
  async retain(source: DocumentSource, kind: ArtifactRef['kind'], bytes: Uint8Array, page?: number): Promise<ArtifactRef> {
    const blob = await this.putBlob(source.tenantId, bytes);
    const artifact = { artifactId: `art-${digest({ sourceId: source.sourceId, kind, page: page ?? null, hash: blob.sha256 })}`, kind, ...blob };
    await this.record(source.tenantId, 'bindings', artifact.artifactId,
      { sourceId: source.sourceId, sourceHashSha256: source.sourceHashSha256, artifact, ...(page ? { page } : {}) });
    return artifact;
  }
  async artifact(source: DocumentSource, ref: ArtifactRef): Promise<Buffer> {
    const record = await this.lookup(source.tenantId, 'bindings', ref.artifactId) as ArtifactBinding | null;
    if (!record || record.sourceId !== source.sourceId || record.sourceHashSha256 !== source.sourceHashSha256
      || canonicalJson(record.artifact) !== canonicalJson(ref)) throw new L1Error('ARTIFACT_BINDING_MISMATCH', 'VERIFY');
    return this.blob(source.tenantId, ref.sha256);
  }
  async saveEnvelope(envelope: InvoiceEnvelope): Promise<string> {
    parseEnvelope(envelope);
    const blob = await this.putBlob(envelope.source.tenantId, Buffer.from(canonicalJson(envelope)));
    await this.record(envelope.source.tenantId, 'receipts', envelope.envelopeId,
      { envelopeId: envelope.envelopeId, sourceId: envelope.source.sourceId, integrityDigestSha256: blob.sha256, manifestVersion: 'canonical-json-v1' });
    return blob.sha256;
  }
  async loadEnvelope(tenantId: string, envelopeId: string): Promise<InvoiceEnvelope> {
    const receipt = await this.lookup(tenantId, 'receipts', envelopeId) as { envelopeId: string; sourceId: string; integrityDigestSha256: string } | null;
    if (!receipt || receipt.envelopeId !== envelopeId) throw new L1Error('ENVELOPE_NOT_FOUND', 'VERIFY');
    const envelope = parseEnvelope(JSON.parse((await this.blob(tenantId, receipt.integrityDigestSha256)).toString('utf8')));
    if (envelope.source.tenantId !== tenantId || envelope.envelopeId !== envelopeId || envelope.source.sourceId !== receipt.sourceId)
      throw new L1Error('ENVELOPE_BINDING_MISMATCH', 'VERIFY');
    await this.sourceBytes(envelope.source);
    for (const artifact of envelope.artifacts) await this.artifact(envelope.source, artifact);
    return envelope;
  }
}
