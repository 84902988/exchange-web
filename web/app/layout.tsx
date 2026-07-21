import type { Metadata } from "next";
import "./globals.css";

import AppChrome from "@/components/layout/AppChrome";
import Providers from "./providers";
import { LocaleProvider } from "@/contexts/LocaleContext";

export const metadata: Metadata = {
  title: "Royal Exchange",
  description: "",
  icons: {
    icon: [
      {
        url: "/icons/royal-exchange-favicon-32.png?v=20260721",
        type: "image/png",
        sizes: "32x32",
      },
      {
        url: "/favicon.ico?v=20260721",
        type: "image/x-icon",
      },
    ],
    shortcut: "/favicon.ico?v=20260721",
    apple: {
      url: "/icons/royal-exchange-apple-touch-icon.png?v=20260721",
      type: "image/png",
      sizes: "180x180",
    },
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
                    window.setTimeout(function(){
                      document.documentElement.classList.remove('locale-preload');
                    }, 1500);
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
