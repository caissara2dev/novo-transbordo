# Controle Transbordo e Check-in de Chegada

Este contexto descreve a chegada de carretas à Baixada Santista e o trabalho de
transbordo que a Line Transportes acompanha até a conclusão da descarga.

## Operação de transbordo

**Transbordo**:
Operação de movimentação da carga de uma carreta na frente operacional da Line.
_Evitar_: atendimento, serviço genérico

**Lançamento produtivo**:
Registro de um intervalo de trabalho efetivamente realizado em uma bomba para
uma carga, cliente e carreta determinados.
_Evitar_: check-in, chegada

**Bomba**:
Frente operacional na qual um lançamento produtivo é executado.
_Evitar_: fila, doca

**Cliente**:
Empresa destinatária à qual o transbordo e a carga são atribuídos.
_Evitar_: transportadora

**Transportadora**:
Empresa responsável por levar a carga e fornecer os dados da visita.
_Evitar_: cliente

**Carreta**:
Veículo de carga identificado operacionalmente por sua placa.
_Evitar_: contêiner

## Chegada e check-in

**Visita**:
Ciclo de uma carreta e seu motorista desde o pré-cadastro até a conclusão, o
cancelamento ou a expiração. Uma placa ou CNH não pode pertencer a duas visitas
ativas ao mesmo tempo.
_Evitar_: lançamento produtivo

**Pré-cadastro**:
Registro inicial de uma visita que ainda não comprova a chegada do motorista à
região permitida.
_Evitar_: check-in confirmado

**Check-in**:
Confirmação da chegada do motorista à região permitida, depois da validação de
identidade, localização e registro oficial.
_Evitar_: reserva, garantia de ordem, autorização de descarga

**Código público**:
Identificador compartilhável da visita usado pelo motorista para continuar o
check-in sem expor o identificador interno.
_Evitar_: identificador interno, posição na fila

**Registro oficial de check-in**:
Registro confirmado que autoriza a visita a entrar no fluxo operacional da
Line.
_Evitar_: pré-cadastro, tentativa de check-in

**Fila de check-ins**:
Visão interna das visitas ativas para decisão operacional; ela não representa
posição, prioridade ou promessa de atendimento ao motorista.
_Evitar_: ordem de descarga

**Chamada**:
Decisão interna que libera uma visita para ser selecionada em um lançamento
produtivo.
_Evitar_: check-in, conclusão

**Descarga**:
Etapa iniciada quando uma visita chamada é vinculada ao lançamento produtivo da
carreta.
_Evitar_: chegada, chamada

**Conclusão da visita**:
Encerramento normal da visita após a operação de descarga.
_Evitar_: cancelamento

**Cancelamento da visita**:
Encerramento excepcional de uma visita com motivo registrado, sem apagar seu
histórico.
_Evitar_: exclusão

**Expiração**:
Cancelamento automático de um pré-cadastro que não foi utilizado no prazo
operacional.
_Evitar_: conclusão

**Exceção de localização**:
Confirmação excepcional da chegada por Supervisor ou Admin quando a localização
válida não pôde ser obtida, sempre acompanhada de justificativa.
_Evitar_: desativação da validação de localização

## Containers e transferências

**Origem da carga**:
Procedência da carga de um lançamento produtivo: uma carreta ou um container
Pulmão.

**Container Pulmão**:
Container aberto que mantém carga disponível para complementar outro container
em uma operação posterior.

**Container de destino**:
Container que recebe a carga em um lançamento produtivo. Pode iniciar um ciclo
ou continuar um ciclo aberto.

**Container de origem**:
Container aberto como Pulmão que fornece carga ao container de destino.
_Evitar_: container doador.

**Transferência entre containers**:
Lançamento produtivo único em que um container Pulmão fornece carga a outro
container.

**Esvaziado por transferência**:
Estado terminal do container de origem quando a transferência retira toda a
carga que ele continha.

**Linha do tempo do container**:
Sequência operacional das passagens que compõem o ciclo de um container e
determinam seu estado atual.
