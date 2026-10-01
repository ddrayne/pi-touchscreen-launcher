import type { Metadata } from "next";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/literata/600.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kitchen Screen",
  description:
    "The garden's birds, timers, rain and the kitchen speaker on the Pi touchscreen.",
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
