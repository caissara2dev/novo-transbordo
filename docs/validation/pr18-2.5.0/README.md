# Homologação da origem automática — PR #18 / 2.5.0

Data: 2026-09-06. Código homologado: `cd5d8cf977d3b2003c95a4bd65694b94feab0ed2`.

**Escopo desta entrega: staging e revisão.** O responsável solicitou avaliar a
preview antes de autorizar produção. Não houve merge, backfill de produção,
deploy no Firebase App Hosting, tag ou GitHub Release. A base de produção
permanece `20497bae07fd861a355000ed613a380d32dc149e` / 2.4.0.

## Aplicação publicada

- Projeto Firebase confirmado: `line-transbordo-staging-382612`.
- Vercel: projeto `novo-transbordo-staging`, destino `preview`.
- [Origem automática habilitada](https://novo-transbordo-staging-94lvbx1x0-caissara2devs-projects.vercel.app/events): `dpl_DoQjVMguYAuXPh8rdLE51DCZMr4B`, `READY`, flag `true`.
- [Recuperação compatível](https://novo-transbordo-staging-env8hxres-caissara2devs-projects.vercel.app/events): `dpl_AWtbtEVt6d42apHhkVPAFvS4xJft`, `READY`, mesmo código, flag `false`.

As previews usam a autenticação normal do Firebase e o banner de ambiente de
teste. A proteção de acesso da Vercel é adicional ao login do aplicativo; um
link compartilhado temporário foi entregue ao responsável. Credenciais e
cookies não fazem parte deste repositório. As rotas, mocks, sessão e fixtures
do laboratório A/B não foram incorporados à aplicação.

## Gate automatizado

`npm run verify` completo aprovado com Node 22 e Java 21:

| Verificação | Resultado |
| --- | --- |
| Unitários e integração | 360 aprovados / 50 arquivos |
| Regras Firestore no emulador | 17 aprovados |
| Playwright E2E | 15 aprovados |
| Cobertura statements / branches | 91,33% / 83,34% |
| Cobertura functions / lines | 94,62% / 92,27% |
| Lint, tipos, manifesto de índices | Aprovados |
| Build e separação do bundle server | Aprovados |
| Auditoria de produção | Zero vulnerabilidades |
| Auditoria total | Gate aprovado; 14 avisos em dependências de desenvolvimento (1 baixo, 10 moderados, 3 altos), nenhum crítico |

Os cenários automatizados incluem prefixos indefinidos, placas antiga/Mercosul,
minúsculas/espaços/hífens, colagem/correção/cursor, seleção por teclado,
paginação/resposta atrasada/erro, cliente herdado, destino igual à origem,
fontes inelegíveis, conflitos concorrentes em edição/exclusão/restauração,
reconstrução retroativa, concordância das projeções/backfill e regressão Blend.

- [CI do código homologado](https://github.com/caissara2dev/novo-transbordo/actions/runs/34017595748/job/101444054398): aprovado.
- [CodeQL JavaScript/TypeScript](https://github.com/caissara2dev/novo-transbordo/actions/runs/34017594163/job/101444052548): aprovado.
- [CodeQL Actions](https://github.com/caissara2dev/novo-transbordo/actions/runs/34017594163/job/101444052401): aprovado.

Alterações posteriores restritas a este registro e imagens devem ser
identificadas como documentação; os checks da PR continuam obrigatórios no
commit final. A revisão inicial pulada pelo CodeRabbit por ser draft não
constitui revisão efetiva; seu resultado posterior fica registrado na PR.

## Regras, índices e backfill de staging

Regras publicadas conferem com `firestore.rules`; release
`073b758a-3e01-4f43-9a42-6859484c0aed`. Os índices necessários foram comparados
com o manifesto e estavam `READY`, incluindo a consulta por origem.

| Etapa | Resultado |
| --- | --- |
| Base inspecionada antes das fixtures | 955 eventos / 521 projeções existentes |
| Dry-run | 755 eventos elegíveis, 510 candidatos válidos |
| Exceções legadas | 11 eventos com identificador de container inválido, preservados e reportados |
| Execução | 509 projeções atualizadas; 1 já consistente; 521 documentos finais |
| Segunda execução | 0 gravações; 510 candidatos já consistentes |
| Integridade dos eventos | Os mesmos 955 eventos, sem alterações |

SHA-256 do conteúdo ordenado dos 955 eventos antes/depois do backfill:
`24952a94766d475a2f23cc3ca51a68e0136d0eea182a16c33e8844c24021d2c4`.

As 11 exceções são anteriores ao contrato de origem. Seus eventos e projeções
existentes não foram corrigidos, excluídos ou substituídos. O backfill continua
rejeitando identificadores inválidos nos eventos que já seguem o contrato novo.
A segunda execução terminou com 530 projeções porque as nove projeções de
fixtures foram criadas durante a verificação; seus 510 candidatos da base
anterior não receberam nenhuma escrita.

## Operações reais em staging

Conta e cliente de homologação identificados com `[PR18 QA]`, sem carga real.
Os lançamentos foram realizados pela API autenticada da aplicação publicada;
o navegador fez login pelo formulário normal. Não houve interceptação de
rotas nem substituição de respostas.

| Cenário | Resultado observado |
| --- | --- |
| Pulmão, com carga remanescente | Origem permaneceu `BUFFER` |
| Pulmão, completamente esvaziado | Origem passou a `TRANSFER_EMPTIED` |
| Parcial, com carga remanescente | Origem permaneceu `PARTIAL` |
| Parcial, completamente esvaziado | Origem passou a `TRANSFER_EMPTIED` |
| Histórico bilateral | Mesmo ID de transferência, uma passagem em cada container |
| Busca de origem | Apenas estados elegíveis; duas páginas sem repetir o item |
| Edição retroativa da origem | Alteração Pulmão → Parcial refletida na passagem SOURCE posterior; reversão validada |
| Troca de origem | Linhas do tempo da origem antiga, nova e destino reconciliadas; troca revertida |
| Exclusão/restauração | Pulmão reaberto ao excluir; encerramento restaurado com eventos posteriores presentes |
| Versão selecionada desatualizada | HTTP 409, sem substituição silenciosa da versão |
| Relatório e CSV | 9 eventos produtivos antes da recuperação, incluindo 4 transferências contadas uma única vez |
| Navegador | Login normal, reconhecimento, seleção explícita, cliente herdado e desktop/celular; sem erro de página ou overflow horizontal |

O teste de recuperação acrescenta somente uma carreta independente de
homologação. Os lançamentos continuam identificados como fixtures de staging.

## Recuperação compatível

Teste concluído em 2026-09-06, 07:08:50 UTC, no deployment separado com a
flag `false`:

| Operação | Resultado |
| --- | --- |
| `/api/me` | `containerTransfersEnabled: false`; preview principal continuou `true` |
| Histórico e relatório com transferências | Leitura preservada |
| Nova transferência | HTTP 409 com mensagem explícita de indisponibilidade |
| Edição e exclusão de transferência | HTTP 409 com a mesma mensagem |
| Edição de carreta que afeta a linha do tempo de uma transferência | HTTP 409 |
| Restauração de transferência | HTTP 409; fixture restaurada pela preview habilitada ao terminar |
| Criação de carreta independente | Sucesso; projeção `FULL` |
| Contagem final de fixtures | 10 eventos produtivos; as mesmas 4 transferências |

O acesso ao deployment de recuperação usou o comando oficial `vercel curl`
para atravessar a proteção da hospedagem, mantendo o token de login normal do
Firebase nas chamadas da aplicação. A autenticação do aplicativo permaneceu
obrigatória.

A estratégia é republicar código que conhece os dois papéis com a flag
desligada, preservando histórico e auditoria. Não usar a versão 2.4.0 como recuperação padrão depois de
existirem transferências. Consulte também [operação local](../../OPERACAO_LOCAL.md#recuperação-compatível-após-a-primeira-transferência).

## Evidências visuais

Capturas da aplicação publicada, com dados fictícios identificados de staging.

![Formulário desktop com origem Parcial selecionada](desktop.png)

![Formulário no celular com origem Parcial selecionada](mobile.png)

## Continuação reservada ao responsável

Avaliar a preview e a revisão da PR. Somente após nova autorização: preparar
`line-transbordo`, registrar a versão estável, validar regras/índices `READY`,
revisar dry-run e contagens do backfill de produção, executar o backfill
idempotente, incorporar a PR, acompanhar Firebase App Hosting, realizar smoke
test sem fixtures e publicar `v2.5.0`. Nenhuma dessas ações de produção foi
executada nesta homologação.
