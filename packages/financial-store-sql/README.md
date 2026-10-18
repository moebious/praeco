# @praeco/financial-store-sql

PostgreSQL transaction adapter for L2's simulated authorization commits.

`SqlFinancialStore` implements the commit transaction, and `SqlCommitPort`
connects it to `FinancialAuthorizationService` for auto-authorization and
approval-time commits. The default kernel/demo path remains in-memory. Trusted
context, pending approvals, and non-commit decisions are not SQL-backed, so
this is a partial persistence integration, not full ADR-003 completion or a
production-ready store.

## Transaction guarantees

One database transaction per simulated authorization:

1. transaction-scoped tenant/key lock and idempotency receipt lookup (replay
   or hard reject on payload drift),
2. unique obligation claim, distinguishing identical intent (`G2_DUPLICATE`)
   from conflicting intent (`G2_CONFLICT`),
3. `SELECT ... FOR UPDATE` on the budget row and exact `NUMERIC` budget check,
4. atomic budget debit, commitment, decision record, idempotency receipt, and
   ledger event for successful commits.

The SQL transaction serializes concurrent retries and spending attempts. A
duplicate claim does not debit budget; an insufficient-budget attempt rolls
back its provisional obligation claim. Non-commit decision records and their
idempotency outcomes remain in the in-memory kernel store.

## Successful-command recovery

Before loading evidence or reevaluating current gates, the protected service
performs a tenant/key/payload-bound durable command lookup. An existing
successful outcome is returned unchanged and its read mirrors are rebuilt
from stored commit metadata. A missing receipt still requires current
authorization; lookup errors and payload drift fail closed. Approval outcome
recovery retains the FinanceAdmin and tenant checks and does not create
durable pending-approval state.

Recovered commitments, obligations, and receipt history retain the persisted
decision timestamp. The in-memory receipt's optional `recoveredAt` records
recovery time separately. Repeated recovery does not append duplicate local
authorization events or debit the SQL budget again.

## Running

The PostgreSQL-backed tests run only when `DATABASE_URL` is set; otherwise
they skip, keeping offline builds green. Use a fresh disposable database for
each test-suite or demo run. Golden fixture identifiers are stable, and the
test runner does not delete existing rows.

```bash
# CI runs the store and kernel integration suites against a fresh postgres:16 service.
# Locally with Docker, use a disposable test-only database for each run:
docker run --rm -d -p 5432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=praeco_test postgres:16
DATABASE_URL=postgres://postgres@localhost:5432/praeco_test npm run test --workspace @praeco/financial-store-sql
```

The optional SQL-backed golden demo also requires a fresh database:

```bash
DATABASE_URL=postgres://postgres@localhost:5432/praeco_test npm run demo --workspace @praeco/financial-store-sql
```

No real payments; every value is synthetic demo data (see AGENTS.md).
