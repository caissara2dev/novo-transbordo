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
