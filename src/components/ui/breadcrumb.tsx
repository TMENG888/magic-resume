import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const breadcrumbVariants = cva(
  "overflow-hidden text-sm text-muted-foreground transition-colors hover:text-foreground"
);

function Breadcrumb({ ...props }: React.ComponentProps<"nav">) {
  return <nav aria-label="breadcrumb" {...props} />;
}

function BreadcrumbList({ className, ...props }: React.ComponentProps<"ol">) {
  return (
    <ol
      {...props}
      className={cn(
        "flex flex-wrap items-center gap-1.5 break-words text-sm text-muted-foreground sm:gap-2.5 [&>li]:flex [&>li]:items-center [&>li]:gap-1.5 [&>li]:sm:gap-2.5",
        className
      )}
    />
  );
}

function BreadcrumbItem({ className, ...props }: React.ComponentProps<"li">) {
  return <li {...props} className={cn("inline-flex items-center gap-1.5", className)} />;
}

function BreadcrumbLink({
  asChild,
  className,
  ...props
}: React.ComponentProps<"a"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "a";
  return <Comp {...props} className={cn(breadcrumbVariants(), className)} />;
}

function BreadcrumbPage({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      aria-current="page"
      {...props}
      className={cn("font-normal text-foreground", className)}
    />
  );
}

function BreadcrumbSeparator({ children, className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      aria-hidden="true"
      {...props}
      className={cn("[&>svg]:size-3.5 text-muted-foreground/60", className)}
    >
      {children ?? <ChevronRightSmall />}
    </li>
  );
}

const ChevronRightSmall = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m9 18 6-6-6-6" />
  </svg>
);

export {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
};
