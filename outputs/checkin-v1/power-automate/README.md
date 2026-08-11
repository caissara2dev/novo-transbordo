# Fluxo INCLUDE — staging

Estes artefatos configuram somente a inclusão idempotente na tabela
`CheckinsV1`. Nenhum arquivo contém URL, conexão, identificador real ou segredo.

## Por que usar Office Script

O conector Excel informa que uma linha adicionada pode levar até 30 segundos
para aparecer em uma leitura posterior. Portanto, o padrão "listar e adicionar"
não garante idempotência quando uma resposta HTTP é perdida e repetida.

O Office Script lê e escreve a tabela na mesma sessão do Excel. O gatilho do
fluxo deve ter concorrência `1`, garantindo uma única inclusão por vez. O script
retorna `ALREADY_EXISTS` quando encontra o identificador e falha se encontrar
mais de uma linha, sem esconder corrupção da planilha.

## Configuração do fluxo de staging

1. No Excel Online, abrir `Agendamento Line Transportes - Staging.xlsx`.
2. Em **Automatizar > Novo Script**, substituir o conteúdo pelo arquivo
   `include-checkin.office-script.ts.txt` e salvar como
   `CheckinV1IncludeIdempotent`.
3. No gatilho **When an HTTP request is received**, colar
   `include-request.schema.json` em **Request Body JSON Schema**.
   O schema não usa `pattern`, pois o gatilho do Power Automate rejeita essa
   palavra quando a validação está ativa. Formatos de código, CNH, telefone e
   placa continuam validados pelo backend e pelo Office Script antes da escrita.
4. Nas configurações do gatilho, ativar **Concurrency Control** com grau `1`.
   Essa alteração é adequada apenas ao fluxo novo de staging; a Microsoft
   informa que removê-la exige recriar o gatilho.
   Como o Power Automate não aceita concorrência `1` junto de uma resposta HTTP
   síncrona, a ação **Response** deve ter **Asynchronous response** ativado.
5. Remover a ação de rascunho que aponta para `report gli.xlsx` / `Table2`.
6. Adicionar **Excel Online (Business) > Run script**:
   - workbook: biblioteca `Documentos`, pasta `linebot`;
   - arquivo: `Agendamento Line Transportes - Staging.xlsx`;
   - script: `CheckinV1IncludeIdempotent`;
   - parâmetro `requestJson`: expressão `string(triggerBody())`.
7. Renomear a ação para `Run_Include_Checkin_V1`.
8. Adicionar a ação **Response**, status `200`, cabeçalho
   `Content-Type: application/json` e corpo:

```json
{
  "ok": true,
  "data": "@body('Run_Include_Checkin_V1')?['result']"
}
```

No designer, inserir `result` como conteúdo dinâmico do script para que `data`
seja um objeto, não uma string. O código acima registra a expressão esperada;
o designer pode exibi-la como um token roxo.

Com a resposta assíncrona ativada, o primeiro retorno do gatilho é `202` e traz
uma URL temporária no cabeçalho `Location`. O backend valida essa URL, consulta
o andamento sem reenviar o token Entra e só confirma o check-in após receber o
`200` final com o envelope acima. `202`, timeout ou uma URL fora da allowlist
mantêm a tentativa pendente e segura para repetição idempotente.

## Aceite desta etapa

1. Enviar `include-request.sample.json` uma vez: resposta `CREATED`, uma linha.
2. Enviar o mesmo JSON novamente: resposta `ALREADY_EXISTS`, ainda uma linha.
3. Confirmar que `Id`, horários, placa e identificador ocupam as colunas certas.
4. Guardar capturas sanitizadas e exportar o fluxo como solução versionada.

O fluxo de atualização, o app público e produção permanecem fora desta etapa.
