import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 rounded-full px-3 py-1 font-medium whitespace-nowrap",
  {
    variants: {
      variant: {
        secondary: "bg-surface-secondary text-text-secondary",
        primary: "bg-surface-secondary text-text-primary",
      },
      size: {
        default: "text-xs",
        lg: "gap-1.5 text-sm",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "default",
    },
  }
)

function Badge({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
