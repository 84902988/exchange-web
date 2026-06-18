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
    <html lang="en" suppressHydrationWarning>
      <head>
        <style>{`html.locale-preload body{visibility:hidden}`}</style>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function(){
                try {
                  var locale = localStorage.getItem('language') || localStorage.getItem('locale');
                  if (locale && locale !== 'en') {
                    document.documentElement.classList.add('locale-preload');
                  }
                } catch (e) {}
              })();
            `,
          }}
        />
      </head>
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
