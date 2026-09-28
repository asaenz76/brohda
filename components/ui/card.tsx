import * as React from "react"

import { cn } from "@/lib/utils"

// Brohda 2.0 / Phase B (design-system redesign): the previous bold 2px
// border + hard offset "comic panel" shadow was the site-wide version of
// the same comic-panel treatment removed from Button (see that file's own
// comment) — identified in Phase A as the single biggest blocker to a
// restrained, Mastodon-inspired visual language. Replaced with a 1px
// border and no decorative shadow. `variant` adds the primitives Phase C+
// content work (timeline/Game-Post redesign) will need without redesigning
// any actual content hierarchy here: "default" (a bordered section, the
// existing site-wide usage, now flat), "row" (a bottom-border-only strip
// for a future timeline of stacked rows, no full border/radius so
// consecutive rows read as one continuous list, not stacked cards), and
// "plain" (no border/background at all — pure grouping/spacing, for a
// compact utility surface that shouldn't read as its own card). Existing
// call sites are unaffected: `variant` defaults to "default".
const cardVariants = {
  default: "rounded-lg border border-border-subtle bg-card [--card-spacing:1.125rem] data-[size=sm]:[--card-spacing:0.875rem] *:[img:first-child]:rounded-t-lg *:[img:last-child]:rounded-b-lg",
  row: "border-b border-border-subtle [--card-spacing:1.125rem] data-[size=sm]:[--card-spacing:0.875rem]",
  plain: "[--card-spacing:1.125rem] data-[size=sm]:[--card-spacing:0.875rem]",
} as const

function Card({
  className,
  size = "default",
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & { size?: "default" | "sm"; variant?: keyof typeof cardVariants }) {
  return (
    <div
      data-slot="card"
      data-size={size}
      data-variant={variant}
      className={cn(
        // --card-spacing values are ~15% more generous than the original
        // 12px/16px (an earlier design-system refactor: more generous
        // card/feed spacing), still compact enough not to inflate mobile
        // height.
        "group/card flex flex-col gap-(--card-spacing) overflow-hidden py-(--card-spacing) text-sm text-card-foreground has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 data-[size=sm]:has-data-[slot=card-footer]:pb-0",
        cardVariants[variant],
        className
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-lg px-(--card-spacing) has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-(--card-spacing)",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn(
        "font-heading text-base leading-snug font-medium group-data-[size=sm]/card:text-sm",
        className
      )}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-(--card-spacing)", className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex items-center rounded-b-lg border-t border-border-subtle bg-muted/50 p-(--card-spacing)",
        className
      )}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}
