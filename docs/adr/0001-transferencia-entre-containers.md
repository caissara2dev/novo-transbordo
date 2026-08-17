# ADR 0001 — Um evento em duas linhas do tempo de container

- Status: aceito
- Data: 2026-08-13
- Versão: 2.3.0

## Contexto

Uma carga produtiva pode vir de uma carreta ou de um container Pulmão. Na
segunda situação, a operação tem uma única duração e acontece uma única vez na
bomba, mas altera simultaneamente o ciclo do destino e o ciclo da origem. A
origem pode permanecer Pulmão ou ser completamente esvaziada.

Registrar dois eventos produtivos duplicaria tempo, produtividade e auditoria.
Atualizar apenas a projeção atual da origem perderia sua participação na linha
do tempo e impediria uma reconstrução confiável após edição, exclusão ou
restauração.

## Decisão

Representar a transferência como um único evento produtivo com dois papéis:

- `DESTINATION`: recebe a carga e segue as transições normais do seu ciclo;
- `SOURCE`: exige um container aberto como Pulmão e mantém `BUFFER` ou assume o
  estado terminal interno `TRANSFER_EMPTIED`.

O evento guarda os containers relacionados, os vínculos com ambos os ciclos e
as versões observadas das duas projeções. Origem e destino devem ser diferentes
e do mesmo cliente. A gravação e toda reconciliação posterior atualizam evento,
vínculos e projeções em uma única transação Firestore.

Consultas de histórico localizam o mesmo evento pelos campos de destino e de
origem e o apresentam pela perspectiva do container consultado. Relatórios e
display continuam processando somente o evento produtivo único.

## Consequências

- Edição, exclusão e restauração precisam reconstruir as duas linhas do tempo.
- Conflitos de versão impedem alterações parciais quando qualquer lado mudou.
- `TRANSFER_EMPTIED` encerra o ciclo, mas não aparece como opção manual nem como
  container aberto.
- Eventos legados sem origem explícita continuam equivalentes a `TRUCK`.
- A versão 2.3.0 não infere nem armazena peso ou volume; registra somente se a
  origem foi completamente esvaziada.

## Alternativas rejeitadas

- **Dois eventos produtivos, um por container:** duplicaria duração e
  indicadores e criaria risco de os registros divergirem.
- **Alterar somente `containerStates`:** quebraria a fonte de verdade baseada em
  eventos e perderia auditoria e capacidade de reconstrução.
- **Criar um agregado separado de transferências:** adicionaria outra fonte de
  verdade e sincronização sem benefício suficiente para o escopo atual.
- **Exigir quantidade transferida:** o processo atual não dispõe de medição
  confiável de peso ou volume e essa informação não é necessária para definir
  o ciclo.
