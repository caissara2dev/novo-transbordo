# API HTTP - Controle Transbordo

Base local: `http://localhost:3000`

As rotas autenticadas recebem o Firebase ID token em
`Authorization: Bearer <token>`. Quando App Check estiver habilitado, o cliente
também envia `X-Firebase-AppCheck`.

Falhas ao adquirir o token de App Check no navegador são encaminhadas sem esse
header para que o servidor aplique `APP_CHECK_MODE`. Defina
`NEXT_PUBLIC_APP_CHECK_FAIL_CLOSED=true` apenas quando o cliente também precisar
bloquear localmente a requisição.

## Convencoes

- Sucesso: `{ "ok": true, "data": <payload>, "meta"?: <metadados> }`
- Erro:
  - `{ "ok": false, "error": { "code": "...", "message": "...", "details"?: ... } }`
- Códigos de erro estáveis:
  - `VALIDATION_ERROR`
  - `UNAUTHENTICATED`
  - `EMAIL_UNVERIFIED`
  - `FORBIDDEN`
  - `NOT_FOUND`
  - `CONFLICT`
  - `RATE_LIMITED`
  - `INTERNAL_ERROR`
- Respostas `429` incluem `Retry-After` em segundos.
- Corpos JSON malformados, campos desconhecidos nos schemas estritos e tipos
  inválidos retornam `400 VALIDATION_ERROR`.
- `GET /api/reports/export` é a exceção ao envelope de sucesso e retorna o CSV
  diretamente. Seus erros continuam usando o envelope JSON.
- Datas de Firestore sao serializadas para formato JSON consumivel no cliente.

## GET /api/me

Retorna perfil atual.

Inclui `containerTransfersEnabled`, disponibilidade da flag de servidor. Ausente
ou falsa, a interface bloqueia transferências; a API também bloqueia mutações
que afetem suas linhas do tempo, preservando leitura e operações independentes.

`data`:
- `profile` (`email`, `role`, `approved`, `active`, etc.)
- `approvalContactPhone`

Contas `DISPLAY` podem acessar apenas autenticação, esta rota e
`GET /api/display/overview`. Todas as APIs operacionais retornam `403`.

Contas sem email verificado retornam `403 EMAIL_UNVERIFIED`.

## GET /api/display/overview

Retorna o resumo da data operacional atual para a tela de TV.

Permissao:
- `DISPLAY`
- `ADMIN`

`data`:
- `operationalDate`
- `generatedAt`
- `finalizedTotal`
- `averageProductiveMinutes`
- `openContainers` (`total`, `partial`, `buffer`, `blendPartial`)
- `clients[]` (`clientId`, `clientName`, `finalizedToday`, `openNow`)

## GET /api/events

Lista lancamentos com filtros.

Query params suportados:
- `dateFrom=YYYY-MM-DD`
- `dateTo=YYYY-MM-DD`
- `pump=BOMBA_1|BOMBA_2|BOMBA_3`
- `shiftType=MANHA|NOITE`
- `category=...`
- `clientId=<id>`
- `containerStatus=FULL|PARTIAL|BUFFER|BLEND_FULL|BLEND_PARTIAL`
- `includeDeleted=true|false`
- `limit=1..200` (padrão: `50`)
- `cursor=<cursor opaco retornado pela API>`

`data`:
- `items`
- `nextCursor`
- `incomplete` — `true` quando o teto seguro de documentos escaneados foi
  atingido; o cliente deve continuar usando `nextCursor`.

Regra de visibilidade:
- `OPERATOR`: apenas eventos proprios
- `SUPERVISOR/ADMIN`: visao global conforme filtros

## POST /api/events

Cria lancamento operacional.

Payload base:
- `pump`
- `shiftDate`
- `shiftType`
- `startTime`
- `endTime`
- `category`
- `clientId` (ou `null`)
- `plate` (ou `null`)
- `container` (ou `null`)
- `containerStatus` (ou `null`)
- `containerReason` (obrigatorio para Parcial, Pulmao e Blend parcial)
- `startsNewContainerCycle`
- `blendConfirmed`
- `expectedContainerStateVersion` (inteiro `>= 0` obrigatório em transferências;
  `0` confirma que a consulta não encontrou projeção do destino)
- `loadSourceType` (`TRUCK` ou `BUFFER_CONTAINER`; ausente em eventos legados
  equivale a `TRUCK`)
- `sourceContainer` (obrigatório somente para `BUFFER_CONTAINER`)
- `sourceContainerEmptied` (booleano obrigatório somente para
  `BUFFER_CONTAINER`)
- `expectedSourceContainerStateVersion` (inteiro `>= 0` obrigatório em
  `BUFFER_CONTAINER`; `null` fora desse fluxo)
- `expectedSourceContainerCycleId` (ciclo observado na seleção de origem; `null`
  fora de transferência. Clientes anteriores podem omitir: o servidor deriva o
  ciclo da projeção cuja versão foi confirmada, ou do vínculo histórico na edição.)
- `notes` (ou `null`)

O ciclo planejado para a transferência deve coincidir com o selecionado;
horário retroativo em outro ciclo retorna `409`. Atualizar a versão durante a
edição não substitui o ciclo histórico. O campo esperado é somente de controle
da requisição e não é persistido no evento.

