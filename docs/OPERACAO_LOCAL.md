# Operação local, rollout e rollback

## Pré-requisitos

- Node.js 22.x
- npm 10 ou 11
- Java 21 recomendado
- Firebase CLI instalada nas dependências do projeto
- Google Cloud CLI para configurar políticas TTL

```bash
node --version
npm --version
java -version
npx firebase --version
gcloud --version
```

Use o caminho atual do clone; não copie caminhos absolutos de outra máquina.

## Setup

```bash
nvm use
npm ci
cp .env.example .env.local
```

Preencha as configurações Firebase. Para emuladores:

```dotenv
NEXT_PUBLIC_APP_ENV=development
APP_CHECK_MODE=off
APP_CHECK_ALLOWED_APP_IDS=
RATE_LIMIT_MODE=off
RATE_LIMIT_HMAC_SECRET=
RATE_LIMIT_KEY_VERSION=v1
TRUSTED_PROXY_MODE=local
NEXT_PUBLIC_USE_FIREBASE_EMULATOR=true
NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
```

`APP_CHECK_MODE=off`, `RATE_LIMIT_MODE=off` e `TRUSTED_PROXY_MODE=local` não
devem ser usados em produção. O servidor recusa configuração `off` em produção
fora dos emuladores.

## Execução local

Terminal 1:

```bash
npx firebase emulators:start --project demo-transbordo
```

Terminal 2:

```bash
npm run dev
```

- Aplicação: `http://localhost:3000`
- Emulator UI: `http://localhost:4000`

## Cadastro, verificação e aprovação

O acesso possui duas barreiras independentes:

1. `email_verified=true` no token do Firebase Auth;
2. `approved=true` e `active=true` em `users/{uid}`.

Fluxo:

1. A pessoa cria a conta em `/register`.
2. A aplicação envia o email de verificação e encerra a sessão.
3. A pessoa abre o link e entra novamente.
4. Somente então `/api/auth/sync` cria ou atualiza o perfil.
5. Até a aprovação por um admin, a conta permanece pendente.

Se uma conta não verificada tentar entrar, a aplicação reenvia o link e encerra
a sessão. As APIs também validam o claim; manipular o estado do cliente não
remove a barreira.

### Bootstrap e promoção de administrador

Consulte as opções exatas:

```bash
npm run promote-admin -- --help
```

O script é dry-run por padrão e sempre exige `--project`. Primeiro registre,
verifique e entre com a conta para que `users/{uid}` exista.

Emulador:

```bash
npm run promote-admin -- <uid> --project=demo-transbordo --dry-run
npm run promote-admin -- <uid> --project=demo-transbordo \
  --execute --confirm-project=demo-transbordo
```

Staging, com Application Default Credentials:

```bash
npm run promote-admin -- <uid> \
  --project=line-transbordo-staging-382612 --dry-run
npm run promote-admin -- <uid> \
  --project=line-transbordo-staging-382612 \
  --execute --confirm-project=line-transbordo-staging-382612
```

Produção possui duas confirmações extras:

```bash
npm run promote-admin -- <uid> --project=line-transbordo --dry-run
npm run promote-admin -- <uid> --project=line-transbordo \
  --execute --confirm-project=line-transbordo \
  --allow-production \
  --confirm-production=PROMOTE_ADMIN_IN_PRODUCTION
```

Antes de executar, confira no JSON do dry-run: projeto, UID, papel atual e patch
pretendido. O script nunca infere o projeto e nunca promove uma conta
inexistente.

## Verificação de qualidade

Comandos individuais:

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

Verificação completa:

```bash
npm run verify
```

Critérios:

- ESLint sem warnings;
- TypeScript sem erro;
- testes unitários e de integração aprovados;
- cobertura de branches, funções, linhas e statements igual ou superior a 80%;
- Firestore Rules aprovadas no Emulator;
- fluxos E2E aprovados no Chromium;
- build de produção aprovado;
- nenhuma vulnerabilidade `high` ou `critical` em dependências de produção.

Os artefatos do Playwright ficam em `tmp/playwright*`; o relatório de cobertura
fica em `coverage/`.

## Variáveis de proteção por ambiente

