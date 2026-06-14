import type { Metadata } from "next";
import { Suspense } from "react";
import "./globals.css";

import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";
import Providers from "./providers";
import { LocaleProvider } from "@/contexts/LocaleContext";

export const metadata: Metadata = {
  title: "RE",
  description: "",
  icons: {
    icon: "/icons/logo-1.svg",
    shortcut: "/icons/logo-1.svg",
    apple: "/icons/logo-1.svg",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body
        className={[
          "antialiased",
          "bg-[#0b0b0f]",
          "text-white",
          "min-h-screen",
          "font-sans",
        ].join(" ")}
      >
        <LocaleProvider>
          <Providers>
            <Suspense fallback={null}>
              <Header />
            </Suspense>

            {children}

            <Footer />
          </Providers>
        </LocaleProvider>
      </body>
    </html>
  );
}
