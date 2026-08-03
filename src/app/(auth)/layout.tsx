import { SiteFooter } from "@/components/site-footer";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <main className="auth-wrap">{children}</main>
      <SiteFooter />
    </>
  );
}
