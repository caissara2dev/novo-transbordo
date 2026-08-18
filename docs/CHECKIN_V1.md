# Check-in Line V1 — PRD e contrato de integração

**Estado do documento:** contrato aprovado para implementação
**Baseline original da PRD:** TransbordoLine `v2.2.0` no commit `a347a3f`
**Versão-alvo atual do TransbordoLine:** `v2.4.0`, posterior à transferência entre containers da `v2.3.0`
**Versão-alvo do aplicativo público:** `v1.0.0`
**Domínio público aprovado:** `fila.linebot.com.br`

Este documento especifica o comportamento da V1. Ele não comprova a publicação
do aplicativo público, da planilha de staging ou dos fluxos Power Automate.

## Objetivo e limites

A V1 permite que a transportadora faça o pré-cadastro, que o motorista confirme
sua chegada e que a Line acompanhe a visita até a conclusão, sem alterar o
comportamento vigente dos lançamentos produtivos quando a integração estiver
desligada.

Estão incluídos:

- pré-cadastro, confirmação com ou sem código e recuperação do código;
- validação de identidade, consentimentos e localização;
- inclusão e correção idempotentes da mesma linha no Excel;
- fila interna, atribuição de cliente, estados, cancelamento e auditoria;
- vínculo opcional ou obrigatório entre check-in e lançamento, conforme a flag;
- staging, piloto, rollout gradual e rollback preservando os dados.

Não estão incluídos na V1:

- garantia ou divulgação de posição e ordem de descarga;
- confirmação de identidade por SMS;
- alimentação automática das planilhas específicas de clientes;
- exclusão ou anonimização automática de dados pessoais;
- substituição da planilha oficial pelo Firestore.

A retenção e o atendimento integral à LGPD deverão ser definidos em issue
própria antes de qualquer rotina automática de exclusão.

## Atores e permissões

| Ator | Capacidades |
| --- | --- |
| Transportadora | Criar pré-cadastro e compartilhar o código público. |
| Motorista | Confirmar check-in, recuperar código e consultar somente se o check-in foi confirmado ou cancelado. |
| Operador | Ver os campos operacionais mínimos e iniciar `EM_DESCARGA` somente pela seleção de uma visita `CHAMADO` em um lançamento. |
| Supervisor | Ver os dados completos, atribuir cliente, executar transições válidas, corrigir, cancelar, autorizar exceção de localização e desfazer vínculo incorreto com motivo. |
| Admin | Todas as capacidades do Supervisor, configuração operacional e fallback manual de placa em `enforce`, com motivo. |
| Display | Nenhum acesso aos dados de check-in. |
| Backend público | Consumir exclusivamente a API de integração V1 com autenticação HMAC. |

O Operador recebe apenas placa, motorista, transportadora, produto, cliente e
estado. Supervisor e Admin podem acessar os dados pessoais e fiscais necessários
e a auditoria. A API nunca entrega posição ou ordem ao motorista.

## Modelo da visita

### Identificadores e identidade

- `id`: UUID interno, nunca exposto em respostas públicas.
- `publicCode`: `LT-XXXXXXXX`, usando oito caracteres aleatórios do alfabeto
  `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`.
- Placa: convertida para maiúsculas, sem pontuação, e validada nos formatos
  antigo ou Mercosul.
- CNH: exatamente 11 dígitos e dígitos verificadores válidos.
- Telefone: normalizado e validado estruturalmente como número brasileiro; não
  implica posse confirmada por SMS.
- HMACs versionados de placa, CNH e telefone formam índices de busca e locks de
  unicidade. Os valores originais não são usados como IDs de documentos.

Uma placa ou uma CNH pode participar de apenas uma visita ativa. O lock é
liberado somente após `CONCLUIDO` ou `CANCELADO`. Repetir uma operação com o
mesmo identificador de idempotência e o mesmo corpo devolve o resultado já
registrado; reutilizá-lo com corpo diferente retorna `409 CONFLICT`.

### Estados operacionais

```text
PRE_CADASTRO
  -> AGUARDANDO_LIBERACAO
  -> AGUARDANDO_CHAMADA
  -> CHAMADO
  -> EM_DESCARGA
  -> CONCLUIDO
```

