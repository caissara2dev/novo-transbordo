# Arquitetura — Controle Transbordo

## Visão geral

A aplicação usa Next.js App Router e concentra as decisões operacionais no
servidor. O navegador autentica com Firebase Auth, obtém App Check quando
configurado e consome exclusivamente as rotas `/api/*` para acessar dados de
domínio.

```text
React / Firebase Auth / App Check
              |
              v
        Next.js API routes
              |
       proteção da requisição
              |
       autorização + domínio
              |
              v
      Firebase Admin / Firestore
```

## Princípios

1. Escritas e leituras sensíveis acontecem pelo servidor.
2. Toda API autenticada exige token Firebase com email verificado.
3. Aprovação, ativação e papel são autorizados a partir de `users/{uid}`.
4. Regras determinísticas ficam em `src/lib/domain`; infraestrutura não define
   regra operacional.
5. Mutações relacionadas usam transações e locks de versão.
6. Auditoria e projeções são atualizadas no mesmo fluxo da mutação.
7. Entradas externas são validadas nos adaptadores HTTP.
8. Erros públicos têm envelope e códigos estáveis; detalhes internos ficam nos
   logs do servidor.

## Camadas

### UI

- `src/app/(auth)`: cadastro, verificação de email e login.
- `src/app/(app)`: operação, contêineres, relatórios, clientes, usuários e
  configurações.
- `src/app/display`: tela independente para TV.
- `src/components`: shell, guards e componentes compartilhados.
- `src/lib/ui`: coordenação reutilizável de estado e requisições.

Os filtros possuem estado de edição e estado aplicado. Requisições substituídas
são canceladas ou ignoradas para impedir que uma resposta antiga sobrescreva a
seleção mais recente.

### API server-side

- `src/app/api/*`: tradução HTTP, schemas e envelope de resposta.
- `src/lib/server/auth.ts`: identidade, email verificado, perfil e papéis.
- `src/lib/server/request-protection.ts`: App Check, proxy confiável e seleção
  de política de rate limiting.
- `src/lib/server/*`: casos de uso, repositórios Firestore, relatórios e
  paginação.

O contrato HTTP comum é:

```json
{ "ok": true, "data": {}, "meta": {} }
```

ou:

```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Mensagem segura para o usuário."
  }
}
```

Consulte `docs/API.md` para endpoints e payloads.

### Domínio

- `validation.ts`: validações principais.
- `time.ts`: turnos e janelas.
- `identifiers.ts`: normalização de placas e contêineres.
- `event-order.ts`: ordenação operacional.
- `container-timeline.ts`: transições e reconstrução da cadeia de contêiner.

Eventos são a fonte de verdade. `containerStates` é uma projeção do último
estado operacional válido e não substitui a reexecução da linha do tempo ao
validar eventos retroativos.

### Dados

Coleções principais:

- `users`
- `clients`
- `events`
- `events/{eventId}/revisions`
- `containerStates`
- documentos internos de versão/lock da linha do tempo
- `_requestRateLimits`

O cliente não escreve diretamente em coleções sensíveis. Firestore Rules
aplicam defesa em profundidade; o Admin SDK continua responsável pela
autorização de aplicação.

Listagens usam filtros Firestore e paginação por cursor antes de impor limites.
Não é permitido buscar um lote arbitrário e aplicar visibilidade ou filtros
somente em memória.

## Identidade e autorização

### Cadastro

1. Firebase Auth cria a conta.
2. A aplicação envia o link de verificação e encerra a sessão.
3. No próximo login, conta não verificada recebe um novo link e continua sem
   acesso.
4. `/api/auth/sync` cria/sincroniza `users/{uid}` somente quando
   `email_verified=true`.
5. O usuário verificado aguarda aprovação administrativa.

Todas as APIs autenticadas repetem a verificação no token decodificado. A
checagem do frontend é apenas experiência de usuário, não controle de acesso.

### Papéis

