import "./globals.css";
import "@fortune-sheet/react/dist/index.css";
import LayoutShell from "@/components/LayoutShell";

export const metadata = {
  title: "Sing Portal",
  description: "Sing in Chinese file system + lesson plan portal",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <LayoutShell>{children}</LayoutShell>
      </body>
    </html>
  );
}
