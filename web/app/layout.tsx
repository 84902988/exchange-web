import type { Metadata } from "next";
import "./globals.css";

import AppChrome from "@/components/layout/AppChrome";
import Providers from "./providers";
import { LocaleProvider } from "@/contexts/LocaleContext";

export const metadata: Metadata = {
  title: "Royal Exchange",
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
          "tabular-nums",
        ].join(" ")}
      >
        <LocaleProvider>
          <Providers>
            <AppChrome>{children}</AppChrome>
          </Providers>
        </LocaleProvider>
      </body>
    </html>
  );
}