Validacoes relevantes:
- formato de horarios
- duracao (1..540 min)
- regras condicionais por categoria
- sobreposicao por bomba
- transicoes de ciclo e Blend somente para o mesmo cliente
- transferência somente a partir de um container aberto como Pulmão ou Parcial
- origem e destino diferentes e pertencentes ao mesmo cliente
- concorrencia otimista pelos estados atuais da origem e do destino
- schema JSON estrito, incluindo justificativas de gaps; campos desconhecidos e
  tipos incorretos retornam `400 VALIDATION_ERROR`

Em uma transferência entre containers, a placa não é exigida. O destino segue
as transições usuais e a origem permanece `BUFFER` ou passa ao estado interno
terminal `TRANSFER_EMPTIED`, conforme `sourceContainerEmptied`. O lançamento e
as projeções dos dois containers são gravados atomicamente e o evento continua
sendo contado apenas uma vez como produtivo.

## PATCH /api/events/:id

Edita lancamento.

Permissao:
- `SUPERVISOR` (janela de 24h)
- `ADMIN` (sem limite)

Payload:
- mesmo formato do POST
- `revisionReason` opcional

O mesmo schema JSON estrito do `POST` é aplicado.

Efeito colateral:
- grava item em `events/{id}/revisions` quando houver diff.
- recalcula, na mesma transação, as linhas do tempo e os estados atuais dos
  containers de origem e destino.

## GET /api/containers

Lista estados materializados. `scope=open` retorna Parcial, Pulmao e Blend parcial.
Aceita `query=<codigo>`, `status=<estado>`, `limit=1..200` e
`cursor=<cursor opaco>`.

`data` contém `items`, `nextCursor` e `incomplete`.

`scope=transfer-source` retorna somente Pulmão (`BUFFER`) e Parcial (`PARTIAL`).
`excludeContainer=<codigo>` exclui o destino da busca. O cursor fica vinculado
ao escopo, à busca, ao estado e ao destino excluído. A seleção da origem deve ser
explícita e incluir sua versão observada; a busca não confirma automaticamente.

## GET /api/containers/lookup

Consulta o estado atual e as transicoes permitidas para `container=<codigo>`.

## GET /api/containers/history

Retorna o historico operacional valido para `container=<codigo>`, ordenado pelo
horario operacional. Em transferências, o mesmo evento pode ser retornado pela
perspectiva de ambos os containers com:

- `containerRole`: `DESTINATION` ou `SOURCE`;
- `relatedContainer`: origem quando consultado pelo destino, ou destino quando
  consultado pela origem;
- `status`: estado resultante naquela linha do tempo, inclusive o estado
  interno `TRANSFER_EMPTIED` para uma origem esvaziada.

Aceita `limit=1..200` (padrão 50) e `cursor=<cursor opaco>`. `data` contém `items`,
`nextCursor` e `incomplete` (verdadeiro quando uma passagem inconsistente não
pôde ser resolvida; a interface mostra um aviso sem descartar as demais). O cursor é vinculado ao
container, e a ordem decrescente é `endAt`, `createdAt`, ID. Os dois papéis usam
o mesmo cursor, sem duplicar a passagem. A visibilidade compartilhada para
perfis aprovados permanece igual à consulta de containers.

## DELETE /api/events/:id

Soft delete de lancamento.

Permissao:
- `SUPERVISOR` (24h)
- `ADMIN` (sem limite)

Payload:
- `{ "reason": "motivo obrigatorio", "gapVersion"?: "...", "gapJustifications"?: [...] }`

O objeto e cada justificativa são estritos.

## POST /api/events/:id/restore

Restaura lancamento deletado logicamente.

Permissao:
- somente `ADMIN`

Fluxo:
1. `GET /api/events/:id/restore` retorna em `data` a prévia atual,
   `gapVersion`, `expectedContainerStateVersion` e as reconciliações.
2. `POST /api/events/:id/restore` confirma essas versões e envia
   `gapJustificationsByEvent`.

Uma mudança concorrente retorna `409 CONFLICT` e exige uma nova prévia.

## GET /api/clients

Lista clientes.

Comportamento:
- usuario aprovado recebe clientes ativos
- admin pode usar `includeInactive=true` para listar todos

## POST /api/clients

Cria cliente.

Permissao:
- somente `ADMIN`

Payload:
- `{ "name": "..." }`

O objeto é estrito: campos adicionais e `name` com tipo diferente de string
retornam `400 VALIDATION_ERROR`.

## PATCH /api/clients/:id

Atualiza cliente.

Permissao:
- somente `ADMIN`

Payload:
- `{ "name"?: "...", "active"?: true|false }`

O objeto é estrito e não converte strings em booleanos.

## GET /api/users

Lista usuarios para aprovacao/gestao.

Permissao:
- somente `ADMIN`

## POST /api/users/:uid/approve

Aprova ou reprova usuario.

Permissao:
- somente `ADMIN`

Payload:
- `{ "approved": true|false }`

Somente booleanos JSON reais são aceitos; por exemplo, `"false"` é inválido.

## POST /api/users/:uid/role

Altera role.

Permissao:
- somente `ADMIN`

Payload:
- `{ "role": "OPERATOR" | "SUPERVISOR" | "DISPLAY" | "ADMIN" }`

## POST /api/auth/sync

Cria o perfil de uma conta Firebase verificada, quando ainda não existe.

Payload opcional:
- `{ "name"?: string|null }`

O corpo vazio é aceito. JSON malformado, campos desconhecidos e tipos inválidos
retornam `400 VALIDATION_ERROR`.

## GET e PATCH /api/settings/operations

Permissão:
- somente `ADMIN`

O `PATCH` aceita exclusivamente:
- `{ "idleToleranceMinutes": <inteiro entre 0 e 60> }`
