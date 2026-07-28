# Controle Transbordo

Aplicação web para controle operacional de transbordo, com governança de acesso,
linha do tempo por bomba/turno, ciclo de contêineres, auditoria, display e
relatórios.

## Stack

- Next.js App Router + TypeScript
- Firebase Auth, App Check e Firestore
- Firebase App Hosting em produção
- Firebase Emulator Suite no desenvolvimento e nos testes de regras
- Vitest, Playwright e Recharts

## Funcionalidades

- Perfis `OPERATOR`, `SUPERVISOR`, `DISPLAY` e `ADMIN`
- Verificação de email e aprovação administrativa antes do acesso operacional
- Lançamentos com validações de sobreposição, gaps e concorrência
- Operação independente das Bombas 1, 2 e 3
- Ciclo de contêineres Cheio, Parcial, Pulmão e Blend
- Edição, soft delete, restauração, revisões e trilha de auditoria
- Gestão de clientes, usuários e configurações
- Relatórios com KPIs, gráficos, drilldown e exportação CSV
- Display operacional para TVs 16:9

## Requisitos

- Node.js 22.x
- npm 10 ou 11
- Java 21 recomendado para o Firestore Emulator

O repositório inclui `.nvmrc`; execute `nvm use` antes de instalar dependências.

## Setup local

```bash
nvm use
npm ci
cp .env.example .env.local
```

Preencha os valores Firebase em `.env.local`. Para desenvolvimento com
emuladores, mantenha:

```dotenv
APP_CHECK_MODE=off
RATE_LIMIT_MODE=off
TRUSTED_PROXY_MODE=local
NEXT_PUBLIC_USE_FIREBASE_EMULATOR=true
```

Em dois terminais:

```bash
npx firebase emulators:start --project demo-transbordo
```

```bash
npm run dev
```

- Aplicação: `http://localhost:3000`
- Emulator UI: `http://localhost:4000`

Consulte [docs/OPERACAO_LOCAL.md](docs/OPERACAO_LOCAL.md) para o procedimento
completo.

## Cadastro e primeiro administrador

1. Registre a conta em `/register`.
2. Abra o link enviado por email; o cadastro encerra a sessão até a verificação.
3. Entre novamente. O perfil só é sincronizado depois que o token informa
   `email_verified=true`.
4. Consulte o UID na tela Authentication do Firebase Console ou Emulator UI.
5. Simule a promoção:

```bash
npm run promote-admin -- <uid> --project=demo-transbordo --dry-run
```

6. Confirme explicitamente o projeto para executar:

```bash
npm run promote-admin -- <uid> --project=demo-transbordo \
  --execute --confirm-project=demo-transbordo
```

