export default function PayableCaseLoading() {
  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="text-sm text-muted-foreground">Cuentas por pagar</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-8" aria-busy="true">
          <div className="h-6 w-2/3 animate-pulse rounded-md bg-muted" />
          <div className="h-4 w-1/2 animate-pulse rounded-md bg-muted/70" />
          <div className="h-40 animate-pulse rounded-xl border border-border bg-muted/40" />
          <p role="status" className="text-sm text-muted-foreground">
            Procesando evidencia con el pipeline L1…
          </p>
        </div>
      </div>
    </>
  )
}
