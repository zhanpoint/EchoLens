"use client";

import { DayPicker } from "react-day-picker";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

type CalendarProps = ComponentProps<typeof DayPicker>;

export function Calendar({ className, classNames, ...props }: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays
      className={cn("p-3", className)}
      classNames={{
        root: "w-full text-foreground",
        months: "flex flex-col",
        month: "w-full space-y-3",
        month_caption: "relative flex h-8 items-center px-1",
        caption_label: "inline-flex h-8 items-center gap-1 px-1.5 text-sm font-semibold text-foreground",
        dropdowns: "flex items-center gap-1",
        dropdown_root: "relative inline-flex h-8 rounded-md transition hover:bg-white/[0.06] focus-within:ring-2 focus-within:ring-ring",
        dropdown: "absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0",
        nav: "absolute right-3 top-3 flex items-center gap-1",
        button_previous: "group inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-white/[0.06] hover:text-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan/30",
        button_next: "group inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-white/[0.06] hover:text-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan/30",
        chevron: "size-4 stroke-muted-foreground transition group-hover:stroke-cyan",
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday: "w-9 py-1 text-center text-xs font-semibold text-muted-foreground",
        weeks: "mt-1",
        week: "mt-1 flex w-full",
        day: "size-9 p-0 text-center text-sm",
        day_button: "inline-flex size-9 items-center justify-center rounded-md text-sm text-foreground transition hover:bg-cyan/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan/30",
        selected: "[&>button]:!bg-cyan [&>button]:!font-semibold [&>button]:!text-black hover:[&>button]:!bg-cyan",
        today: "[&>button]:font-semibold [&>button]:text-cyan",
        outside: "[&>button]:text-muted-foreground/45",
        disabled: "[&>button]:cursor-not-allowed [&>button]:opacity-35",
        ...classNames,
      }}
      {...props}
    />
  );
}
