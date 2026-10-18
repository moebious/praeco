import { Skeleton } from "@/components/ui/skeleton"

/** Mirrors the chat frame (header, transcript, composer) so navigation responds immediately. */
export default function ChatLoading() {
  return (
    <div className="flex min-h-0 flex-1 flex-col" role="status" aria-label="Cargando conversación">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <Skeleton className="size-7" />
        <Skeleton className="size-6 rounded-full" />
        <div className="flex flex-col gap-1">
          <Skeleton className="h-3.5 w-48" />
          <Skeleton className="h-3 w-24" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 pt-12 pb-6">
          <Skeleton className="ml-auto h-9 w-2/3 rounded-2xl" />
          {[0, 1].map((row) => (
            <div key={row} className="flex gap-3">
              <Skeleton className="size-6 shrink-0 rounded-full" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-3.5 w-40" />
                <Skeleton className="h-16 w-full rounded-lg" />
                <Skeleton className="h-3.5 w-5/6" />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="shrink-0 border-t border-border">
        <div className="mx-auto max-w-3xl px-4 py-3">
          <Skeleton className="h-11 w-full rounded-[16px]" />
        </div>
      </div>
    </div>
  )
}