| Variável | Local | Preview Vercel | App Hosting |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY` | vazia | site key do staging | site key real de produção |
| `NEXT_PUBLIC_APP_CHECK_FAIL_CLOSED` | `false` | `false` durante `observe` | `false` durante `observe` |
| `APP_CHECK_MODE` | `off` | `observe` → `enforce` | `observe` → `enforce` |
| `APP_CHECK_ALLOWED_APP_IDS` | vazia | App ID do staging | App ID de produção |
| `RATE_LIMIT_MODE` | `off` | `observe` → `enforce` | `observe` → `enforce` |
| `RATE_LIMIT_HMAC_SECRET` | vazia | segredo do staging | Secret Manager |
| `RATE_LIMIT_KEY_VERSION` | `v1` | versão ativa | versão ativa |
| `TRUSTED_PROXY_MODE` | `local` | `vercel` | `google-lb` |

`NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY` é pública e incorporada durante o
build. Alterá-la exige novo build. `RATE_LIMIT_HMAC_SECRET` é privada, deve ter
pelo menos 32 caracteres e nunca pode usar prefixo `NEXT_PUBLIC_`.

O `apphosting.yaml` mantém:

- `APP_CHECK_MODE=observe`;
- `RATE_LIMIT_MODE=observe`;
- `TRUSTED_PROXY_MODE=google-lb`;
- `APP_CHECK_ALLOWED_APP_IDS` igual ao App ID web público já configurado;
- `NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY` com a site key pública registrada
  no App Check de produção;
- `RATE_LIMIT_KEY_VERSION=v1`;
- referência ao segredo `RATE_LIMIT_HMAC_SECRET`, sem o valor.

A site key do reCAPTCHA Enterprise é pública e fica disponível em `BUILD` e
`RUNTIME`. Qualquer rotação exige atualizar o registro do App Check, revisar os
domínios permitidos e gerar um novo build. Nunca publique um placeholder.

## Rollout de App Check e rate limiting

### 1. Preparar staging

1. No Firebase Console, registre o web app de staging em App Check com o
   provedor reCAPTCHA Enterprise.
2. Configure o site key público real como
   `NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY`.
3. Configure o App ID de staging em `APP_CHECK_ALLOWED_APP_IDS`.
4. Configure `TRUSTED_PROXY_MODE=vercel`.
5. Mantenha `APP_CHECK_MODE=observe` e `RATE_LIMIT_MODE=observe`.
6. Crie uma chave HMAC diferente da produção e mantenha-a nos secrets da
   plataforma.
7. Refaça o build do preview.

### 2. Criar o segredo de produção

O Firebase CLI local confirma que `apphosting:secrets:set` cria ou atualiza um
segredo do App Hosting. Execute interativamente; não informe o valor na linha de
comando, em arquivo versionado ou nesta documentação:

```bash
npx firebase apphosting:secrets:set RATE_LIMIT_HMAC_SECRET \
  --project line-transbordo
```

Confirme que o backend do App Hosting possui acesso ao segredo. O
`apphosting.yaml` já referencia `RATE_LIMIT_HMAC_SECRET`.

Para rotacionar:

1. crie uma nova versão do segredo;
2. incremente `RATE_LIMIT_KEY_VERSION`, por exemplo de `v1` para `v2`;
3. publique em `observe`;
4. valide os novos buckets;
5. retorne ao modo anterior de enforcement.

Nunca reutilize a chave de staging em produção.

### 3. Ativar TTL

Os buckets escrevem `expiresAt` 24 horas à frente. Ative o TTL no projeto de
produção:

```bash
gcloud firestore fields ttls update expiresAt \
  --collection-group=_requestRateLimits \
  --database='(default)' \
  --enable-ttl \
  --project=line-transbordo
```

Repita no staging:

```bash
gcloud firestore fields ttls update expiresAt \
  --collection-group=_requestRateLimits \
  --database='(default)' \
  --enable-ttl \
  --project=line-transbordo-staging-382612
