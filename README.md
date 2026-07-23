# Controle Transbordo (V1 + V2)

Aplicacao web para controle operacional de transbordo, com governanca de acesso, trilha de auditoria e analise operacional.

## Stack

- Next.js (App Router) + TypeScript
- Firebase Auth (email/senha)
- Firestore
- Firebase Emulator Suite (desenvolvimento local)
- Recharts (dashboard de relatorios)

## Escopo entregue

### V1 - Nucleo operacional

- Cadastro/login e aprovacao manual de usuarios
- Perfis: `OPERATOR`, `SUPERVISOR`, `ADMIN`
- Lancamentos com validacoes de negocio
- Bloqueio de sobreposicao por bomba
- Operação independente das Bombas 1, 2 e 3
- Ciclo de containers Cheio, Parcial, Pulmão e Blend
- Edicao com auditoria e revisoes
- Soft delete com motivo e restauracao (Admin)
- Gestao de clientes e usuarios (Admin)

### V2 - Relatorios profissionais

- Tela `/reports` para `SUPERVISOR` e `ADMIN`
- Filtros globais com presets de periodo
- KPIs com comparacao vs periodo anterior
- Graficos operacionais (produtivo/ocioso, tendencia, turno, ranking)
- Drilldown em tabela na mesma pagina
- Exportacao CSV detalhado e agregado

## Requisitos

- Node.js 20+
- npm 10+
- Java (necessario para Firestore Emulator)

## Setup local rapido

1. Instale dependencias:

```bash
npm install
```

2. Crie o arquivo de ambiente:

```bash
cp .env.example .env.local
```

3. Preencha variaveis do Firebase em `.env.local`.

4. Suba os emuladores (terminal 1):

```bash
npx firebase emulators:start --project demo-transbordo
```

5. Suba o app (terminal 2):

```bash
npm run dev
```

URLs locais:
- App: `http://localhost:3000`
- Emulator UI: `http://localhost:4000`

## Variaveis de ambiente

Veja `.env.example`.

Grupos principais:
- `NEXT_PUBLIC_FIREBASE_*`: SDK cliente
- `FIREBASE_*`: Admin SDK no server
- `APPROVAL_CONTACT_PHONE`: contato exibido em conta pendente
- `*_EMULATOR_HOST`: roteamento para emuladores locais

Observacao:
- Em cloud, manter `FIREBASE_PRIVATE_KEY` com `\n` escapado.

## Primeiro admin (bootstrap)

1. Registre um usuario em `/register`
2. Pegue o `uid`
3. Promova para admin:

```bash
npm run promote-admin -- <uid>
```

4. Entre com esse usuario e aprove/promova os demais em `/users`.

## Scripts

- `npm run dev`: desenvolvimento
- `npm run build`: build de producao
- `npm run start`: start em producao
- `npm run lint`: lint
- `npm test`: testes unitarios
- `npm run test:integration`: testes de integracao
- `npm run backfill:container-states -- --project=<projeto> --dry-run`: simular materialização de estados
- `npm run promote-admin -- <uid>`: promover admin no ambiente local

## Estrutura principal

```text
src/app/(auth)           # login/registro
src/app/(app)            # dashboard, events, reports, clients, users
src/app/api              # APIs server-side
src/lib/domain           # validacoes e regras de negocio
src/lib/server           # servicos de dominio (events, reports, etc)
src/lib/firebase         # inicializacao Firebase client/admin
src/types                # contratos TypeScript
tests                    # unitarios e integracao
```

## APIs principais

- `GET /api/me`
- `GET/POST /api/events`
- `PATCH/DELETE /api/events/:id`
- `POST /api/events/:id/restore`
- `GET /api/containers`
- `GET /api/containers/lookup`
- `GET /api/containers/history`
- `GET/POST /api/clients`
- `PATCH /api/clients/:id`
- `GET /api/users`
- `POST /api/users/:uid/approve`
- `POST /api/users/:uid/role`
- `GET /api/reports/overview`
- `GET /api/reports/drilldown`
- `GET /api/reports/export`

## Qualidade e seguranca

- Escritas de dominio passam por rotas server-side
- Perfis de usuario nao aceitam criacao ou alteracao direta pelo cliente
- Firestore Rules restritivas para proteger colecoes sensiveis
- Revisoes de lancamentos com diff de campos alterados
- Soft delete/restauracao (sem hard delete operacional)

Validacao das regras no Firestore Emulator:

```bash
npm run test:rules
```

## Deploy (Firebase)

- Firestore rules/indexes:

```bash
npx firebase deploy --only firestore:rules,firestore:indexes --project line-transbordo
```

- App Hosting:
  - Produção em `linebot.com.br`.
  - Build/deploy disparado por merge na branch `main` conectada ao backend no Firebase.

## Previews (Vercel + Firebase staging)

- A Vercel publica somente branches de trabalho (`feat/*`, `fix/*` e `chore/*`).
- A branch `main` não é publicada pela Vercel; ela pertence ao Firebase App Hosting.
- Todos os previews usam exclusivamente o projeto `line-transbordo-staging-382612`.
- Variáveis `FIREBASE_CLIENT_EMAIL` e `FIREBASE_PRIVATE_KEY` ficam somente nos segredos da Vercel.
- `NEXT_PUBLIC_APP_ENV=staging` exibe um aviso visível no topo da aplicação.

Para conferir a cópia inicial sem alterar dados:

```bash
npm run copy:staging -- --dry-run
```

Para executar, é exigida confirmação explícita do destino:

```bash
npm run copy:staging -- --execute --confirm-target=line-transbordo-staging-382612
```

O utilitário copia `clients`, `events` e revisões. Perfis em `users` e contas do Firebase Auth nunca são copiados.

## Documentacao complementar

- `docs/ARQUITETURA.md`
- `docs/API.md`
- `docs/OPERACAO_LOCAL.md`
