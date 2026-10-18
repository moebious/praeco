# Finance dashboard

Local inspector for Praeco's eight synthetic financial scenarios. It displays gate-by-gate decisions and supports simulated FinanceAdmin approval of eligible exceptions.

## Run

From the repository root:

```bash
npm ci
npm run build
npm run web
```

Open [localhost:3000](http://localhost:3000). The server binds to loopback by default and prints a generated session token. Enter that token in the dashboard for protected operations. Set `PRAECO_DASHBOARD_TOKEN` locally to use a stable token; keep it out of committed files.

`PORT` changes the listening port. `PRAECO_DASHBOARD_HOST` changes the bind address; the default is `127.0.0.1`.

## Scope

This app exercises the L2 synthetic scenario services directly. It is not the complete authenticated L3 intake workspace, and its scenario ledgers are in-memory. Resetting the demo clears its local scenario state. No real payments execute.

## Test

```bash
npm run test --workspace @praeco/finance-dashboard
```

See the [financial kernel](../../packages/financial-decision-kernel/README.md) and [server implementation](src/server.ts).
