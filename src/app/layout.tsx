import type { Metadata } from "next";
import "@/app/globals.css";
import { SessionProvider } from "@/lib/auth/use-auth-session";

export const metadata: Metadata = {
  title: "Controle-Transbordo",
  description: "Operacao de transbordo de glicerina"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