```

TTL é assíncrono: documentos expirados podem permanecer visíveis por algum
tempo. Não use a remoção física como decisão de autorização.

### 4. Publicar regras e índices

Este é um gate de lançamento: não publique a aplicação enquanto o manifesto
falhar, o dry-run apontar problemas ou algum índice estiver em construção.
Valide o manifesto, faça o dry-run e revise o diff antes do deploy:

```bash
npm run verify:firestore-indexes
npx firebase deploy --only firestore:rules,firestore:indexes \
  --project line-transbordo-staging-382612 --dry-run
npx firebase deploy --only firestore:rules,firestore:indexes \
  --project line-transbordo-staging-382612
```

Depois do smoke test em staging:

```bash
npx firebase deploy --only firestore:rules,firestore:indexes \
  --project line-transbordo --dry-run
npx firebase deploy --only firestore:rules,firestore:indexes \
  --project line-transbordo
```

Índices podem levar alguns minutos para ficar prontos. Não publique a aplicação
dependente enquanto o Firebase Console indicar construção. O deploy deve ser
aditivo: não use `--force` e não confirme a remoção de índices remotos durante
este fluxo.

### 5. Materializar estados de containers em produção

Depois que todos os índices estiverem `Ready` e antes do merge, execute primeiro
o dry-run. Revise as quantidades e só então use as confirmações reforçadas de
produção:

```bash
npm run backfill:container-states -- --project=line-transbordo --dry-run
npm run backfill:container-states -- --project=line-transbordo \
  --execute --confirm-project=line-transbordo --allow-production \
  --confirm-production=BACKFILL_CONTAINER_STATES_IN_PRODUCTION
```

O backfill é idempotente, preserva projeções mais novas e nunca altera a coleção
`events`. Registre as contagens do dry-run e da execução na issue da release.
Após a primeira transferência, siga a [recuperação compatível](#recuperação-compatível-após-a-primeira-transferência):
republique v2.5.0 com a flag desligada e preserve os documentos para análise.
Uma versão anterior que desconheça transferências não é uma recuperação válida.
Não apague estados durante um incidente. Corrija a
lógica, valide novamente em staging e repare a projeção executando o backfill
idempotente revisado; lotes parciais também podem ser retomados com segurança.

### 6. Observar

Em `observe`, requisições continuam:

- token App Check ausente, inválido ou emitido por app não permitido gera log;
- bucket excedido gera log com política e `retryAfterSeconds`;
- ausência temporária da store de rate limiting gera log.

Observe ao menos um ciclo operacional representativo. Antes de enforcement:

- clientes web enviam `X-Firebase-AppCheck`;
- não existem apps legítimos fora da allowlist;
- o proxy resolve IPs reais sem aceitar o primeiro valor controlável de
  `X-Forwarded-For`;
- limites não bloqueiam uso normal;
- o segredo e o TTL estão ativos;
- respostas `503` de proteção estão ausentes.

### 7. Aplicar enforcement gradualmente

1. Altere somente `APP_CHECK_MODE` para `enforce`.
2. Refaça o smoke test e acompanhe `401`, `403` e `503`.
3. Depois de estabilizar, altere somente `RATE_LIMIT_MODE` para `enforce`.
4. Acompanhe `429`, `Retry-After`, latência e erros transacionais.

Nunca ative os dois controles de uma só vez. Configuração ausente ou inválida em
`enforce` falha fechada.

## Smoke test de staging

Execute depois de regras/índices estarem prontos e novamente após cada mudança
de modo:

1. Registrar uma conta nova.
2. Confirmar que a sessão encerra e nenhum perfil é criado antes da verificação.
3. Tentar login não verificado e confirmar o reenvio do link.
4. Verificar o email, entrar e confirmar o estado pendente de aprovação.
5. Aprovar a conta por admin e confirmar o papel correto.
6. Como `OPERATOR`, confirmar que somente eventos próprios aparecem.
7. Criar, editar e excluir um evento; conferir gap, revisão e estado do
   contêiner.
8. Como `ADMIN`, visualizar dados globais e testar a prévia/restauração.
9. Abrir contêineres, relatórios, exportação CSV, configurações e display.
10. Aplicar filtros rapidamente e confirmar ausência de dados de uma seleção
    anterior.
11. Navegar com teclado pelo drawer e formulários.
12. Confirmar no navegador o header `X-Firebase-AppCheck`.
13. Conferir logs de App Check/rate limiting e ausência de PII nos IDs de
    `_requestRateLimits`.

Também execute:

```bash
npm run verify
```

## Rollback

### App Check ou rate limiting

Se usuários legítimos forem bloqueados:

1. retorne somente o controle afetado de `enforce` para `observe`;
2. publique a configuração;
3. confirme recuperação no smoke test;
4. investigue site key, allowlist, segredo, proxy, TTL e limites;
5. não use `off` em produção.

Se a versão da aplicação estiver defeituosa, restaure uma versão compatível no
Firebase App Hosting ou corrija o commit em um novo PR. Após a primeira transferência,
siga a [recuperação compatível](#recuperação-compatível-após-a-primeira-transferência).
Preserve a configuração
`observe` e os segredos.

### Firestore Rules

Restaure a última versão conhecida como segura no Git, revise o diff e republique:

```bash
npx firebase deploy --only firestore:rules \
  --project line-transbordo --dry-run
