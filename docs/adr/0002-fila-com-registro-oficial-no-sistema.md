# ADR 0002 — Check-in registrado no sistema e colaboração restrita por cliente

- Status: aceito para implementação local; ativação operacional pendente
- Data: 2026-09-10

## Contexto

O fluxo anterior dependia da confirmação de gravação em Excel. A nova operação
centraliza a fila no sistema e limita o Excel à exportação. Somente parte dos
clientes participa, e ALLOG altera Booking, Amostra e Observação.

## Decisão

Reutilizar o portal existente, validação de identidade/GPS, códigos opacos,
antiduplicidade, auditoria e vínculo de visita com lançamento. Partir da main
v2.5.0 para preservar a transferência entre containers descrita na ADR 0001.

Confirmar a visita em uma transação Firestore, sem adapter ou chamada ao Excel.
Guardar ponto, precisão e horário capturados exclusivamente no registro interno.
O contrato público assinado permanece na versão v1, com status público resumido.
`syncState=CONFIRMADO` é preservado como marcador compatível do contrato legado,
sem indicar uma exportação. Novos registros recebem `recordVersion=2`.

Separar classificação, liberação, chamada e vínculo produtivo. Apenas o salvamento
atômico do lançamento leva de CHAMADO a EM_DESCARGA. Erro de evento, versão ou
reconciliação não escreve parcialmente a visita. Exclusão e restauração de evento
em descarga atualizam o vínculo na mesma transação. Uma visita concluída bloqueia
exclusão que tentaria reabrir sua descarga; não se desfaz o encerramento por efeito
colateral. Não aplicar vínculo de visita a transferências entre containers.

A API do cliente filtra por clientId no banco e retorna um DTO por lista explícita
de campos. PATCH aceita estritamente os três campos compartilhados. A Line usa
rota própria. Cliente encerrado fica em consulta; Line conserva edição. Alterações
usam expectedVersion e auditoria; não há sobrescrita silenciosa. Trocar a empresa
apaga os valores compartilhados atuais, mantendo o histórico apenas para a Line.

## Consequências

- Exportar é independente do check-in; arquivo CSV respeita filtros e contém só
  campos autorizados. Valores com prefixo de fórmula são neutralizados.
- Regras Firestore negam acesso direto às visitas, inclusive por usuários aprovados.
- Cliente não recebe CNH, telefone, GPS, pendências nem histórico interno completo.
- Amostra não dispara nenhuma transição. Um processo pode dispensá-la.
- Contas são concedidas pelo administrador, com cliente ativo e portal habilitado.
- Modos off/observe/enforce permitem implantação gradual. Observe já grava no
  sistema; somente enforce exige visita em todo novo lançamento produtivo de carreta.
- Dados antigos com reserva de sincronização pendente devem ser reconciliados antes
  de qualquer migração. Essa implementação não executa migração de dados reais.
- Depois de gravar eventos vinculados, rollback exige uma versão que entenda esses
  vínculos. Desligar a integração pausa novos vínculos e preserva os existentes.
