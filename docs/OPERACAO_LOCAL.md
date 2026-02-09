# Operacao Local - Controle Transbordo V1

## 1) Pre-requisitos

- Node.js 20+
- npm 10+
- Java instalado (`java -version`)

## 2) Setup inicial

```bash
cd /Users/mathrai/Desktop/transbordo_new
npm install
cp .env.example .env.local
```

Preencher `.env.local` com os dados do seu projeto Firebase.

## 3) Subir ambiente local

Terminal 1:

```bash
npx firebase emulators:start
```

Terminal 2:

```bash
npm run dev
```

URLs:
- app: `http://localhost:3000`
- emulator UI: `http://localhost:4000`

## 4) Fluxo de bootstrap de usuarios

1. Registrar usuario em `/register`
2. Capturar `uid` desse usuario
3. Promover para admin:

```bash
npm run promote-admin -- <uid>
```

4. Entrar no app com esse usuario
5. Aprovar/promover demais usuarios em `/users`

## 5) Rotina recomendada de validacao

- lint:

```bash
npm run lint
```

- testes:

```bash
npm test
```

- testes de integracao:

```bash
npm run test:integration
```

## 6) Troubleshooting rapido

## Erro `auth/network-request-failed`

Causa comum:
- emulador Auth parado
- `NEXT_PUBLIC_USE_FIREBASE_EMULATOR` incorreto
- hosts de emulador inconsistentes

Checklist:
1. confirmar `npx firebase emulators:start` ativo
2. revisar `.env.local`
3. reiniciar `npm run dev`

## Erro ao subir emulador pedindo Java

Instalar JRE/JDK e validar:

```bash
java -version
```

## Erro no `promote-admin` com `PERMISSION_DENIED`

Checklist:
1. confirmar `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080`
2. confirmar `FIREBASE_PROJECT_ID` no `.env.local`
3. garantir que o usuario ja existe em `users/{uid}`

## 7) Observacoes operacionais

- Nao comitar `.env.local`.
- Nao comitar logs locais (`firestore-debug.log` etc).
- Para cloud/producao, validar regras/indexes antes de liberar acesso operacional.
