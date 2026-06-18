"use client";

import { Suspense, type ReactNode } from "react";
import { usePathname } from "next/navigation";

import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";

export default function AppChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  if (pathname === "/restricted") {
    return <>{children}</>;
  }

  return (
    <>
      <Suspense fallback={null}>
        <Header />
      </Suspense>

      {children}

      <Footer />
    </>
  );
}
