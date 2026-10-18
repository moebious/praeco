import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { createL1 } from '../src/service.js';
import type { L1Options } from '../src/service.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
export async function setup(options: Partial<L1Options> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'praeco-l1-test-')); roots.push(root);
  return { root, runtime: createL1({ storageRoot: root, now: () => '2026-10-17T12:00:00Z', ...options }) };
}
export const sample = () => readFile(new URL('../examples/invoice.txt', import.meta.url), 'utf8');