`CANCELADO` é um estado terminal alternativo para qualquer visita ainda não
concluída.

| Estado | Significado |
| --- | --- |
| `PRE_CADASTRO` | Visita criada, ainda sem check-in oficial confirmado. |
| `AGUARDANDO_LIBERACAO` | Identidade e localização validadas e linha confirmada no Excel; aguarda decisão interna. |
| `AGUARDANDO_CHAMADA` | Cliente atribuído e visita liberada; aguarda contato da Line. |
| `CHAMADO` | Visita contatada e disponível para vínculo produtivo. |
| `EM_DESCARGA` | Visita vinculada a um lançamento produtivo. |
| `CONCLUIDO` | Visita encerrada normalmente. |
| `CANCELADO` | Visita encerrada com motivo, inclusive `EXPIRADO`. |

Transições são progressivas e usam `expectedVersion`. Uma divergência retorna
`409 CONFLICT` e exige recarregar o registro. Supervisor e Admin executam as
transições manuais válidas. O cliente é obrigatório antes da entrada em
`AGUARDANDO_CHAMADA`.

O Operador não muda estado diretamente: selecionar uma visita `CHAMADO` no
lançamento cria o vínculo e muda a visita para `EM_DESCARGA` na mesma transação.
Somente Supervisor ou Admin desfazem uma seleção incorreta, restaurando
`CHAMADO` e registrando o motivo. Conclusão, correção, cancelamento e qualquer
transição excepcional também registram autor, horário, versões anterior/nova e
motivo.

Um `PRE_CADASTRO` não utilizado por cinco dias muda automaticamente para
`CANCELADO`, com motivo `EXPIRADO`. A expiração não apaga o registro.

### Localização

- O raio padrão é 20 km e a precisão máxima aceita é 1.000 m.
- O centro operacional aprovado em 10/08/2026 é
  `23°55'39.8"S 46°22'32.9"W`, convertido para
  `-23.927722, -46.375806` no formato decimal usado pelo backend.
- Latitude e longitude centrais são variáveis privadas de ambiente. A aplicação
  recusa iniciar em produção quando qualquer uma estiver ausente ou inválida.
- A distância usa a fórmula de Haversine.
- Latitude e longitude recebidas são transitórias: não são persistidas nem
  incluídas em logs. Persistem apenas resultado, distância arredondada para 100
  m, precisão informada e horário da captura.
- Supervisor ou Admin podem confirmar sem localização válida somente por uma
  ação explícita, com justificativa e auditoria marcada como bypass.

### Consentimentos obrigatórios

No pré-cadastro e no fluxo sem código, a pessoa responsável precisa aceitar,
separadamente, os dois textos abaixo. Na confirmação com código, os aceites já
pertencem ao pré-cadastro recuperado e não são digitados novamente:

> Estou ciente de que, após concluir o check-in, devo enviar a foto da NF de
> Usina para o WhatsApp da Line Transportes: (13) 99652-4561.

> Estou ciente de que o check-in confirma somente minha chegada à Baixada
> Santista, não garante posição ou ordem de descarga, e devo aguardar o contato
> da Line por telefone ou WhatsApp.

Os textos são persistidos no Excel como `Ciente`. A V1 registra os dois aceites
como booleanos no pré-cadastro; versionamento textual e horário individual de
aceite ficam reservados para uma evolução de consentimento/LGPD.

## Excel e sincronização

O arquivo Excel no SharePoint é o registro oficial. A tabela existente conserva
a ordem e o formato de suas colunas e acrescenta somente `Identificador de
check-in`, preenchido por `publicCode`.

A fonte oficial foi validada localmente em 10/08/2026: aba `Sheet1`, tabela
`OfficeForms.Table`, 18 colunas e 1.692 respostas. O artefato sanitizado de
staging conserva o contrato, atualiza os dois textos de ciência aprovados e usa
a tabela `CheckinsV1`, sem copiar qualquer resposta real.

