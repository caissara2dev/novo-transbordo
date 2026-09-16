## Ciclo obrigatório de mudanças

Leia `docs/agents/change-lifecycle.md` antes de alterar este projeto. Toda alteração deve ligar demanda, issue, branch, PR, validação e encerramento. A autorização de staging não autoriza merge ou produção.

## Agent skills

### Issue tracker

Issues e PRDs são acompanhados pelo GitHub Issues. Consulte `docs/agents/issue-tracker.md`.

### Triage labels

Usamos `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human` e `wontfix`. Consulte `docs/agents/triage-labels.md`.

### Domain docs

Layout single-context com `CONTEXT.md` e ADRs em `docs/adr/`. Consulte `docs/agents/domain.md`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