npx firebase deploy --only firestore:rules \
  --project line-transbordo
```

Nunca faça rollback abrindo leitura/escrita pública. Índices adicionais podem
permanecer; remova somente depois de confirmar que nenhuma versão ativa os usa.

### Segredo HMAC

Se uma chave for exposta:

1. crie imediatamente uma nova versão no Secret Manager;
2. incremente `RATE_LIMIT_KEY_VERSION`;
3. publique em `observe`;
4. revogue a versão comprometida;
5. valide e retorne a `enforce`.

Buckets antigos não revelam a identidade original e expiram pelo TTL.

## Cópia anonimizada para staging

O script é dry-run por padrão, aceita somente:

- origem: `line-transbordo`;
- destino: `line-transbordo-staging-382612`.

Ele copia `clients`, `events` e `events/{id}/revisions`, pseudonimiza
deterministicamente IDs e PII, não copia `users` nem Firebase Auth e recusa
destino com dados operacionais.

Autentique Application Default Credentials com acesso mínimo de leitura na
origem e escrita no destino:

```bash
gcloud auth application-default login
```

Simule:

```bash
npm run copy:staging -- --dry-run
```

Na execução, leia a chave sem eco e sem colocá-la no histórico:

```bash
read -s COPY_ANONYMIZATION_KEY
export COPY_ANONYMIZATION_KEY
npm run copy:staging -- --execute \
  --confirm-target=line-transbordo-staging-382612
unset COPY_ANONYMIZATION_KEY
```

A chave deve ter pelo menos 32 caracteres e permanecer estável durante a cópia.
Cada documento recebe `expiresAt` sete dias à frente. Ative TTL para os três
collection groups no staging:

```bash
gcloud firestore fields ttls update expiresAt \
  --collection-group=clients --database='(default)' --enable-ttl \
  --project=line-transbordo-staging-382612
gcloud firestore fields ttls update expiresAt \
  --collection-group=events --database='(default)' --enable-ttl \
  --project=line-transbordo-staging-382612
gcloud firestore fields ttls update expiresAt \
  --collection-group=revisions --database='(default)' --enable-ttl \
  --project=line-transbordo-staging-382612
