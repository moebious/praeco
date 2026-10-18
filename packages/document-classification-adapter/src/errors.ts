export type ClassificationErrorCode =
  | 'INVALID_JSON'
  | 'SCHEMA_INVALID'
  | 'PAGE_COUNT_MISMATCH'
  | 'COVERAGE_INVALID'
  | 'UNKNOWN_CATEGORY'
  | 'SOURCE_HASH_MISMATCH'
  | 'DOCJEV_TIMEOUT'
  | 'DOCJEV_EXECUTION_FAILED'
  | 'OUTPUT_TOO_LARGE';

/**
 * Fail-closed adapter error. Messages carry operational metadata only:
 * never document text, never credentials, never raw provider output.
 */
export class ClassificationError extends Error {
  public readonly code: ClassificationErrorCode;

  constructor(code: ClassificationErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'ClassificationError';
    this.code = code;
  }
}
