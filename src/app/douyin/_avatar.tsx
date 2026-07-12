"use client";

import { useState } from "react";

export function DouyinAvatar({ name, url }: { name: string; url: string }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) {
    return (
      <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-white/[0.07] text-xs text-muted-foreground" aria-hidden="true">
        {name.slice(0, 1)}
      </span>
    );
  }
  return (
    // Direct CDN loading lets the browser own avatar caching without using server or OSS storage.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt=""
      className="size-8 shrink-0 rounded-full object-cover"
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}