```

O script verifica contagens ao final. Se uma execução falhar depois de commits
parciais, não force nova cópia: o destino deixa de estar vazio. Investigue os
documentos escritos e aguarde o TTL ou faça uma limpeza de staging
explicitamente autorizada. Nunca execute limpeza contra produção.

## Troubleshooting

### `auth/network-request-failed`

1. confirme que o Auth Emulator está ativo;
2. revise `NEXT_PUBLIC_USE_FIREBASE_EMULATOR`;
3. confira os hosts `127.0.0.1:9099`;
4. reinicie `npm run dev`.

### Emulator solicita Java

```bash
java -version
```

Use Java 21 quando possível.

### `promote-admin` informa usuário inexistente

1. verifique a conta por email;
2. entre uma vez para sincronizar `users/{uid}`;
3. confira UID e `--project`;
4. no emulador, confira `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080`.

### APIs retornam `503` de proteção

Revise:

- modos válidos;
- allowlist do App Check;
- segredo HMAC com no mínimo 32 caracteres;
- `RATE_LIMIT_KEY_VERSION`;
- `TRUSTED_PROXY_MODE` do ambiente;
- acesso do backend ao Secret Manager e Firestore.

Retorne o controle afetado para `observe` enquanto investiga.

### Firestore pede índice

Confirme que o índice existe em `firestore.indexes.json`, publique primeiro em
staging e aguarde o status Ready antes de publicar a aplicação.

## Higiene operacional

- Não commitar `.env.local`, credenciais, site keys ainda não provisionados ou
  valores de secrets.
- Revisar `git diff` antes de qualquer deploy.
- Usar dry-run antes de promoções, cópias e deploys.
- Manter staging e produção com chaves HMAC diferentes.
- Conceder acesso mínimo necessário às credenciais operacionais.


## Transferências entre containers — v2.5.0

A origem automática exige seleção explícita de Pulmão ou Parcial. O cliente vem
da origem selecionada. A resposta de esvaziamento encerra o ciclo ou preserva seu
estado anterior, sem estimar volume. Ao corrigir o prefixo, o vínculo e o cliente
herdado são limpos. Na edição histórica, use **Atualizar estado da origem** quando
houver conflito de versão e confirme novamente o esvaziamento; a origem histórica
pode estar encerrada atualmente.

`CONTAINER_TRANSFERS_ENABLED` é uma variável de servidor, habilitada somente pelo
valor literal `true`. Ausente ou `false`, suspende criação, edição, exclusão e
restauração que afetem linhas do tempo com transferências. `/api/me` comunica a
capacidade à interface; a API continua impondo a regra a sessões antigas.

Antes de habilitar em cada ambiente, confirme os índices do manifesto como
`READY`, incluindo busca por estado e histórico por `sourceContainer`. A Vercel
usa exclusivamente `line-transbordo-staging-382612`; o Firebase App Hosting publica
`line-transbordo` pela `main`. Ative a variável no ambiente Preview da branch da
PR e explicitamente no rollout aprovado de produção.

O backfill agora executa o planejador de domínio via suporte nativo a TypeScript
do Node 22 (`--experimental-strip-types`, incluído no comando npm). Ele faz dry-run
por padrão, rejeita históricos inconsistentes e não modifica `events`. Preserve
as confirmações de projeto/produção e revise contagens antes de `--execute`.
Na execução, a varredura apenas escolhe os containers: cada projeção é recalculada
com os eventos atuais dentro de uma transação, que também lê o estado existente.
Edições concorrentes provocam nova leitura transacional; resultados idênticos não
alteram versão nem data. O resumo distingue `writes`, `skipped` e `finalCount`;
um evento removido após a varredura não recria sua projeção.
O relatório `skippedLegacy` identifica eventos anteriores ao contrato de origem
cujos códigos não passam na validação ISO. Esses eventos são preservados e não
geram uma nova projeção; não se corrige o dígito por suposição. Revise e registre
essas exceções junto às contagens. Um código inválido em evento que já declara
o contrato de origem continua interrompendo o backfill.

### Recuperação compatível após a primeira transferência

1. Preserve logs, commit, rollout e evidências do incidente.
2. Republique a versão compatível v2.5.0 com `CONTAINER_TRANSFERS_ENABLED=false`.
   No App Hosting, altere a configuração de runtime em `apphosting.yaml` por PR;
   em staging, altere a variável Preview e publique novamente.
3. Verifique que novas transferências e alterações nas linhas do tempo afetadas
   retornam conflito, enquanto históricos, relatórios e operações independentes
   de carreta continuam disponíveis. Atualize a página para refletir a capacidade.
4. Não retorne a uma versão que desconheça a origem nem apague eventos, projeções
   ou índices. Corrija a regra e revalide a reconstrução em staging antes de reparar
   projeções e reativar a funcionalidade.

A homologação inclui Pulmão e Parcial, com e sem esvaziamento, conflito de versão,
edição retroativa, exclusão/restauração, históricos dos dois containers e contagem
única em relatórios/CSV. Use fixtures identificadas somente em staging. Produção
recebe smoke test de navegação, consultas e logs, sem inserir dados fictícios.