| Coluna | Regra V1 |
| --- | --- |
| `Id` | Sequencial atribuído pelo fluxo, com concorrência controlada. |
| `Start time` | Início da tentativa de confirmação com localização. |
| `Completion time` | Horário em que a inclusão idempotente é confirmada. |
| `Email` e `Name` | Vazios. |
| `Language` | `pt-BR`. |
| `Identificador de check-in` | Código público único da visita. |

Os demais campos preservam o contrato da planilha atual. Dados reais, URL do
fluxo e credenciais não entram no Git.

### Estado da sincronização

O estado operacional e o estado de sincronização são independentes:

- `PENDENTE`: comando durável criado, ainda não confirmado pelo Excel;
- `EM_PROCESSAMENTO`: tentativa em curso;
- `CONFIRMADO`: inclusão ou atualização confirmada pelo identificador;
- `FALHA_RETRY`: falha temporária, elegível para nova tentativa idempotente.

Ao confirmar o motorista, o servidor valida identidade e localização, reserva o
comando de inclusão e tenta executá-lo imediatamente. A visita permanece
`PRE_CADASTRO` e nunca recebe confirmação antecipada. Somente após a resposta
válida do Excel ela muda para `AGUARDANDO_LIBERACAO`. Em timeout, resposta
perdida ou indisponibilidade, o comando fica `FALHA_RETRY`; a mesma confirmação
pode ser repetida com o identificador original sem criar outra linha.

Uma correção posterior primeiro reserva, em transação, a versão e o hash do
patch. Só a reserva vencedora chama a atualização por `Identificador de
check-in`; a alteração é consolidada no Firestore depois da confirmação. Falha
ou resposta perdida preserva a mesma chave idempotente para retry. A auditoria
registra campos alterados e resultado, sem copiar valores pessoais anteriores e
novos para a revisão.

São necessários dois fluxos Power Automate exportáveis e versionados:

1. inclusão idempotente, que procura o identificador antes de inserir;
2. atualização idempotente, que altera somente a linha do identificador.

Ambos devem limitar concorrência para impedir IDs duplicados e bloqueios do
arquivo. Esta especificação não afirma que esses fluxos já foram criados ou
publicados.

## Contrato HTTP

Todas as respostas seguem o envelope existente:

```json
{ "ok": true, "data": {}, "meta": {} }
```

```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Mensagem segura para o usuário."
  }
}
```

Schemas são estritos e rejeitam campos desconhecidos. Além dos códigos comuns,
a V1 pode usar `ACTIVE_VISIT_EXISTS`, `CHECKIN_PENDING_SYNC`,
`CHECKIN_NOT_CALLED`, `LOCATION_OUTSIDE_RADIUS`, `LOCATION_INACCURATE` e
`INTEGRATION_DISABLED`. Nenhuma mensagem revela se uma única placa, CNH ou
telefone existe.

### API do aplicativo público para o TransbordoLine

As rotas abaixo são chamadas somente pelo backend público:

| Método e rota | Operação |
| --- | --- |
| `POST /api/integrations/checkins/v1/pre-registrations` | Criar pré-cadastro. |
| `POST /api/integrations/checkins/v1/confirmations` | Confirmar visita existente com código. |
| `POST /api/integrations/checkins/v1/walk-ins` | Criar e confirmar em uma única visita. |
| `POST /api/integrations/checkins/v1/recoveries` | Recuperar código com placa + telefone + CNH. |
| `POST /api/integrations/checkins/v1/status` | Consultar estado público com código + telefone. |
| `POST /api/integrations/checkins/v1/maintenance/expire` | Expirar lote de pré-cadastros; chamada exclusiva do cron assinado. |

O pré-cadastro e o walk-in recebem motorista, transportadora, placa, telefone,
CNH, dados da carga e os dois aceites. A confirmação recebe código, placa,
telefone, CNH e a captura GPS com `latitude`, `longitude`, `accuracyMeters` e
`capturedAtIso`. Latitude e longitude existem somente durante a validação da
requisição.

Recuperação bem-sucedida devolve o mesmo código ativo. Consulta de estado
devolve apenas `processing`, `confirmed` ou `cancelled`; estados internos e
ordem não são expostos.

Cada requisição contém:

