import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { SessionProvider } from "./session-provider";
import { ServerWakeupProvider } from "@/lib/server-wakeup-context";
import { WalletProvider } from "@/context/wallet-context";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Code Review Agent",
  description: "AI-powered code review with clustering, standards enforcement, and follow-up chat.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-app-bg text-gray-100`}
      >
        <ServerWakeupProvider>
          <SessionProvider>
            <WalletProvider>{children}</WalletProvider>
          </SessionProvider>
        </ServerWakeupProvider>
      </body>
    </html>
  );
}
