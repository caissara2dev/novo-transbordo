# Power Automate — contrato Check-in V1

Este documento descreve os dois fluxos que deverão ser criados em uma solução
versionada do Power Automate. O repositório contém o contrato e o adaptador, mas
não contém conexões, URLs, tokens nem uma exportação produtiva.

## Planilha de staging

- Arquivo vazio: `outputs/checkin-v1/Agendamento Line Transportes - Staging.xlsx`.
- Planilha: `Sheet1`.
- Tabela oficial de origem: `OfficeForms.Table`.
- Tabela sanitizada de staging: `CheckinsV1`.
- A ordem e a grafia das 18 colunas da planilha oficial foram preservadas. Os
  dois cabeçalhos de ciência foram atualizados com os textos aprovados para a
  V1 e a coluna final é `Identificador de check-in`.
- A planilha oficial foi comparada localmente em 10/08/2026. Suas 1.692 linhas
  de respostas não foram copiadas para o artefato de staging.
- O arquivo original não foi alterado. Em 10/08/2026, o upload manual do
  artefato sanitizado foi confirmado na biblioteca `Terminal - Line`, pasta
  `Documentos/linebot`. A validação funcional com os fluxos continua pendente.

## Fluxo 1 — inclusão idempotente

Gatilho: `When an HTTP request is received`.

Autenticação do gatilho:

1. Selecionar `Specific users in my tenant`.
2. Em `Allowed users`, informar somente o Object ID do service principal da
   Enterprise Application do backend. Não usar o Application/Client ID nem o
   Object ID do App Registration.
3. Nunca deixar `Allowed users` vazio; nesse modo, vazio amplia o acesso para
   qualquer identidade do tenant.
4. O backend obtém um token por client credentials com audience
   `https://service.flow.microsoft.com/` e scope
   `https://service.flow.microsoft.com//.default`.

Evidência operacional de staging em 11/08/2026:

- [x] App Registration single-tenant criado.
- [x] Enterprise Application/service principal criado.
- [x] Gatilho alterado para `Specific users in my tenant`.
- [x] `Allowed users` preenchido com o Object ID do service principal e fluxo
  salvo; nenhum identificador ou segredo real foi versionado.
- [ ] Exportar o fluxo como solução sanitizada e anexar a evidência versionada.
- [ ] Trocar a ação Excel do fluxo de rascunho pela planilha/tabela de staging e
  executar o primeiro teste ponta a ponta.

Os dois itens pendentes acima bloqueiam piloto e produção. A confirmação manual
do gatilho não significa que a integração Excel esteja pronta.

Requisição:

```json
{
  "schemaVersion": "checkin-excel.v1",
  "operation": "INCLUDE",
  "idempotencyKey": "LT-23456789",
  "record": {
    "identifier": "LT-23456789",
    "startedAtIso": "2026-08-10T12:00:00.000Z",
    "language": "pt-BR",
    "email": "",
    "name": "",
    "driverName": "...",
    "driverLicense": "...",
    "driverPhone": "...",
    "plate": "ABC1D23",
    "carrierName": "...",
    "vehicleType": "Bitrem",
    "product": "...",
    "originPlant": "...",
    "originInvoiceNumbers": "...",
    "remittanceInvoiceNumber": "...",
    "whatsappNoticeAccepted": "Ciente",
    "queueLocationAccepted": "Ciente"
  }
}
```

Passos obrigatórios:

1. Colar o schema versionado em
   `outputs/checkin-v1/power-automate/include-request.schema.json` no gatilho.
2. Limitar a concorrência do gatilho a `1`.
3. Executar o Office Script versionado em
   `outputs/checkin-v1/power-automate/include-checkin.office-script.ts.txt`,
   passando `string(triggerBody())`.
4. O script valida versão, operação, chave, tabela e os 19 cabeçalhos antes de
   escrever.
5. Se existir exatamente uma linha com o identificador, não inserir outra e
   retornar `ALREADY_EXISTS`; mais de uma linha é erro explícito.
6. Se não existir, obter o maior `Id`, somar um e adicionar a linha na ordem
   oficial. `Start time` usa `startedAtIso`; `Completion time` é criado na mesma
   execução; Email/Name ficam vazios e Language é `pt-BR`.
7. Envolver o resultado do script no envelope HTTP `200` estrito:

```json
{
  "ok": true,
  "data": {
    "identifier": "LT-23456789",
    "confirmedAtIso": "2026-08-10T12:00:01.000Z",
    "result": "CREATED"
  }
}
```

## Fluxo 2 — atualização idempotente

Requisição:

```json
{
  "schemaVersion": "checkin-excel.v1",
  "operation": "UPDATE",
  "idempotencyKey": "LT-23456789:v4",
  "identifier": "LT-23456789",
  "requestedAtIso": "2026-08-10T13:00:00.000Z",
  "patch": { "plate": "BRA2E19" }
}
```

Passos obrigatórios:

1. Limitar a concorrência a `1` e validar a allowlist de campos do patch.
2. Localizar exatamente uma linha por `Identificador de check-in`; zero ou mais
   de uma linha é erro e não deve ser tratado como sucesso.
3. Guardar o resultado da chave idempotente para que o mesmo corpo responda sem
   repetir efeitos; a mesma chave com corpo diferente deve falhar.
4. Atualizar somente os campos presentes no patch.
5. Responder `UPDATED` ou `UNCHANGED` no mesmo envelope da inclusão.

## Segurança e operação

- Os endpoints são HTTPS e ficam apenas em variáveis de servidor.
- Tenant ID, client ID e client secret ficam no gerenciador de secrets do
  backend. O client secret nunca é versionado, exibido em logs ou enviado ao
  navegador.
- `entra-client-credentials` é o único modo aceito quando o adaptador é criado.
  Ausência de modo, `none` ou credencial estática falham antes da chamada. O
  rollback operacional usa Forms + `enforce -> observe -> off`, sem reabrir um
  caminho de autenticação legado.
- O token Entra é mantido apenas em memória até a margem anterior à expiração;
  cada instância do provider pertence a um único tenant/client.
- O fluxo nunca registra o corpo completo no histórico de erro.
- A aquisição do token tem limite de 5 segundos e a chamada do fluxo, 10
  segundos. A resposta aceita é JSON `200`, limitada e deve repetir o mesmo
  identificador.
- A inclusão não usa `List rows present in a table` seguido de `Add a row`.
  A Microsoft documenta que alterações do conector Excel podem levar até 30
  segundos para aparecer; esse intervalo permitiria duplicidade após resposta
  perdida. O Office Script lê, verifica e adiciona na mesma sessão do workbook.
- O gatilho usa concorrência `1`. O limite do Office Script é 1.600 execuções
  por usuário/dia e 120 segundos por operação; o piloto deve medir volume e
  duração antes da promoção.
- Antes do piloto, exportar os dois fluxos como solução, remover referências de
  conexão/segredos, registrar a versão e ensaiar importação e rollback em
  staging.

Referências oficiais:

- https://learn.microsoft.com/en-us/connectors/excelonlinebusiness/
- https://learn.microsoft.com/en-us/office/dev/scripts/develop/power-automate-integration
- https://learn.microsoft.com/en-us/office/dev/scripts/testing/platform-limits
- https://learn.microsoft.com/en-us/power-automate/limits-and-config
