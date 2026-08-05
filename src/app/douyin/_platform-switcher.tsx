"use client";

type Platform = "douyin" | "bilibili";

export function PlatformSwitcher({
  onChange,
  value,
}: {
  onChange: (platform: Platform) => void;
  value: Platform;
}) {
  return (
    <div className="flex items-center gap-1 text-[15px] font-medium" role="tablist" aria-label="选择平台">
      <PlatformButton active={value === "douyin"} label="抖音" onClick={() => onChange("douyin")} />
      <span className="text-muted-foreground/60" aria-hidden="true">/</span>
      <PlatformButton active={value === "bilibili"} label="Bilibili" onClick={() => onChange("bilibili")} />
    </div>
  );
}

function PlatformButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded-sm px-1 transition-colors ${active ? "text-cyan" : "text-muted-foreground hover:text-foreground"}`}
    >
      {label}
    </button>
  );
}

export type { Platform };