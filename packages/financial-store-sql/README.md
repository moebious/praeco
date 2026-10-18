# @praeco/financial-store-sql

SQL-backed authoritative store proving the **ADR-003 financial transaction
boundary** against real PostgreSQL, ahead of wiring it into the L2 kernel.

Status: schema and the `commitPayable` transaction are implemented and proven
in CI; the kernel still runs on the in-memory store. The integration (kernel
service delegating its commit path to `commitPayable`) is the next slice.

## Transaction guarantees

One database transaction per simulated authorization:

1. idempotency receipt lookup scoped to tenant + key (replay or hard reject on
   payload drift),
2. `SELECT ... FOR UPDATE` on the budget row, so concurrent payables serialize,
3. obligation claim on the unique canonical payable key **before** the debit,
   so a duplicate rolls back with zero budget movement,
4. atomic budget debit with exact `NUMERIC` decimals (never floats),
5. decision record, idempotency receipt and ledger event committed together.

## Running

The suite runs only when `DATABASE_URL` is set; otherwise it skips, keeping
offline builds green.

```bash
# CI runs it against a postgres:16 service container. Locally with Docker:
docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=praeco_test postgres:16
DATABASE_URL=postgres://postgres:postgres@localhost:5432/praeco_test npm run test --workspace @praeco/financial-store-sql
```

No real payments; every value is synthetic demo data (see AGENTS.md).
