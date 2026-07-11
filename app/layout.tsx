import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Looper — Prompt loops for Codex",
  description: "Build, run, and evaluate repeatable prompt loops with the Codex CLI.",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
