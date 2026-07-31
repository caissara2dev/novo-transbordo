# Contribuindo

Este projeto usa GitHub Issues como fonte de trabalho, pull requests como porta
de entrada para a `main` e versionamento semântico para releases. Não faça push
direto para `main` nem publique produção a partir de uma branch de trabalho.

## Fluxo de trabalho

1. Abra ou selecione uma issue antes de iniciar.
2. Confirme escopo, critérios de aceite, riscos e dependências.
3. Associe a issue ao milestone da release, quando houver entrega programada.
4. Crie uma branch atualizada a partir da `main`.
5. Implemente uma mudança pequena, com testes adequados ao risco.
6. Execute todos os gates locais.
7. Faça commits focados e abra um pull request vinculado à issue.
8. Valide a aplicação em staging antes de autorizar produção.

Mudanças sem issue são aceitas apenas para correções triviais de documentação ou
manutenção emergencial; ainda assim, o pull request deve explicar o motivo.

## Issues, labels e milestones

Use os formulários de bug, funcionalidade ou release em
`.github/ISSUE_TEMPLATE/`. Uma issue pronta deve conter contexto, resultado
esperado, critérios de aceite e instruções de validação.

Os estados de triagem são:

- `needs-triage`: aguardando avaliação;
- `needs-info`: faltam informações do solicitante;
- `ready-for-agent`: especificação suficiente para execução automatizada;
- `ready-for-human`: exige decisão ou execução humana;
- `wontfix`: não será implementada, com justificativa registrada.

Use também o label de tipo correspondente, quando disponível: `bug`,
`enhancement` ou `release`. Segurança deve ser tratada em canal privado e só
transformada em issue pública depois da contenção.

Cada entrega programada pertence a um milestone `MAJOR.MINOR.PATCH`. O milestone
deve concentrar a issue de release e todas as mudanças obrigatórias. Itens que
não bloqueiam a entrega devem ser movidos explicitamente para outro milestone,
nunca encerrados silenciosamente.

## Branches

Crie branches a partir da `main` atualizada:

- `feat/<descricao>` para funcionalidades;
- `fix/<descricao>` para correções;
- `refactor/<descricao>` para refatorações sem mudança funcional;
- `test/<descricao>` para cobertura de testes;
- `docs/<descricao>` para documentação;
- `chore/<descricao>` para infraestrutura e manutenção.

Use nomes curtos, em minúsculas e separados por hífen. Uma branch deve atender a
uma issue ou a um conjunto pequeno de issues inseparáveis.

## Commits

Use Conventional Commits:

```text
<tipo>: <descrição no imperativo>
```

Tipos aceitos: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf` e
`ci`. Não misture refatorações amplas, dependências e comportamento funcional no
mesmo commit. Nunca inclua segredos, arquivos `.env`, dados pessoais ou
artefatos gerados.

## Gates obrigatórios

Antes de abrir ou atualizar um pull request, execute:

```bash
npm ci
npm run lint
npm run typecheck
npm run verify:firestore-indexes
npm run test:coverage
npm run test:rules
npm run test:e2e
npm run build
npm run audit:prod
```

Critérios de aprovação:

- lint sem warnings;
- TypeScript sem erros;
- cobertura global mínima de 80%;
- testes unitários e de integração incluídos pelo `test:coverage` aprovados;
- testes de regras do Firestore aprovados;
- E2E dos fluxos críticos aprovados;
- manifesto de índices válido;
- build de produção concluído;
- auditoria de dependências de produção sem vulnerabilidades no nível bloqueado.

`npm run verify` consolida esses gates. Uma falha deve ser corrigida ou
explicitamente bloqueada; não reduza cobertura, severidade da auditoria ou
proteções para fazer o pipeline passar.

## Pull requests

Abra o PR para `main` usando `.github/pull_request_template.md` e:

- vincule a issue com `Tracks #<número>`;
- use `Closes #<número>` somente quando o merge realmente encerrar a issue;
- mantenha issues de release abertas até o smoke test de produção;
- descreva problema, solução, riscos e rollback;
- liste os testes realmente executados;
- inclua evidências visuais para mudanças de interface;
- mantenha o diff focado e o changelog atualizado quando houver impacto de
  release;
- aguarde CI, revisão e preview de staging antes do merge.

PRs incompletos devem permanecer como draft. Conversas de revisão precisam ser
resolvidas com mudança, justificativa técnica ou issue de acompanhamento.

## Ordem de publicação

A promoção é sempre progressiva:

1. todos os gates locais e de CI aprovados;
2. staging selecionado e confirmado;
3. validação e dry-run do manifesto de índices;
4. deploy das regras e dos índices em staging;
5. espera explícita até todos os índices necessários ficarem `Ready`;
6. publicação da aplicação/preview apontando exclusivamente para staging;
7. smoke test dos fluxos críticos e aprovação da release;
8. repetição do gate de regras e índices em produção;
9. espera dos índices de produção ficarem `Ready`;
10. dry-run e execução confirmada do backfill idempotente de `containerStates`;
11. merge em `main`, publicação pelo Firebase App Hosting e smoke test;
12. criação da tag e da GitHub Release.

Nunca publique a aplicação antes dos índices exigidos pelo build estarem
`Ready`. A Vercel é usada apenas para branches de trabalho com o projeto Firebase
de staging; a produção é publicada a partir da `main` pelo Firebase App Hosting.

Consulte `docs/OPERACAO_LOCAL.md` para comandos, projetos e smoke tests.

## Versões, tags e releases

O projeto segue SemVer:

- `PATCH`: correção compatível;
- `MINOR`: funcionalidade compatível;
- `MAJOR`: mudança incompatível de contrato, dados ou fluxo.

Atualize `package.json`, lockfile e `CHANGELOG.md` no PR de release. A linha
2.1 foi incorporada à 2.2 e não recebe tag própria; seu conteúdo faz parte da
release `v2.2.0`.

Tags são imutáveis e só podem ser criadas depois do smoke test de produção:

```bash
git tag -a v2.2.0 -m "release: v2.2.0"
git push origin v2.2.0
```

Não mova nem reutilize uma tag publicada. A GitHub Release deve resumir mudanças,
migrações, riscos conhecidos, validação e referência de rollback.

## Rollback

Antes de produção, registre a tag/commit estável atual e confirme que o rollback
está disponível. Em caso de falha:

1. interrompa a promoção e preserve evidências;
2. reverta a aplicação para o último rollout estável do Firebase App Hosting;
3. abra um PR de `git revert` do commit problemático;
4. execute novamente todos os gates e faça smoke test;
5. restaure regras anteriores somente por deploy revisado;
6. mantenha índices compatíveis durante o rollback — não exclua índices como
   resposta emergencial;
7. documente impacto, decisão e acompanhamento na issue de release.

Mudanças de dados precisam de plano de reversão próprio antes do merge. Nunca
apague dados ou altere credenciais como tentativa improvisada de rollback.

## Boas práticas do projeto

- mantenha regras de negócio em `src/lib/domain`;
- mantenha escrita de domínio em APIs server-side;
- evite lógica de permissão espalhada em componentes;
- valide entradas nas fronteiras do sistema;
- prefira objetos novos em vez de mutação;
- adicione testes para toda alteração de comportamento.
