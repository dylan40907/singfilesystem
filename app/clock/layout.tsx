import type { Metadata, Viewport } from "next";
import { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Sing Hours",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1, // prevents iOS auto-zoom on input focus
  userScalable: false,
};

export default function ClockLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