- `X-Checkin-Key-Id`: versão/chave ativa;
- `X-Checkin-Timestamp`: instante UTC da assinatura;
- `X-Checkin-Request-Id`: UUID usado para idempotência e proteção contra replay;
- `X-Checkin-Signature`: HMAC-SHA256 do método, caminho, timestamp, request ID e
  hash do corpo bruto.

O servidor rejeita relógio fora da tolerância configurada, chave desconhecida,
assinatura inválida e request ID reaproveitado com outro corpo. Um replay exato
de mutação devolve o resultado idempotente já armazenado, sem repetir efeitos.

### API interna autenticada

| Método e rota | Operação |
| --- | --- |
| `GET /api/checkins` | Lista filtrada conforme o papel, limitada aos 200 registros mais recentes. |
| `GET /api/checkins/:id` | Detalhe permitido ao papel autenticado. |
| `PATCH /api/checkins/:id` | Corrigir campos ou atribuir cliente com `expectedVersion`. |
| `POST /api/checkins/:id/transitions` | Executar transição válida com `toStatus`, `expectedVersion` e motivo quando exigido. |
| `POST /api/checkins/:id/cancel` | Cancelar com motivo obrigatório. |
| `POST /api/checkins/:id/location-override` | Confirmar exceção de localização com justificativa. |

O contrato atual de `POST /api/events` recebe apenas o campo opcional
`checkInId`. Em `observe`, a placa manual continua válida e a seleção de uma
visita chamada é opcional. Em `enforce`, Operador deve enviar um `checkInId`
`CHAMADO`; Admin pode usar placa manual apenas com `manualPlateReason`. Eventos
antigos e eventos criados com a integração desligada permanecem válidos.

A criação do evento, o vínculo e `CHAMADO -> EM_DESCARGA` são atômicos. Duas
seleções simultâneas da mesma visita produzem um único vencedor e `409 CONFLICT`
para a outra requisição.

Um evento vinculado não permite alterar silenciosamente placa ou categoria. A
seleção incorreta é desfeita por Supervisor/Admin ao excluir logicamente o
lançamento com motivo; a mesma transação devolve a visita a `CHAMADO`. Restaurar
o evento religa a visita somente se ela ainda estiver disponível. Enquanto um
evento ativo possui a visita, uma transição manual para `CHAMADO` ou
`CANCELADO` retorna `CHECKIN_EVENT_MISMATCH`.

## Segurança e auditoria

- O navegador público não recebe SDK, configuração ou credencial Firebase.
- Turnstile invisível é validado no backend público antes da chamada assinada.
- Rate limiting cobre criação, confirmação, recuperação e consulta pública,
  usando identificadores HMAC e IP confiável conforme a plataforma.
- Segredos HMAC, credenciais e URLs Power Automate são exclusivos do servidor e
  nunca usam prefixo público.
- Regras Firestore bloqueiam leitura e escrita direta das coleções de check-in;
  toda autorização ocorre novamente no servidor.
- Logs não contêm CNH, telefone, coordenadas, corpo bruto, segredo ou assinatura.
- Toda mutação registra ator, origem, instante, request ID, versão anterior e
  nova, campos alterados e motivo, sem duplicar dados sensíveis desnecessários.
- Índices HMAC possuem versão para permitir rotação de chave sem perder a
  capacidade de reconciliar visitas existentes.

## Flags e compatibilidade

`CHECKIN_INTEGRATION_MODE` aceita somente:

| Modo | Comportamento |
| --- | --- |
| `off` | Recursos públicos e tela interna ficam indisponíveis; lançamentos mantêm exatamente o contrato anterior e os dados já gravados são preservados. É o padrão inicial. |
| `observe` | Check-ins e fila são habilitados; o lançamento manual continua permitido e pode selecionar opcionalmente uma visita `CHAMADO`. |
| `enforce` | Operador precisa selecionar uma visita `CHAMADO`; somente Admin possui fallback de placa manual com motivo. |

