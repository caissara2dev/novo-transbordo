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

1. Validar `schemaVersion`, operação e formato `LT-XXXXXXXX`.
2. Limitar a concorrência do gatilho a `1`.
3. Procurar a linha por `Identificador de check-in`.
4. Se existir exatamente uma, não inserir outra e responder `ALREADY_EXISTS`.
5. Se não existir, obter o maior `Id`, somar um e adicionar a linha.
6. Usar `startedAtIso` em `Start time`; preencher `Completion time` somente
   depois de a adição ser confirmada; manter Email/Name vazios e Language
   `pt-BR`.
7. Responder HTTP `200` com JSON estrito:

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
- O bearer token, quando usado, pertence ao gerenciador de segredos.
- O fluxo nunca registra o corpo completo no histórico de erro.
- O timeout do adaptador é de 10 segundos, limitado a 15 segundos; a resposta
  aceita é JSON `200`, limitada e deve repetir o mesmo identificador.
- Antes do piloto, exportar os dois fluxos como solução, remover referências de
  conexão/segredos, registrar a versão e ensaiar importação e rollback em
  staging.
