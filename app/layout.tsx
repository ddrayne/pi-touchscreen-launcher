import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Touchscreen Assistant",
  description:
    "A voice-first home screen with a live doorway into BirdFrame.",
  icons: {
    icon: "/birdframe-icon.png",
    shortcut: "/birdframe-icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
