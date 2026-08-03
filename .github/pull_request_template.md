## Issue

Tracks #

## Problema e solução

<!-- Explique o problema, a abordagem adotada e o que ficou fora do escopo. -->

## Riscos e rollback

<!-- Inclua impacto em dados, permissões, regras, índices, deploy e como reverter. -->

## Evidências

<!-- Screenshots, vídeos, logs sanitizados ou URL do preview de staging. -->

## Checklist

### Escopo

- [ ] A branch parte da `main` atualizada e o diff está focado.
- [ ] Commits seguem Conventional Commits.
- [ ] A issue e o milestone corretos estão vinculados.
- [ ] Documentação e `CHANGELOG.md` foram atualizados quando necessário.
- [ ] Não há segredos, dados pessoais ou artefatos gerados no diff.

### Gates

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run verify:firestore-indexes`
- [ ] `npm run test:coverage` com cobertura global mínima de 80%
- [ ] `npm run test:rules`
- [ ] `npm run test:e2e`
- [ ] `npm run build`
- [ ] `npm run audit:prod`

### Publicação

- [ ] Regras e índices foram validados e publicados em staging.
- [ ] Os índices necessários estão `Ready` antes da aplicação.
- [ ] O preview usa exclusivamente o Firebase staging.
- [ ] Smoke test e aceite de staging foram concluídos.
- [ ] O plano de produção e rollback foi registrado na issue de release.

## Como testar

<!-- Liste passos reproduzíveis e perfis necessários. -->

1.
