"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

const MIN_WIDTH = 208;
const MAX_WIDTH = 400;
const STORAGE_KEY = "echolens:history-sidebar-width";

export function ResizableSidebar({ open, children }: { open: boolean; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const [width, setWidth] = useState(MIN_WIDTH);
  const [maximum, setMaximum] = useState(MAX_WIDTH);
  const [dragging, setDragging] = useState(false);
  const clamp = (value: number) => Math.max(MIN_WIDTH, Math.min(maximum, value));

  useEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const observer = new ResizeObserver(([entry]) => {
      setMaximum(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(entry.contentRect.width * 0.45))));
    });
    observer.observe(parent);
    const frame = requestAnimationFrame(() => {
      try {
        const saved = Number(localStorage.getItem(STORAGE_KEY));
        if (Number.isFinite(saved) && saved >= MIN_WIDTH) setWidth(Math.min(MAX_WIDTH, saved));
      } catch { /* Storage may be disabled. Resizing still works for this session. */ }
    });
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
    };
  }, [dragging]);

  function save(value: number) {
    try { localStorage.setItem(STORAGE_KEY, String(value)); } catch { /* Optional preference. */ }
  }

  const effectiveWidth = clamp(width);
  return (
    <aside
      ref={ref}
      style={{ width: open ? effectiveWidth : 48 }}
      className="relative hidden h-full shrink-0 border-r border-white/10 bg-background/90 backdrop-blur md:block"
    >
      {children}
      {open ? (
        <div
          role="separator"
          tabIndex={0}
          aria-label="调整侧边栏宽度"
          aria-orientation="vertical"
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={maximum}
          aria-valuenow={effectiveWidth}
          aria-valuetext={`${effectiveWidth} 像素`}
          title="拖动调整宽度，双击恢复默认；方向键微调"
          className={cn(
            "absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-[3px] after:w-0.5 after:transition-colors hover:after:bg-cyan/60 focus-visible:after:bg-cyan",
            dragging && "after:bg-cyan",
          )}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { pointerId: event.pointerId, x: event.clientX, width: effectiveWidth };
            setDragging(true);
          }}
          onPointerMove={(event) => {
            const start = drag.current;
            if (start?.pointerId === event.pointerId) setWidth(clamp(start.width + event.clientX - start.x));
          }}
          onPointerUp={(event) => {
            if (drag.current?.pointerId !== event.pointerId) return;
            save(effectiveWidth);
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onLostPointerCapture={() => { drag.current = null; setDragging(false); }}
          onDoubleClick={() => { setWidth(MIN_WIDTH); save(MIN_WIDTH); }}
          onKeyDown={(event) => {
            const value = event.key === "ArrowLeft" ? effectiveWidth - 8
              : event.key === "ArrowRight" ? effectiveWidth + 8
                : event.key === "Home" ? MIN_WIDTH : event.key === "End" ? maximum : null;
            if (value === null) return;
            event.preventDefault();
            const next = clamp(value);
            setWidth(next);
            save(next);
          }}
        />
      ) : null}
    </aside>
  );
}
