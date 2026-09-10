# Operação de transbordo

Este contexto descreve os lançamentos das bombas e os ciclos dos containers
que recebem ou fornecem carga na operação.

## Linguagem

**Origem da carga**:
Procedência da carga de um lançamento produtivo: uma carreta ou um container
Pulmão ou Parcial.

**Container Pulmão**:
Container aberto que mantém carga disponível para complementar outro container
em uma operação posterior.

**Container Parcial**:
Container aberto que ainda receberá carga para completar sua operação. Também
pode fornecer carga a outro container, mantendo seu estado enquanto restar carga.

**Container de destino**:
Container que recebe a carga em um lançamento produtivo. Pode iniciar um ciclo
ou continuar um ciclo aberto.

**Container de origem**:
Container aberto como Pulmão ou Parcial que fornece carga ao container de destino.
_Evitar_: container doador.

**Transferência entre containers**:
Lançamento produtivo único em que um container Pulmão ou Parcial fornece carga a outro
container.

**Esvaziado por transferência**:
Estado terminal do container de origem quando a transferência retira toda a
carga que ele continha.

**Linha do tempo do container**:
Sequência operacional das passagens que compõem o ciclo de um container e
determinam seu estado atual.


## Fila de check-ins

**Pré-cadastro**: dados recebidos antes da confirmação de presença. Não entra na fila;
expira em cinco dias se não for confirmado.

**Check-in**: confirmação de presença com ponto, precisão e horário de captura.
O sistema grava a visita oficialmente. Não garante posição ou ordem de descarga.

**Visita**: unidade da fila, identificada por código público e UUID interno. Uma
CNH ou placa não pode manter duas visitas ativas. Cliente começa sem atribuição.

**Classificação**: conferência pela Line, atribuição de cliente e registro de
pendências. Salvar classificação não altera a etapa operacional.

**Informações compartilhadas**: Booking, Amostra e Observação. A Line sempre as
edita; um cliente participante edita apenas suas próprias visitas ainda abertas.
Amostra é texto livre; “OK” significa somente aprovação da amostra.

**Pendência interna**: descrição livre com estado aberto ou resolvido, exclusiva da
Line. Pendências abertas impedem liberação e chamada.

**Liberação para chamada**: decisão explícita da Line, posterior à classificação.
**Chamada**: ação explícita sobre uma visita aguardando chamada.
**Em descarga**: visita cujo lançamento produtivo vinculado foi salvo com sucesso.
Selecionar uma visita no formulário não inicia a descarga.

**Cliente participante**: empresa habilitada pelo administrador para acessar o
portal. Cada conta CUSTOMER fica vinculada a uma única empresa. Sem participação,
os campos continuam sendo preenchidos pela Line. O perfil ANALYST atua na fila.

**Localização do check-in**: ponto capturado uma vez, consultável apenas pela Line;
não é rastreamento ao vivo nem informação compartilhada com o cliente.