Valores ausentes ou inválidos equivalem a `off`. Produção não aceita `enforce`
sem coordenadas, segredos, integração Excel e critérios de rollout validados.
O backend aplica esse bloqueio exigindo os dois endpoints HTTPS do Power
Automate e `CHECKIN_ENFORCE_ROLLOUT_APPROVED=true`; a variável permanece
`false` até o piloto e o ensaio de rollback serem aprovados.
Mudar a flag nunca migra nem apaga registros.

## Persistência e auditoria

As coleções aditivas são separadas dos eventos existentes:

- `checkins`: estado atual e versão otimista;
- `checkins/{id}/revisions`: histórico imutável de mudanças;
- `_checkinUniqueLocks`: locks HMAC de placa e CNH ativas;
- `_checkinSyncCommands`: inclusão/atualização idempotente e seus resultados;
- `_checkinIntegrationRequests`: request IDs e resultados necessários à
  idempotência e proteção contra replay.

Não há exclusão ou anonimização automática na V1. Reversões de software não
removem documentos, índices, linhas confirmadas ou auditoria.

## Rollout e rollback

### Controle de versão

- O desenvolvimento ocorre em branch `codex/*`; não há push direto na `main`.
- Commits convencionais pequenos separam documentação, domínio, infraestrutura,
  UI e vínculo produtivo.
- Cada PR informa issue, critérios de aceite, riscos, contratos alterados,
  testes, evidências e passos exatos de rollback.
- Artefatos exportados do Power Automate são versionados sem conexões, segredos,
  URLs produtivas ou dados pessoais.
- Cada promoção registra commits e versões do TransbordoLine, aplicativo
  público, fluxos, planilha e flags.
- Os itens locais `.codex-check-firebase-key.mjs` e
  `agendamento-line-prototype/` não pertencem aos commits do TransbordoLine.

### Promoção

1. Criar planilha de staging vazia com o mesmo contrato da tabela produtiva.
2. Importar e configurar os fluxos em staging, mantendo segredos fora do Git.
3. Publicar o aplicativo público apenas em preview e o TransbordoLine apenas no
   Firebase staging.
4. Executar testes automatizados e cenários de falha do Excel.
5. Ativar `observe`, realizar piloto mantendo o Microsoft Forms disponível e
   comparar Excel, Firestore e tela por código público.
6. Ensaiar rollback completo em staging.
7. Somente com aprovação explícita, publicar as versões, trocar o link público e
   promover gradualmente para `enforce`.

O centro geográfico, o raio de 20 km e o domínio `fila.linebot.com.br` já estão
definidos. Produção continua bloqueada enquanto eles não estiverem configurados
nos ambientes e enquanto faltarem fluxos e planilha publicados em staging,
piloto sem divergências, ensaio de rollback ou aprovação explícita.

### Rollback operacional

1. Restaurar o link do Microsoft Forms no WhatsApp.
2. Alterar `enforce -> observe -> off` conforme a gravidade.
3. Pausar os fluxos Power Automate, preservando seu histórico.
4. Restaurar os rollouts anteriores do Vercel e Firebase App Hosting.
5. Criar PR de `git revert` do merge e executar todos os gates antes de publicar
   a versão corretiva.
6. Não apagar coleções, linhas, campos, índices ou auditoria durante o rollback.

## Critérios de aceite

- Unitários cobrem distância, precisão, CNH, telefone, placa, código, expiração,
  papéis, estados e transições.
- Concorrência cobre placa/CNH duplicadas, confirmação repetida e duas seleções
  produtivas simultâneas.
- Integração cobre inclusão e atualização idempotentes, timeout, resposta perdida
  e retry do Excel.
- Segurança cobre assinatura, replay, Turnstile, rate limiting, Rules e ausência
  de dados sensíveis em logs.
- E2E público cobre transportadora, motorista com código, walk-in, recuperação,
  localização inválida e Excel indisponível.
- E2E interno cobre fila, visibilidade por papel, atribuição, chamada, vínculo,
  conclusão, correção e cancelamento.
- Regressão cobre login, lançamentos atuais, gaps, bombas, contêineres,
  relatórios, display, usuários, edição, exclusão e restauração.
- Gates mínimos: lint sem warnings, TypeScript, cobertura global de pelo menos
  80%, Rules, E2E, build, auditoria de dependências e `npm run verify`.
