import type { Metadata } from "next";
import "@/app/globals.css";
import { SessionProvider } from "@/lib/auth/use-auth-session";

export const metadata: Metadata = {
  title: "Controle-Transbordo",
  description: "Operação de transbordo de glicerina"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const isStaging = process.env.NEXT_PUBLIC_APP_ENV === "staging";

  return (
    <html lang="pt-BR">
      <body className="site-root">
        <SessionProvider>
          <div className="site-frame">
            {isStaging ? (
              <div className="environment-banner" role="status">
                AMBIENTE DE TESTE — dados separados da produção
              </div>
            ) : null}
            <div className="site-content">{children}</div>
          </div>
        </SessionProvider>
      </body>
    </html>
  );
}
