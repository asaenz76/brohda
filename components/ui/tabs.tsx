"use client"

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"

import { cn } from "@/lib/utils"

// Phase B (design-system redesign) — the restrained tab treatment
// Discovery (Sports | Leagues | Teams) will need, built now so Phase C
// has a real primitive to adopt rather than inventing one under time
// pressure. Deliberately NOT the shadcn "pill" tab look: an underline
// indicator sliding beneath the selected tab, matching the brief's own
// Mastodon-restraint direction ("no giant pills, no dashboard-card
// treatment"). Keyboard navigation, `aria-selected`, and roving tabindex
// are handled by @base-ui/react/tabs itself (same underlying primitive
// already used for Checkbox/Switch in this file's siblings) — nothing
// here reimplements that.

function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn("flex flex-col gap-3", className)} {...props} />
}

function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn("relative flex items-stretch gap-1 border-b border-border-subtle", className)}
      {...props}
    />
  )
}

function TabsTab({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-tab"
      className={cn(
        "relative -mb-px cursor-pointer border-b-2 border-transparent px-3 py-2.5 text-sm font-medium whitespace-nowrap text-text-muted outline-none transition-colors select-none hover:text-text-primary focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50 data-[selected]:border-accent-primary data-[selected]:text-text-primary",
        className
      )}
      {...props}
    />
  )
}

function TabsPanel({ className, ...props }: TabsPrimitive.Panel.Props) {
  return <TabsPrimitive.Panel data-slot="tabs-panel" className={cn("outline-none", className)} {...props} />
}

export { Tabs, TabsList, TabsTab, TabsPanel }
