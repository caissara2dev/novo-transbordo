> Registro histórico da implementação/homologação. As frases de estado se referem à data do documento. Para a consolidação atual e as pendências de produção, consulte [CHECKIN_V2_ENTREGA.md](CHECKIN_V2_ENTREGA.md).

# Evidências locais — Check-in v2

Validação em 10/09/2026. Implementação em `codex/checkin-system-v2`, partindo da
main v2.5.0 (`efa3abf5ed7448f5c32253f18984eaa997eb9ae2`). Portal preservado em
worktree independente. Nenhuma escrita em produção, Excel ou SharePoint.

| Verificação | Resultado |
|---|---|
| Backend: domínio, serviços e APIs | 532 testes aprovados em 63 arquivos |
| Cobertura backend | 90,67% instruções; 82,53% ramos; 96,33% funções; 92,56% linhas |
| Regras Firestore (emulador demo) | 19 testes aprovados |
| Aplicação autenticada (navegador) | 17 testes aprovados, incluindo analista e cliente |
| Protótipo | 8 testes aprovados: desktop e celular |
| Portal motorista | 36 testes aprovados em 7 arquivos; 6 cenários de navegador aprovados |
| Cobertura portal | 93,96% instruções; 83,40% ramos; 93,33% funções; 95,75% linhas |
| Build final backend e portal | Next.js 16.3.4 / Turbopack, Node 22.23.2 |
| Lint e TypeScript | Aprovados nos dois worktrees |
| Índices e isolamento do bundle | Aprovados; Firebase Admin somente no servidor |
| HTML autônomo | Abre por file://, sem imports externos e sem erro JavaScript |
| Dependências de produção backend | npm audit: zero avisos |
| Dependências totais backend | 15 moderados e 1 baixo; zero alto/crítico |
| Dependências totais portal | 3 moderados; zero alto/crítico |

Os avisos restantes estão nas ferramentas de desenvolvimento. Os limites de
segurança configurados pelos projetos passaram; isto não equivale a uma auditoria
exaustiva do sistema. Os logs e evidências são locais.

## Ajustes decorrentes da validação

- Next.js atualizado de uma versão vulnerável para 16.3.4; Sharp fixado em 0.35.4
  nos dois worktrees. Lockfiles atualizados também para versões compatíveis das
  dependências transitivas sinalizadas. As instalações originais foram preservadas.
- Referência: [aviso oficial do Next.js](https://github.com/vercel/next.js/security/advisories/GHSA-2xp9-vwfh-vxw4)
  e [aviso Sharp/libheif](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c).
- Teste do bundle reconhece também nomes de chunks com prefixo hash do Turbopack;
  continua rejeitando Admin externo ou presente no bundle cliente.
- Duas falhas iniciais com recarga de desenvolvimento não se reproduziram no
  aplicativo compilado. As duas execuções completas no build passaram (17/17).
- Artefatos gerados do protótipo ficam fora do lint. A implementação e os testes
  continuam sendo verificados sem reduzir limites de cobertura ou segurança.

## O que estes testes não comprovam

O fluxo foi validado com emuladores e dados fictícios; as APIs de negócio nos
testes de navegador são simuladas, enquanto transações e permissões são cobertas
por testes de serviços/APIs e regras. Falta homologação conjunta do portal com o
backend num ambiente separado, validação dos usuários e conferência do fluxo
operacional real. O roteiro está em `checkin-v2-homologacao.md`.

Nenhuma conta de cliente real foi liberada. Nenhum projeto Firebase foi criado,
alterado ou publicado. Não houve migração de fila nem importação de planilhas.
