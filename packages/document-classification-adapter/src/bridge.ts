import { spawn } from 'node:child_process';
import { ClassificationError } from './errors.js';
import { validateSplitResult } from './validate.js';
import type { ClassifiedPacket } from './validate.js';

export interface DocJevSplitInvocation {
  documentPath: string;
  rulesPath: string;
  /** Python interpreter that has DocJev importable (e.g. a prepared venv). */
  pythonCommand: string;
  model?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Extra environment for the child, e.g. TYPESAFE_API_KEY. Never logged. */
  extraEnv?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 150_000;
const DEFAULT_MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const HTTP_STATUS_PATTERN = /Jev request failed \((\d{3})\)/;

/**
 * Bounded bridge to the pinned DocJev CLI (`python -m jev_docs.cli split`).
 * Kills on timeout, caps captured output, and maps failures to sanitized
 * ClassificationError codes: no document text, credentials, or raw provider
 * output ever appears in thrown messages.
 */
export async function invokeDocJevSplit(invocation: DocJevSplitInvocation): Promise<unknown> {
  const timeoutMs = invocation.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = invocation.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  const args = [
    '-m', 'jev_docs.cli', 'split',
    invocation.documentPath,
    '--rules', invocation.rulesPath,
    '--ocr', 'liteparse',
    '--engine', 'jev',
  ];
  if (invocation.model) {
    args.push('--model', invocation.model);
  }

  return await new Promise<unknown>((resolve, reject) => {
    let stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrTail = '';
    let settled = false;

    const child = spawn(invocation.pythonCommand, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...invocation.extraEnv },
    });

    const finish = (outcome: () => void) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        outcome();
      }
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new ClassificationError('DOCJEV_TIMEOUT', `DocJev split exceeded ${timeoutMs}ms and was terminated`)));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        child.kill('SIGKILL');
        finish(() => reject(new ClassificationError('OUTPUT_TOO_LARGE', `DocJev split output exceeded ${maxOutputBytes} bytes`)));
        return;
      }
      stdout.push(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
    });

    child.on('error', () => {
      finish(() => reject(new ClassificationError('DOCJEV_EXECUTION_FAILED', 'failed to start the DocJev process')));
    });

    child.on('close', code => {
      finish(() => {
        if (code !== 0) {
          const match = HTTP_STATUS_PATTERN.exec(stderrTail);
          const status = match ? ` (provider HTTP ${match[1]})` : '';
          reject(new ClassificationError('DOCJEV_EXECUTION_FAILED', `DocJev split exited with code ${code ?? 'signal'}${status}`));
          return;
        }
        const raw = Buffer.concat(stdout).toString('utf8');
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new ClassificationError('INVALID_JSON', 'DocJev split output was not valid JSON'));
        }
      });
    });
  });
}

export interface ClassifyDocumentPacketParams extends DocJevSplitInvocation {
  /** Page count of the packet being classified. */
  expectedPageCount: number;
  /** SHA-256 of the registered original source, when the caller holds it. */
  expectedSourceSha256?: string;
}

/**
 * Invokes DocJev split through the bounded bridge and validates the result
 * into a typed, provenance-preserving packet decision. Any failure mode
 * (timeout, oversized output, execution failure, invalid JSON, schema drift,
 * coverage gaps, unknown categories, source mismatch) fails closed.
 */
export async function classifyDocumentPacket(
  params: ClassifyDocumentPacketParams
): Promise<ClassifiedPacket> {
  const { expectedPageCount, expectedSourceSha256, ...invocation } = params;
  const raw = await invokeDocJevSplit(invocation);
  return validateSplitResult(raw, { expectedPageCount, expectedSourceSha256 });
}
