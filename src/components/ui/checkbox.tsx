"use client";

import { useEffect, useRef, type ComponentProps } from "react";
import { Check, Minus } from "lucide-react";

export function Checkbox({
  indeterminate = false,
  className = "",
  ...props
}: Omit<ComponentProps<"input">, "type"> & { indeterminate?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current) input.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <span className={`relative inline-flex size-4 shrink-0 ${className}`}>
      <input
        {...props}
        ref={input}
        type="checkbox"
        className="peer size-4 cursor-pointer appearance-none rounded-[4px] border border-muted-foreground/50 bg-background transition-colors checked:border-primary checked:bg-primary indeterminate:border-primary indeterminate:bg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none"
      />
      {indeterminate ? (
        <Minus
          aria-hidden="true"
          className="pointer-events-none absolute inset-0.5 size-3 text-primary-foreground"
        />
      ) : (
        <Check
          aria-hidden="true"
          strokeWidth={3}
          className="pointer-events-none absolute inset-0.5 size-3 text-primary-foreground opacity-0 peer-checked:opacity-100"
        />
      )}
    </span>
  );
}
