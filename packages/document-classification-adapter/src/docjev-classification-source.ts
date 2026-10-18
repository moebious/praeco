import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyDocumentPacket } from './bridge.js';
import type { ClassifiedPacket } from './validate.js';
import type { SegmentClassificationInput, SegmentClassificationSource } from './l1-integration.js';

export interface DocJevClassificationSourceOptions {
  /** Python interpreter with the pinned DocJev importable. */
  pythonCommand: string;
  rulesPath: string;
  model?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Provider credential, passed only to the child environment and never logged. */
  apiKey?: string;
}

/**
 * Live classification source backed by the bounded DocJev bridge and the PR B
 * validator. Only PDF packets are classified; every other channel keeps the
 * conservative base extraction path. The validated packet must match the
 * registered source hash and the parsed page count, or classification fails
 * closed inside classifyDocumentPacket.
 */
export class DocJevClassificationSource implements SegmentClassificationSource {
  private readonly options: DocJevClassificationSourceOptions;

  public constructor(options: DocJevClassificationSourceOptions) {
    this.options = options;
  }

  public async classify(input: SegmentClassificationInput): Promise<ClassifiedPacket | null> {
    if (input.source.channel !== 'PDF') {
      return null;
    }
    const directory = await mkdtemp(join(tmpdir(), 'praeco-docjev-'));
    try {
      const documentPath = join(directory, `packet-${randomUUID()}.pdf`);
      await writeFile(documentPath, input.bytes);
      return await classifyDocumentPacket({
        documentPath,
        rulesPath: this.options.rulesPath,
        pythonCommand: this.options.pythonCommand,
        model: this.options.model,
        timeoutMs: this.options.timeoutMs,
        maxOutputBytes: this.options.maxOutputBytes,
        expectedPageCount: input.parsed.pages.length,
        expectedSourceSha256: input.source.sourceHashSha256,
        extraEnv: this.options.apiKey ? { TYPESAFE_API_KEY: this.options.apiKey } : undefined,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
