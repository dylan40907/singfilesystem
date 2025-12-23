import "./globals.css";
import Navbar from "@/components/Navbar";
import "@fortune-sheet/react/dist/index.css";


export const metadata = {
  title: "Sing Portal",
  description: "Sing in Chinese file system + lesson plan portal",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Navbar />
        <div className="page">
          <div className="container">{children}</div>
        </div>
      </body>
    </html>
  );
}
