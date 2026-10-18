import { mkdir, readFile, writeFile, link, unlink, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { ExternalDocumentBindingSchema, ExternalDocumentReceiptSchema, ExternalObjectReferenceSchema,
  ExternalDocumentIntakeError, IntegrationIdSchema, externalBindingId, externalObjectIdentity, integrationHash, parseIntegration } from './external-document-provenance.js';
import type { BindingCapture, ExternalDocumentBinding, ExternalDocumentProvenanceStore,
  ExternalDocumentReceipt, ExternalObjectReference } from './external-document-provenance.js';

export class FileExternalDocumentProvenanceStore implements ExternalDocumentProvenanceStore {
  private readonly root: string;
  constructor(root: string, private readonly now = () => new Date().toISOString()) { this.root = resolve(root); }

  private directory(tenantId: string, kind: 'bindings' | 'receipts'): string {
    parseIntegration(IntegrationIdSchema, tenantId, 'INVALID_TENANT_CONTEXT');
    return join(this.root, integrationHash(tenantId), kind);
  }
  private path(tenantId: string, kind: 'bindings' | 'receipts', id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new ExternalDocumentIntakeError('INVALID_BINDING_REFERENCE');
    return join(this.directory(tenantId, kind), `${id}.json`);
  }
  private async read(path: string): Promise<unknown | null> {
    try { return JSON.parse(await readFile(path, 'utf8')) as unknown; }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw new ExternalDocumentIntakeError('INTEGRATION_RECORD_UNAVAILABLE');
    }
  }
  private async writeOnce(path: string, value: unknown): Promise<unknown> {
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
      await writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
      try { await link(temp, path); }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      }
      return await this.read(path);
    } catch { throw new ExternalDocumentIntakeError('INTEGRATION_STORAGE_UNAVAILABLE'); }
    finally { await unlink(temp).catch(() => undefined); }
  }
  private binding(value: unknown, tenantId: string, bindingId: string): ExternalDocumentBinding {
    const binding = parseIntegration(ExternalDocumentBindingSchema, value, 'INVALID_INTEGRATION_BINDING');
    if (binding.tenantId !== tenantId || binding.bindingId !== bindingId || externalBindingId(binding) !== bindingId)
      throw new ExternalDocumentIntakeError('INTEGRATION_BINDING_MISMATCH');
    return binding;
  }
  async capture(input: BindingCapture): Promise<ExternalDocumentBinding> {
    const bindingId = externalBindingId(input);
    const candidate = this.binding({ ...input, bindingVersion: '1', bindingId, capturedAt: this.now() }, input.tenantId, bindingId);
    return this.binding(await this.writeOnce(this.path(input.tenantId, 'bindings', bindingId), candidate), input.tenantId, bindingId);
  }
  async load(tenantId: string, bindingId: string): Promise<ExternalDocumentBinding> {
    const value = await this.read(this.path(tenantId, 'bindings', bindingId));
    if (!value) throw new ExternalDocumentIntakeError('EXTERNAL_BINDING_NOT_FOUND');
    return this.binding(value, tenantId, bindingId);
  }
  async history(tenantId: string, reference: ExternalObjectReference): Promise<readonly ExternalDocumentBinding[]> {
    const expected = JSON.stringify(externalObjectIdentity(parseIntegration(ExternalObjectReferenceSchema, reference, 'INVALID_EXTERNAL_REFERENCE')));
    let files: string[];
    try { files = await readdir(this.directory(tenantId, 'bindings')); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw new ExternalDocumentIntakeError('INTEGRATION_STORAGE_UNAVAILABLE');
    }
    const history = [];
    for (const name of files.filter(file => /^[a-f0-9]{64}\.json$/.test(file))) {
      const binding = await this.load(tenantId, name.slice(0, -5));
      if (JSON.stringify(externalObjectIdentity(binding)) === expected) history.push(binding);
    }
    return history.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.bindingId.localeCompare(b.bindingId));
  }
  async loadReceipt(tenantId: string, bindingId: string): Promise<ExternalDocumentReceipt | null> {
    const binding = await this.load(tenantId, bindingId);
    const value = await this.read(this.path(tenantId, 'receipts', bindingId));
    if (!value) return null;
    return this.receipt(value, binding);
  }
  private receipt(value: unknown, binding: ExternalDocumentBinding): ExternalDocumentReceipt {
    const receipt = parseIntegration(ExternalDocumentReceiptSchema, value, 'INVALID_INTEGRATION_RECEIPT');
    if (receipt.bindingId !== binding.bindingId || receipt.sourceId !== binding.sourceId || receipt.sourceHashSha256 !== binding.sourceHashSha256)
      throw new ExternalDocumentIntakeError('INTEGRATION_RECEIPT_MISMATCH');
    return receipt;
  }
  async saveReceipt(tenantId: string, receipt: ExternalDocumentReceipt): Promise<ExternalDocumentReceipt> {
    const binding = await this.load(tenantId, receipt.bindingId);
    const candidate = this.receipt(receipt, binding);
    return this.receipt(await this.writeOnce(this.path(tenantId, 'receipts', binding.bindingId), candidate), binding);
  }
}
