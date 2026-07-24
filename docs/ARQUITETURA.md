# Arquitetura - Controle Transbordo V1

## Visao geral

A aplicacao usa Next.js com App Router e separa claramente:
- UI (paginas e componentes React)
- dominio (regras de negocio e validacoes)
- backend server-side (rotas `/api/*`)
- persistencia (Firestore via Admin SDK)

## Principios adotados

1. Toda escrita de dominio acontece no servidor.
2. Cliente nao escreve diretamente em colecoes sensiveis.
3. Regras de negocio ficam centralizadas em `src/lib/domain`.
4. Controle de acesso por papel e aprovacao.
5. Auditoria obrigatoria para edicoes de lancamentos.

## Camadas

## 1) UI (App Router)

- `src/app/(auth)`: login e registro
- `src/app/(app)`: area operacional protegida
- `src/app/display`: tela de TV protegida, sem `AppShell` e `SiteFooter`
- `src/components/*`: shell, guards e componentes de suporte

## 2) API Server-side

- `src/app/api/*`
- Autenticacao e autorizacao por `requireAuth`, `ensureApproved`, `ensureRole`
- Validacao de payload e regras de negocio antes de persistir

## 3) Dominio

- `src/lib/domain/validation.ts`: validacoes principais
- `src/lib/domain/time.ts`: regras de turno e janela
- `src/lib/domain/identifiers.ts`: normalizacao de placa/container
- `src/lib/domain/options.ts`: opcoes de enumeracoes para UI

## 4) Dados e infraestrutura

- `src/lib/firebase/client.ts`: SDK web
- `src/lib/firebase/admin.ts`: Admin SDK
- Firestore com colecoes: `users`, `clients`, `events`, `events/{id}/revisions` e `containerStates`
- `containerStates` materializa o ultimo evento operacional valido por container e usa versao para concorrencia otimista

## Seguranca e acesso

- Firestore Rules:
  - leitura permitida para usuario aprovado
  - escrita direta negada em `events`, `clients`, `revisions`
- APIs validam papel:
  - `OPERATOR`: operacao basica
  - `SUPERVISOR`: edicao/exclusao com limite de 24h
  - `DISPLAY`: acesso isolado ao resumo ao vivo
  - `ADMIN`: gestao completa

## Auditoria

Ao editar evento:
- grava diff de campos alterados
- armazena `before` e `after` apenas dos campos modificados
- registra ator (`editedByUid`, `editedByEmail`) e timestamp

## Ambiente local

- Firebase Emulator Suite (Auth + Firestore + UI)
- testes de integracao com `@firebase/rules-unit-testing`

## Limites da V1

Nao inclui:
- CSV
- relatorios
- integracoes externas
