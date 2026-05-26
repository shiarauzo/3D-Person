import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "3D Person",
  description: "An interactive 3D character scene built with React Three Fiber.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
