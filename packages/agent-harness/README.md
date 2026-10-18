# Agent harness · L3

Praeco's operational coordination layer. L3 connects channel interactions to payable cases, assigns specialist work, records execution progress, and observes L2 decisions. A conversation, an assignment, an execution run, and a financial decision have separate identities.

## Specialists

| Role | Responsibility |
| --- | --- |
| **Eve** | Inspect inbound channel messages and prepare documentary intake |
| **Vera** | Inspect L1 evidence and source references |
| **Kael** | Request read-only policy evaluation and explain controls |
| **Nova** | Prepare financial intents and submit them to L2 |

Tool access is scoped by specialist role. An agent's memory or explanation cannot authorize spending; financial decisions belong to L2.

## Runtime and storage

`AssignmentService`, `WorkflowRunner`, and `HarnessReconciler` coordinate execution behind typed ports. The default runtime and scripted tool loops execute in-process. `SqlHarnessStore` provides PostgreSQL operational storage with tenant-scoped reads, assignment CAS, transactional inbound claiming, case correlation, token redemption, and leased outbox operations.

A configured delivery handler must accept an event before the reconciler acknowledges it. Failures remain retryable. PostgreSQL persistence is a building block for recovery, not proof that workflow execution survives process loss end to end. Trigger.dev integration remains future work.

## Channels

Web, email, AgentMail, and linked Telegram adapters are available as library components. Channel identity must be linked to a trusted enterprise principal; incoming email content and sender addresses remain untrusted. Financial approvals use an authenticated FinanceAdmin boundary, not a chat reply.

The AgentMail adapter and AI tool bridge are still undergoing security and provider-integration validation. Scripted bridge tests do not establish live AgentMail wire compatibility or actual Vercel AI SDK model execution. The current local dashboard does not compose all channels into one deployed workspace.

## Test

From the repository root:

```bash
npm run build
npm run test:l3
```

Offline suites cover real synthetic L1 processing, L2 orchestration, specialist permissions, checkpoints, human-review observation, and channel behavior. PostgreSQL suites require `DATABASE_URL` pointing to a disposable test database; they skip when it is absent.

## References

- [Public exports](src/index.ts)
- [Store port and in-memory implementation](src/store.ts)
- [SQL operational store](src/sql-store.ts)
- [L3 implementation contract](../../docs/architecture/l3-implementation-contract.md)
- [In-process runtime decision](../../docs/adr/007-in-process-demo-runtime.md)
