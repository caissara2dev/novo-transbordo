# API HTTP - Controle Transbordo

Base local: `http://localhost:3000`

Todas as rotas exigem sessao autenticada (cookie Firebase) e retornam JSON.

## Convencoes

- Sucesso:
  - `{ "ok": true, ... }`
- Erro:
  - `{ "ok": false, "message": "..." }`
- Datas de Firestore sao serializadas para formato JSON consumivel no cliente.

## GET /api/me

Retorna perfil atual.

Resposta:
- `uid`
- `email`
- `profile` (`role`, `approved`, `active`, etc)
- `approvalContactPhone`

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
- `expectedContainerStateVersion`
- `notes` (ou `null`)

Validacoes relevantes:
- formato de horarios
- duracao (1..540 min)
- regras condicionais por categoria
- sobreposicao por bomba
- transicoes de ciclo e Blend somente para o mesmo cliente
- concorrencia otimista pelo estado atual do container

## PATCH /api/events/:id

Edita lancamento.

Permissao:
- `SUPERVISOR` (janela de 24h)
- `ADMIN` (sem limite)

Payload:
- mesmo formato do POST
- `revisionReason` opcional

Efeito colateral:
- grava item em `events/{id}/revisions` quando houver diff.
- recalcula o estado atual dos containers de origem e destino.

## GET /api/containers

Lista estados materializados. `scope=open` retorna Parcial, Pulmao e Blend parcial.
Aceita `query=<codigo>` e `status=<estado>`.

## GET /api/containers/lookup

Consulta o estado atual e as transicoes permitidas para `container=<codigo>`.

## GET /api/containers/history

Retorna o historico operacional valido para `container=<codigo>`, ordenado pelo horario operacional.

## DELETE /api/events/:id

Soft delete de lancamento.

Permissao:
- `SUPERVISOR` (24h)
- `ADMIN` (sem limite)

Payload:
- `{ "reason": "motivo obrigatorio" }`

## POST /api/events/:id/restore

Restaura lancamento deletado logicamente.

Permissao:
- somente `ADMIN`

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

## PATCH /api/clients/:id

Atualiza cliente.

Permissao:
- somente `ADMIN`

Payload:
- `{ "name"?: "...", "active"?: true|false }`

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

## POST /api/users/:uid/role

Altera role.

Permissao:
- somente `ADMIN`

Payload:
- `{ "role": "OPERATOR" | "SUPERVISOR" | "ADMIN" }`
