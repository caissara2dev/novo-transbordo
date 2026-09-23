# Pausa de novas chegadas

Tracks #54 e #34/P18. A configuração de servidor `CHECKIN_INTAKE_PAUSED=true`
rejeita pré-cadastro, confirmação e chegada sem código com HTTP 503 e uma
orientação pública para aguardar a Line. A configuração ausente ou `false`
preserva o comportamento anterior.

A pausa é conferida depois de autenticar a requisição e antes de reservar a
chave de idempotência ou executar a operação. Uma tentativa rejeitada pode ser
repetida depois da retomada. Durante a pausa, consultas e recuperação de código
continuam disponíveis. A expiração mantém seu comportamento próprio.

Esta configuração não desliga o módulo da fila nem muda o modo da integração.
Não modifica a seleção de placas chamadas ou a exigência de vínculo dos
lançamentos. Não substitui o planejamento de retorno de código e dados.

## Ativação e retomada

1. Com autorização para o ambiente, aplicar a configuração de servidor na
   revisão que contém esta implementação, preservando as demais configurações.
2. Conferir que todo o tráfego está na revisão configurada. Registrar horário e
   aguardar as requisições antigas terminarem antes de considerar a entrada
   interrompida. Uma revisão antiga ainda recebendo tráfego não aplica a pausa.
3. No ambiente de homologação, verificar os três caminhos de chegada, a
   mensagem exibida, a preservação dos dados do formulário, consultas e a fila
   interna. Confirmar ausência de novas visitas criadas pelas tentativas
   rejeitadas. Reconciliar operações iniciadas antes da pausa.
4. Para retomar, aplicar `false`, conferir a revisão em uso e repetir uma
   tentativa de teste. Conferir que só existe uma visita resultante.

## Limites

- Não cancela operações que já passaram pela verificação. Não é uma trava
  transacional global nem um botão instantâneo de emergência.
- Mesmo repetições de respostas já concluídas nos caminhos de chegada recebem
  503 durante a pausa; consulta/recuperação continuam disponíveis para conferir
  o resultado já registrado, e a idempotência permanece após a retomada.
- O recebimento de arquivos e o processamento documental têm ciclo próprio e
  não são interrompidos. Arquivos temporários seguem sua retenção existente.
- A mensagem é encaminhada pelo contrato de erro já usado pelo portal.
  Testes locais de handler não equivalem ao ensaio de interface e implantação.
- Não restaurar uma revisão incompatível com registros ou perfis já criados.
  Não excluir dados para simular um retorno.

Nenhuma ativação, implantação ou operação produtiva é autorizada por este
documento. O ensaio em homologação e a aprovação do pacote final são etapas
separadas do PR.
