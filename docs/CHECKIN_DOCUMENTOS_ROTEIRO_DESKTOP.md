# Roteiro desktop: documentos da fila

Estado desta nova etapa: implementação local em validação. Executar em homologação somente depois de confirmar a revisão implantada. Use visitas fictícias próprias; não substitua/exclua arquivos enviados pelo responsável em seus testes anteriores.

## Complementar e substituir

1. Com perfil Analista de teste ativo/aprovado, abra uma visita pendente na fila. Digite um booking sem salvar; selecione uma foto/PDF e envie a nota. Confira o rascunho preservado, documento recebido e evento com autor/horário.
2. Recarregue a visita. Confira persistência da nota e do evento. Baixe o original e compare com o arquivo enviado.
3. Selecione **Substituir documento**. Cancele a seleção: a nota atual deve continuar igual. Repita com outro arquivo válido e confirme.
4. Confira o novo original, prévia correspondente e versão anterior no histórico. A troca não deve liberar, chamar, resolver pendências ou salvar automaticamente os outros campos.
5. Abra a mesma visita em outra aba, faça uma alteração de teste e tente concluir uma troca iniciada na primeira aba. Deve haver conflito claro, preservando o rascunho e sem sobrescrever a nota nova.

## Excluir

1. Com Analista, confirme ausência de permissão de exclusão. A API também deve recusar uma tentativa desse perfil; esconder o botão não basta.
2. Com um perfil de teste Admin/Supervisor autorizado, selecione a exclusão de uma nota fictícia. Confira identificação da visita/arquivo e motivo obrigatório. Cancele antes de confirmar: nenhum dado deve mudar.
3. Confirme com motivo. A nota atual deve sair da visita e aparecer como exclusão solicitada no histórico. A etapa operacional continua igual; uma visita pendente de liberação volta a precisar de documento para ser liberada/chamada.
4. Recarregue. O pedido, autor e motivo devem persistir. O novo pedido de download deve ser recusado. Uma URL assinada emitida antes pode ter validade residual de até 60 segundos.
5. Depois do worker, confira estado removido e evento de finalização. O texto do histórico permanece. Repita com uma versão antiga: o documento atual deve continuar intacto.

Não altere o perfil de uma conta existente por conveniência. Use os perfis de homologação preparados para o roteiro.

## Expiração e limites

A equipe técnica usa relógio controlado nos testes e registros fictícios próprios na homologação para representar 90 dias e 12 meses. Conferir antes/no limite, 29/02, conclusão e cancelamento, prazo desconhecido, prévia em andamento e falha parcial seguida de retomada. Nenhum desses cenários requer envelhecer ou apagar uma nota real do usuário.

Por fim, confirme no desktop e em janela estreita que os campos/ações ficam acessíveis, o original corresponde à visita escolhida, o cliente não vê notas e o histórico permanece após a remoção. Registrar resultado observado, navegador, commit/revisão e limitações em `outputs/checkin-final-alignment-2026-09-17/`, preservando dados privados.