- `OPERATOR`: operação básica e somente eventos próprios; recebe apenas o
  resumo mínimo necessário de estado de contêiner.
- `SUPERVISOR`: visão global e mutações permitidas pelas janelas operacionais.
- `DISPLAY`: somente perfil e resumo do display.
- `ADMIN`: gestão, restauração e configuração.

## Proteção de requisições

### App Check

O cliente inicializa reCAPTCHA Enterprise somente quando
`NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY` existe e envia
`X-Firebase-AppCheck`. A aquisição do token é best-effort por padrão para que o
servidor continue responsável pela política `observe`/`enforce`;
`NEXT_PUBLIC_APP_CHECK_FAIL_CLOSED=true` antecipa a falha no navegador e só deve
ser habilitado depois do rollout. O servidor:

1. lê `APP_CHECK_MODE`;
2. verifica o token pelo Firebase Admin;
3. confere o `appId` em `APP_CHECK_ALLOWED_APP_IDS`;
4. observa ou bloqueia conforme o modo.

Modos válidos:

- `off`: somente desenvolvimento/emulador;
- `observe`: registra ausência/invalidade sem bloquear;
- `enforce`: falha fechada.

### Rate limiting

Políticas:

| Grupo | Limite | Identidade |
| --- | ---: | --- |
| autenticação | 10/min | IP confiável |
| leitura | 120/min | UID |
| escrita | 30/min | UID |
| administração | 10/min | UID |

O IP só é considerado de acordo com `TRUSTED_PROXY_MODE`: `google-lb` no
Firebase App Hosting, `vercel` nos previews e `local` somente fora de produção.

Cada bucket usa token bucket transacional. O identificador do documento é HMAC
de versão, política e identidade; IP e UID não são persistidos em texto. A
coleção `_requestRateLimits` grava `expiresAt` para remoção automática após 24
horas. `RATE_LIMIT_HMAC_SECRET` tem no mínimo 32 caracteres e fica no Secret
Manager; `RATE_LIMIT_KEY_VERSION` permite rotação sem colisão com buckets
antigos.

## Consistência operacional

- Cada bomba/turno possui versão de linha do tempo.
- Criação, edição, exclusão e restauração verificam as versões observadas.
- Alterar um evento reconcilia gaps e sucessores afetados.
- Eventos retroativos são avaliados na ordem operacional completa.
- Transições de contêiner e invariantes de Blend são revalidadas na cadeia
  afetada.
- Evento, revisão, gap, lock e projeção não podem ficar parcialmente
  atualizados.

Relatórios tratam eventos legados com fallback de produtividade, ordenam por
timestamps completos e protegem exportações CSV contra interpretação de
fórmulas.

## Ambientes e rollout

| Ambiente | Projeto | Proxy | Proteções |
| --- | --- | --- | --- |
| local/testes | `demo-transbordo*` | `local` | `off` com emuladores |
| preview | `line-transbordo-staging-382612` | `vercel` | `observe` antes de `enforce` |
| produção | `line-transbordo` | `google-lb` | `observe` antes de `enforce` |

O `apphosting.yaml` mantém App Check e rate limiting em `observe`. A mudança para
`enforce` só acontece depois de:

1. configurar o site key real;
2. criar e autorizar o segredo HMAC;
3. ativar o TTL;
4. publicar regras e índices;
5. executar smoke tests em staging;
6. observar logs e métricas sem falsos positivos.

O procedimento, os critérios de enforcement e o rollback estão em
`docs/OPERACAO_LOCAL.md`.

## Verificação

`npm run verify` executa, em Node.js 22:

- ESLint sem warnings;
- TypeScript;
- Vitest com cobertura mínima de 80%;
- testes de Firestore Rules no Emulator;
- Playwright E2E;
- build de produção;
- `npm audit` de dependências de produção no nível high.

Testes unitários cobrem regras puras; integração cobre adaptadores, serviços e
emuladores; E2E cobre os fluxos críticos vistos pelo usuário.
