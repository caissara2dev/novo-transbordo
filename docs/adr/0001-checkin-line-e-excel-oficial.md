# ADR-0001: Separar o Check-in Line e manter o Excel como registro oficial

**Data:** 2026-08-10
**Status:** aceito

## Contexto

O TransbordoLine já executa os lançamentos produtivos e não pode depender de uma
mudança ampla no seu frontend para receber dados de motoristas externos. A Line
também precisa preservar a planilha Excel existente no SharePoint como registro
oficial do check-in, ao mesmo tempo em que necessita de consulta, concorrência e
auditoria adequadas à operação interna.

## Decisão

O formulário público será um aplicativo e repositório separados. O navegador
falará apenas com o backend desse aplicativo, sem Firebase no cliente; o backend
consumirá uma API versionada do TransbordoLine, assinada servidor a servidor.

O Excel no SharePoint continuará sendo o registro oficial do check-in. O
Firestore manterá o pré-cadastro e o espelho operacional, incluindo estado,
auditoria, unicidade e comandos de sincronização. Um check-in somente será
confirmado ao motorista e liberado para o fluxo interno depois da confirmação
idempotente da inclusão no Excel.

## Opções consideradas

- **Incorporar o formulário público ao TransbordoLine:** reduziria o número de
  projetos, mas aumentaria a superfície pública e o risco de regressão do app
  produtivo.
- **Tornar o Firestore o único registro oficial:** simplificaria a escrita, mas
  romperia o processo operacional estabelecido em Excel.
- **Consultar apenas o Excel durante a operação:** evitaria o espelho, mas não
  ofereceria transações, locks, auditoria e resposta previsível suficientes para
  o vínculo com lançamentos produtivos.

## Consequências

- Falha ou timeout na integração com o Excel mantém a tentativa pendente e
  repetível com o mesmo identificador, sem confirmação antecipada ou duplicação.
- Correções e exceções de GPS reservam uma versão transacional antes de chamar o
  Excel; isso impede que dois gestores alterem a linha oficial com o mesmo
  identificador e patches divergentes.
- Segredos, endereço do Power Automate e credenciais permanecem exclusivamente
  nos servidores e nos gerenciadores de segredos das plataformas.
- O fluxo produtivo atual pode permanecer inalterado com a integração em `off`,
  ser observado em `observe` e ser exigido gradualmente em `enforce`.
- O rollback desativa o vínculo novo sem apagar check-ins, linhas já confirmadas
  ou auditorias.
- A decisão define a arquitetura; não declara que planilha de staging, fluxos do
  Power Automate ou publicação do aplicativo público já estejam disponíveis.
