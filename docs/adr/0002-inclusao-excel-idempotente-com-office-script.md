# ADR-0002: Executar a inclusão idempotente em uma sessão do Excel

**Data:** 2026-08-11
**Status:** proposto; depende de validação ponta a ponta em staging

## Contexto

Uma confirmação pode ser repetida quando o backend perde a resposta do Power
Automate. A documentação do conector Excel Online (Business) informa que uma
alteração pode levar até 30 segundos para aparecer em leituras posteriores.
Assim, um fluxo que lista linhas, não encontra o identificador e depois adiciona
uma linha pode duplicar o check-in em uma repetição próxima.

O Excel permanece o registro oficial e a tabela deve conservar os 19
cabeçalhos e sua ordem. O fluxo também precisa atribuir `Id` sequencial sem
permitir duas inclusões simultâneas.

## Decisão proposta

O fluxo `INCLUDE` terá concorrência `1` e chamará um Office Script versionado.
Na mesma sessão do workbook, o script:

1. valida o envelope e os 19 cabeçalhos;
2. procura o `Identificador de check-in`;
3. retorna `ALREADY_EXISTS` quando já existe exatamente uma linha;
4. falha se houver mais de uma linha com o código;
5. calcula o maior `Id`, adiciona uma linha e retorna `CREATED`.

O script neutraliza fórmulas e não faz chamadas externas. O backend só aceita a
resposta quando identificador, resultado e horário confirmam o contrato V1.

O Power Automate não permite combinar concorrência no gatilho HTTP com uma ação
`Response` síncrona. Por isso, a resposta do fluxo é assíncrona: o gatilho
retorna `202` com uma URL temporária, e o backend consulta essa URL até receber
o `200` final. O backend não considera `202` uma confirmação, não encaminha o
token Entra para a URL de acompanhamento e rejeita URLs fora da allowlist.

## Opções consideradas

- **Listar e adicionar com o conector Excel:** mais simples no designer, mas a
  leitura eventualmente atrasada não garante retry sem duplicação.
- **SharePoint List como lock separado:** oferece unicidade durável, mas cria
  outro registro operacional e mais uma fonte para reconciliar.
- **Firestore como única trava:** protege comandos do backend, mas não prova se
  uma execução anterior adicionou a linha e perdeu a resposta.

## Consequências

- O proprietário do fluxo precisa de licença Microsoft 365 Business com Office
  Scripts habilitado.
- O limite documentado é 1.600 chamadas `Run script` por usuário/dia e 120
  segundos por execução; staging deve confirmar margem operacional.
- A concorrência do gatilho não pode ser removida sem recriar o gatilho; por
  isso a decisão será testada apenas no fluxo novo de staging.
- O orçamento total da chamada ao Power Automate inclui o acompanhamento
  assíncrono. Se houver timeout, a visita permanece pendente; uma repetição usa
  o mesmo identificador e o script retorna `ALREADY_EXISTS` caso a linha tenha
  sido criada depois da perda de resposta.
- O fluxo de atualização usa um segundo Office Script. Para não alterar as 19
  colunas oficiais nem duplicar dados pessoais, o script mantém uma tabela
  auxiliar oculta com chave idempotente, identificador, SHA-256, horário e
  resultado. Isso acrescenta uma planilha técnica ao arquivo, mas não altera a
  tabela oficial `CheckinsV1`; a decisão ainda depende de validação direta e
  ponta a ponta em staging.
- O SHA-256 do UPDATE é calculado pelo backend autenticado. O Office Script o
  usa para detectar retries conflitantes, mas não o trata como prova vinda de
  um chamador público. O fluxo deve ficar restrito ao service principal.
- Até os testes `CREATED` + `ALREADY_EXISTS` passarem, esta ADR permanece
  proposta e o piloto continua bloqueado.

## Referências

- https://learn.microsoft.com/en-us/connectors/excelonlinebusiness/
- https://learn.microsoft.com/en-us/office/dev/scripts/develop/power-automate-integration
- https://learn.microsoft.com/en-us/office/dev/scripts/testing/platform-limits
- https://learn.microsoft.com/en-us/power-automate/limits-and-config
- https://learn.microsoft.com/en-us/power-automate/guidance/coding-guidelines/asychronous-flow-pattern
