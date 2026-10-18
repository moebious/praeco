export * from './types.js';
export * from './decimal.js';
export * from './hashing.js';
export * from './tax-id.js';
export * from './period.js';
export * from './gates.js';
export * from './multi-envelope.js';
export * from './kernel.js';
export * from './store.js';
export * from './scenarios.js';
export * from './service.js';
export * from './l1-adapter.js';
// Exported for the apps/finance-dashboard scenario runner; the kernel itself carries no UI.
export { buildScenarios, runGoldenDemo } from './cli.js';
export type { GoldenDemoOptions, GoldenDemoSummary, ScenarioDef } from './cli.js';
export type {
  AuthoritativeCommitCommand, AuthoritativeCommitPort, AuthoritativeCommitResult,
  AuthoritativeCommandLookup, AuthoritativeCommandResult,
} from './commit-port.js';
