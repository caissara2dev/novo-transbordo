# Contribuindo

## Padrao de trabalho

1. Criar branch a partir da `main`.
2. Implementar mudancas pequenas e focadas.
3. Rodar validacoes locais antes de commit:

```bash
npm run lint
npm test
```

4. Abrir PR com descricao objetiva:
- problema
- solucao
- riscos
- como testar

## Convencao de commits (recomendado)

- `feat: ...`
- `fix: ...`
- `refactor: ...`
- `docs: ...`
- `test: ...`
- `chore: ...`

## Boas praticas deste projeto

- manter regras de negocio em `src/lib/domain`
- manter escrita de dominio em APIs server-side
- evitar logica de permissao espalhada em componentes
- adicionar teste quando alterar regra de negocio
