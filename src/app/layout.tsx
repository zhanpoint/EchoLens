import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "EchoLens",
  description: "透视抖音作品中的声音与文字",
  icons: {
    icon: [{ url: "/echolens-logo.svg", type: "image/svg+xml", sizes: "any" }],
    shortcut: [{ url: "/echolens-logo.svg", type: "image/svg+xml" }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="zh-CN"
      className="dark h-full antialiased"
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
