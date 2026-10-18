"use client"

import { Monitor } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/**
 * Desktop control placeholder. Deliberately inert: the sandbox adapter arrives in
 * B5, so this reports an unconfigured capability instead of failing on open.
 * `aria-disabled` (not `disabled`) keeps the trigger hoverable and focusable so
 * the explanation stays reachable.
 */
export function DesktopStatus() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            static
            aria-disabled="true"
            aria-label="Escritorio: no configurado"
            className="text-muted-foreground hover:bg-transparent hover:text-muted-foreground"
          />
        }
      >
        <Monitor aria-hidden />
      </TooltipTrigger>
      <TooltipContent>
        Escritorio no configurado. La inspección se habilita en un bloque posterior.
      </TooltipContent>
    </Tooltip>
  )
}
