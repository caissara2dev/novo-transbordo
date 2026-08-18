# Fluxos Excel — staging

Estes artefatos configuram a inclusão e a atualização idempotentes na tabela
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

O app público, a configuração produtiva e a ativação das integrações permanecem
fora desta etapa.

## Fluxo UPDATE — staging

O fluxo de atualização corrige a mesma linha oficial pelo
`Identificador de check-in`. Ele nunca procura por placa, CNH ou nome.

1. No Excel Online, criar um segundo Office Script com o conteúdo de
   `update-checkin.office-script.ts.txt` e salvá-lo como
   `CheckinV1UpdateIdempotent`.
2. Criar um novo fluxo automatizado com o gatilho
   **When an HTTP request is received**.
3. Colar `update-request.schema.json` no schema do gatilho. Como no fluxo de
   inclusão, as validações de formato e de patch não vazio ficam no backend e
   no Office Script, evitando palavras do JSON Schema incompatíveis com o
   gatilho.
4. Configurar **Specific users in my tenant** com o Object ID do service
   principal, nunca com client secret, Client ID ou Object ID do App
   Registration.
5. Ativar **Concurrency Control** com grau `1` e proteger entradas e saídas.
6. Adicionar **Run script from SharePoint library** apontando para a planilha
   de staging e para `CheckinV1UpdateIdempotent`. Em `requestJson`, usar
   `string(triggerBody())`.
7. Adicionar **Response** `200` com `Content-Type: application/json`, o mesmo
   envelope do INCLUDE e **Asynchronous response** ativado.

Na primeira atualização, o script cria automaticamente a planilha oculta
`_CheckinSyncV1` e a tabela `CheckinUpdateCommandsV1`. Essa tabela guarda apenas
chave, identificador, SHA-256, horário e resultado; ela não duplica CNH,
telefone, placa ou demais valores corrigidos.

O `payloadHash` é calculado pelo backend sobre o identificador e o patch
normalizados; o horário não participa para manter retries estáveis. Se a mesma
chave chegar novamente com o mesmo hash, o script devolve o resultado original
sem reaplicar a alteração. A mesma chave com outro hash falha de forma fechada.

### Aceite do UPDATE

1. Garantir que o identificador do exemplo exista na tabela `CheckinsV1`.
2. Executar `update-request.sample.json`: a linha correta muda e retorna
   `UPDATED`, ou `UNCHANGED` se já possuir o mesmo valor.
3. Repetir o JSON: o horário e o resultado originais são devolvidos e nenhuma
   nova linha é criada no livro auxiliar.
4. Usar um identificador inexistente e confirmar que nenhuma linha é alterada.
5. Guardar evidência sanitizada e exportar os dois fluxos como solução.
