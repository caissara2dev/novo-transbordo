# Controle Transbordo - V1 (Nucleo Operacional)

Aplicacao web para operacao de transbordo com foco em controle operacional, governanca de acesso e rastreabilidade de alteracoes.

Stack principal:
- Next.js (App Router) + TypeScript
- Firebase Auth (email/senha)
- Firestore
- Firebase Emulator Suite para ambiente local

## Objetivo da V1

Entregar o nucleo operacional completo:
- cadastro e login
- aprovacao manual de usuarios
- controle de papeis (`OPERATOR`, `SUPERVISOR`, `ADMIN`)
- lancamentos com validacoes de negocio
- auditoria de edicao
- exclusao logica com restauracao
- gestao de clientes e usuarios por Admin

Fora de escopo da V1:
- exportacao CSV
- relatorios/graficos
- integracoes externas
- modo offline

## Requisitos

- Node.js 20+
- npm 10+
- Java (necessario para Firestore Emulator)

## Setup rapido

1. Instalar dependencias:

```bash
npm install
```

2. Criar arquivo de ambiente:

```bash
cp .env.example .env.local
```

3. Preencher as variaveis do Firebase em `.env.local`.

4. Subir emuladores:

```bash
npx firebase emulators:start
```

5. Em outro terminal, subir app:

```bash
npm run dev
```

App local: `http://localhost:3000`  
Emulator UI: `http://localhost:4000`

## Variaveis de ambiente

Veja `.env.example`.

Grupos principais:
- `NEXT_PUBLIC_FIREBASE_*`: SDK web (cliente)
- `FIREBASE_*`: Admin SDK (server-side)
- `APPROVAL_CONTACT_PHONE`: contato exibido para usuario pendente
- `*_EMULATOR_HOST`: roteamento para emuladores locais

Observacao importante para cloud:
- `FIREBASE_PRIVATE_KEY` deve manter `\n` escapado no `.env.local`.

## Fluxo inicial de acesso (primeiro admin)

1. Registrar usuario em `/register`.
2. Usuario entra como `approved=false`.
3. Promover primeiro admin:

```bash
npm run promote-admin -- <uid>
```

4. Entrar com esse admin e aprovar/promover usuarios em `/users`.

## Scripts

- `npm run dev`: ambiente de desenvolvimento
- `npm run build`: build de producao
- `npm run start`: executa build em producao
- `npm run lint`: lint
- `npm test`: suite completa (Vitest)
- `npm run test:integration`: testes de integracao
- `npm run promote-admin -- <uid>`: bootstrap do primeiro admin

## Estrutura principal

```text
src/app/(auth)           # login/registro
src/app/(app)            # dashboard, lancamentos, clientes, usuarios
src/app/api              # APIs server-side
src/lib/domain           # regras de negocio e validacoes
src/lib/server           # camada server de auth, filtros, servicos
src/lib/firebase         # inicializacao Firebase client/admin
src/types                # contratos TypeScript
tests                    # unitarios e integracao
```

## APIs da V1

Resumo:
- `GET /api/me`
- `GET/POST /api/events`
- `PATCH/DELETE /api/events/:id`
- `POST /api/events/:id/restore`
- `GET/POST /api/clients`
- `PATCH /api/clients/:id`
- `GET /api/users`
- `POST /api/users/:uid/approve`
- `POST /api/users/:uid/role`

Detalhes completos em `docs/API.md`.

## Qualidade e seguranca

- Escritas de dominio passam por rotas server-side.
- Firestore Rules bloqueiam escrita direta do cliente em `events`, `clients` e `revisions`.
- Edicoes de lancamento geram trilha de revisao com diff de campos alterados.
- Exclusao e restauracao sao logicas (sem hard delete).

## Operacao local e troubleshooting

Guia operacional:
- `docs/OPERACAO_LOCAL.md`

Problemas comuns:
- `auth/network-request-failed`: app nao alcança Auth (emulador parado ou config incorreta).
- erro de Java ao iniciar emulador: instalar JRE/JDK e validar `java -version`.
- `gh auth status` invalido: refazer login via `gh auth login`.

## Documentacao tecnica adicional

- Arquitetura: `docs/ARQUITETURA.md`
- API: `docs/API.md`
- Operacao local: `docs/OPERACAO_LOCAL.md`
