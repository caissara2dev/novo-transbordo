# Contribuindo

## Padrão de trabalho

1. Criar branch a partir da `main`.
   - `feat/<nome>` para funcionalidades.
   - `fix/<nome>` para correções.
   - `chore/<nome>` para infraestrutura e manutenção.
2. Implementar uma mudança pequena e focada por vez.
3. Rodar validacoes locais antes de commit:

```bash
npm run lint
npm test
npm run test:integration
npm run test:rules
npm run build
```

4. Atualizar a versão no `package.json` e registrar a mudança no `CHANGELOG.md`.
5. Abrir PR para `main` com descrição objetiva: problema, solução, riscos e como testar.
6. Validar o preview privado da Vercel antes do merge.
7. Após o App Hosting publicar e o smoke test passar, criar a tag e a GitHub Release.

## Versões

- `PATCH` (`2.0.1`): correção sem nova funcionalidade.
- `MINOR` (`2.1.0`): nova funcionalidade compatível.
- `MAJOR` (`3.0.0`): alteração incompatível de dados ou fluxo.

A produção é `main` no Firebase App Hosting. A Vercel usa somente branches de trabalho e sempre aponta para o Firebase staging.

## Convenção de commits

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
