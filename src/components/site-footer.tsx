export function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="site-footer" role="contentinfo">
      <p>
        &copy; {year} Matheus Raimundo. Uso interno autorizado. Todos os direitos reservados.
      </p>
    </footer>
  );
}
