import Link from "next/link";

export function DouyinSectionNav({ active }: { active: "favorites" | "following" }) {
  return (
    <nav
      className="grid grid-cols-2 gap-1 rounded-md bg-white/[0.04] p-1 sm:col-span-2 lg:col-span-1"
      aria-label="收藏与关注"
      role="tablist"
    >
      <SectionLink active={active === "favorites"} href="/douyin/favorites" label="收藏" />
      <SectionLink active={active === "following"} href="/douyin/following" label="关注" />
    </nav>
  );
}

function SectionLink({ active, href, label }: { active: boolean; href: string; label: string }) {
  return (
    <Link
      href={href}
      role="tab"
      aria-selected={active}
      className={`inline-flex h-8 cursor-pointer items-center justify-center rounded-md text-xs font-semibold transition-all active:scale-[0.98] ${active ? "bg-cyan/[0.12] text-cyan shadow-[inset_0_0_0_1px_rgba(34,211,238,0.12)]" : "text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"}`}
    >
      {label}
    </Link>
  );
}