O script é dry-run por padrão, nunca infere o projeto e exige confirmações
adicionais para produção. Veja o comando completo em
[docs/OPERACAO_LOCAL.md](docs/OPERACAO_LOCAL.md#bootstrap-e-promoção-de-administrador).

## Variáveis de ambiente

Veja `.env.example`. As variáveis de proteção são:

| Variável | Uso |
| --- | --- |
| `NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY` | Site key pública do reCAPTCHA Enterprise; é incorporada no build |
| `NEXT_PUBLIC_APP_CHECK_FAIL_CLOSED` | Se `true`, o navegador não envia a requisição quando não consegue obter App Check; mantenha `false` durante `observe` |
| `APP_CHECK_MODE` | `off`, `observe` ou `enforce` |
| `APP_CHECK_ALLOWED_APP_IDS` | App IDs Firebase permitidos, separados por vírgula |
| `RATE_LIMIT_MODE` | `off`, `observe` ou `enforce` |
| `RATE_LIMIT_HMAC_SECRET` | Segredo de pelo menos 32 caracteres, somente no servidor |
| `RATE_LIMIT_KEY_VERSION` | Versão lógica usada na rotação da chave HMAC |
| `TRUSTED_PROXY_MODE` | `local`, `vercel` ou `google-lb` |

Produção usa `observe` inicialmente e `TRUSTED_PROXY_MODE=google-lb`. Previews
Vercel devem usar `TRUSTED_PROXY_MODE=vercel`. `off` é destinado somente a
ambientes locais/emulados; em produção, a aplicação falha fechada.

Não registre em arquivo o site key real antes de ele existir e nunca registre o
valor de `RATE_LIMIT_HMAC_SECRET`.

## Qualidade

```bash
npm run lint
npm run typecheck
npm test
npm run test:coverage
npm run test:rules
npm run test:e2e
npm run build
npm run audit:prod
```

`npm run verify` executa lint, tipos, cobertura mínima de 80%, regras, E2E,
build e auditoria de dependências de produção. O CI usa Node.js 22 e Java 21.

## Scripts operacionais

### Promoção de administrador

```bash
npm run promote-admin -- --help
```

- dry-run é o padrão;
- `--project` é obrigatório;
- a execução exige `--execute` e `--confirm-project`;
- produção exige também `--allow-production` e a confirmação apresentada pelo
  próprio `--help`.

### Cópia anonimizada para staging

A simulação lê contagens dos dois projetos, mas não grava dados:

```bash
npm run copy:staging -- --dry-run
```

Para executar, carregue uma chave HMAC de pelo menos 32 caracteres sem colocá-la
na linha de comando ou no repositório:

```bash
read -s COPY_ANONYMIZATION_KEY
export COPY_ANONYMIZATION_KEY
npm run copy:staging -- --execute \
  --confirm-target=line-transbordo-staging-382612
unset COPY_ANONYMIZATION_KEY
```

O utilitário aceita somente a origem `line-transbordo` e o destino
`line-transbordo-staging-382612`, recusa um destino já populado, copia apenas
`clients`, `events` e revisões e pseudonimiza IDs, emails, placas, contêineres e
texto livre. `users` e Firebase Auth nunca são copiados. Cada documento recebe
`expiresAt` para retenção de sete dias; as políticas TTL do staging devem estar
ativas conforme [docs/OPERACAO_LOCAL.md](docs/OPERACAO_LOCAL.md#cópia-anonimizada-para-staging).

## Deploy

O gate obrigatório é: manifesto válido → dry-run → deploy dos índices → status
`Ready` no Firebase → deploy da aplicação. Para staging:

```bash
npm run verify:firestore-indexes
npx firebase deploy --only firestore:indexes \
  --project line-transbordo-staging-382612 --dry-run
npx firebase deploy --only firestore:indexes \
  --project line-transbordo-staging-382612
```

Só depois que todos os índices estiverem prontos publique ou valide o preview
Vercel. Para produção, repita a mesma ordem antes da aplicação:

```bash
npm run verify:firestore-indexes
npx firebase deploy --only firestore:rules,firestore:indexes \
  --project line-transbordo --dry-run
npx firebase deploy --only firestore:rules,firestore:indexes \
  --project line-transbordo
```

A produção em `linebot.com.br` é publicada pelo Firebase App Hosting após merge
em `main`. Branches de trabalho usam Vercel com o projeto Firebase
`line-transbordo-staging-382612`.

App Check e rate limiting seguem rollout `observe` → smoke test/monitoramento →
`enforce`. Não altere ambos para enforcement ao mesmo tempo. A criação do
segredo, o TTL de `_requestRateLimits.expiresAt`, o smoke test e o rollback
estão detalhados em [docs/OPERACAO_LOCAL.md](docs/OPERACAO_LOCAL.md#rollout-de-app-check-e-rate-limiting).

## Estrutura

```text
src/app/(auth)       # login e registro
src/app/(app)        # área operacional
src/app/api          # adaptadores HTTP server-side
src/lib/domain       # regras determinísticas de negócio
src/lib/server       # aplicação, persistência e proteção de requisições
src/lib/firebase     # Firebase cliente/Admin
src/types            # contratos TypeScript
tests                # unitários, integração, regras, cobertura e E2E
```

## Documentação e governança

- [Como contribuir, gates e fluxo de release](CONTRIBUTING.md)
- [Histórico de versões](CHANGELOG.md)
- [Arquitetura](docs/ARQUITETURA.md)
- [Contratos HTTP](docs/API.md)
- [Operação local, deploy e rollback](docs/OPERACAO_LOCAL.md)
- [Uso do GitHub Issues](docs/agents/issue-tracker.md)
- [Labels de triagem](docs/agents/triage-labels.md)
- [Issues](https://github.com/caissara2dev/novo-transbordo/issues),
  [milestones](https://github.com/caissara2dev/novo-transbordo/milestones) e
  [pull requests](https://github.com/caissara2dev/novo-transbordo/pulls)
