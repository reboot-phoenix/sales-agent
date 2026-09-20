import * as React from "react";
import { cn } from "@/components/ui/cn";

export interface PageHeaderProps {
  title: string;
  description?: string;
  /** Mono micro-caps kicker above the title (wafer-style section eyebrow). */
  eyebrow?: string;
  actions?: React.ReactNode;
  className?: string;
}

export function PageHeader({ title, description, eyebrow, actions, className }: PageHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between",
        className,
      )}
    >
      <div className="min-w-0 space-y-phi1">
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1 className="text-2xl font-semibold tracking-[-0.02em] text-balance sm:text-[28px]">{title}</h1>
        {description && (
          <p className="max-w-phi-body text-sm leading-relaxed text-muted-foreground text-pretty">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-phi2">{actions}</div>
      )}
    </div>
  );
}
