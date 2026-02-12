import type { Metadata } from "next";
import "@/app/globals.css";
import { SessionProvider } from "@/lib/auth/use-auth-session";
import { SiteFooter } from "@/components/site-footer";

export const metadata: Metadata = {
  title: "Controle-Transbordo",
  description: "Operação de transbordo de glicerina"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body className="site-root">
        <SessionProvider>
          <div className="site-frame">
            <div className="site-content">{children}</div>
            <SiteFooter />
          </div>
        </SessionProvider>
      </body>
    </html>
  );
}
