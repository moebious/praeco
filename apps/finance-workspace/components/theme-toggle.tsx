"use client"

import { Moon, Sun } from "lucide-react"
import { useTheme } from "next-themes"

import { Button } from "@/components/ui/button"

/**
 * Icons are swapped with CSS against the `.dark` class that next-themes sets on
 * <html>, so no mounted-state effect is needed and hydration stays stable.
 *
 * `disableTransitionOnChange` injects `*{transition:none!important}` during the
 * flip; the `!` utilities out-rank that universal selector so only this
 * cross-fade survives the theme switch.
 */
const ICON_TRANSITION =
  "transition-[opacity,scale,filter]! duration-300! ease-[cubic-bezier(0.2,0,0,1)]!"

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Cambiar tema"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
    >
      <span className="relative flex items-center justify-center">
        <Sun
          className={`${ICON_TRANSITION} blur-[0px] dark:scale-[0.25] dark:opacity-0 dark:blur-[4px]`}
          aria-hidden
        />
        <Moon
          className={`${ICON_TRANSITION} absolute scale-[0.25] opacity-0 blur-[4px] dark:scale-100 dark:opacity-100 dark:blur-[0px]`}
          aria-hidden
        />
      </span>
    </Button>
  )
}
