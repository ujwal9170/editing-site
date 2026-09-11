import type { Metadata } from "next";
import "@fontsource/inter/400.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/dm-sans/700.css";
import "@fontsource/montserrat/700.css";
import "@fontsource/roboto/700.css";
import "./globals.css";
export const metadata: Metadata = {
  title: "Frame / Editing Studio",
  description: "Your media, your edits, ready for Instagram.",
  icons: { icon: "/favicon.svg" },
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
