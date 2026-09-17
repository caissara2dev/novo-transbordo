# Fila — regras aprovadas e validação pelo computador

Tracks #34 / PR #35. Código nesta branch; consultar issue e PR para commit e implantação efetivamente validados. Testes em telefones, merge, release e produção continuam separados.

## Analista e equipe Line

1. O motorista faz check-in; a visita aparece sem cliente para a análise interna. A classificação ocorre antes da chegada à operação física.
2. Atribuir cliente e editar Booking, Amostra e Observação exige **Salvar alterações**. Isso não libera automaticamente. Limites: 100, 100 e 300 caracteres. Valores antigos maiores não são cortados: podem permanecer intactos, mas ao editar aquele campo o novo valor deve atender ao limite.
3. **Adicionar pendência**, resolver, reabrir ou excluir salva imediatamente. Excluir pede confirmação sem motivo. Descrição e autoria permanecem no histórico. Nenhuma dessas ações salva ou descarta os outros campos em edição.
4. A nota fiscal pode ser anexada, substituída ou baixada por admin, supervisor e analista. Exclusão é exclusiva de admin/supervisor, com motivo. A operação documental mantém rascunhos; alterações concorrentes continuam visíveis e não são sobrescritas silenciosamente.
5. Sem cliente, com pendência aberta ou sem documento válido, a liberação/chamada fica bloqueada. Amostra é texto livre; `OK` não muda a etapa.
6. **Chamar motorista** grava a chamada primeiro. Após sucesso, abre WhatsApp com nome e placa. O envio continua manual. Se o navegador bloquear, usar **Abrir WhatsApp**; telefone inválido pede correção ou contato por outro meio. O sistema não afirma que uma mensagem foi enviada.

A busca aceita placa com hífen, espaços e letras minúsculas. Nome, booking, código e filtros continuam disponíveis. A localização é somente o ponto e horário do check-in, visível à Line.

## Usuários e Clientes

Somente administrador gerencia acessos. Em **Clientes**, os parâmetros **Acesso ao portal** e **Usa amostra** pertencem à empresa. Desabilitar amostra não apaga textos anteriores nem altera a liberação; a Line continua editando os três campos.

Em **Usuários**, escolher Analista ou Cliente e vincular a empresa configura o perfil. A aprovação é outra ação: selecionar um perfil não aprova a conta. A verificação de e-mail continua necessária. O usuário cliente só acessa a empresa vinculada e os três campos compartilhados. Alterações simultâneas dos cadastros geram conflito; atualizar e conferir antes de repetir. O endereço antigo **Acessos da fila** redireciona para Usuários.

## Lançamento

No lançamento produtivo, as visitas chamadas elegíveis aparecem no próprio campo **Placa ou container de origem**, identificadas por placa, cliente e código. Selecionar uma delas preenche cliente e mantém internamente ID e versão. Editar origem ou trocar cliente/categoria desfaz a seleção anterior.

O servidor confere novamente placa, cliente, versão, etapa, documento e pendências no salvamento. Apenas um lançamento salvo passa a visita para **Em descarga**. Falhas mantêm a visita fora dessa etapa. Transferências entre containers permanecem no mesmo campo; integração `off`, `observe` e `enforce` conserva suas respectivas regras. `enforce` exige vínculo em carga de carreta; `observe` permite origem manual, e `off` não disponibiliza vínculos.

## Roteiro curto — somente dados fictícios

- Digitar um Booking sem salvar; adicionar, resolver, reabrir e excluir uma pendência. Conferir que o Booking continua em edição e as pendências já aparecem após recarregar em outra consulta.
- Procurar a mesma placa formatada e sem formatação. Conferir os contadores dos três campos.
- Anexar/substituir nota com Observação em rascunho. Conferir os dois históricos e a ausência de liberação automática. Para exclusão e vencimento, seguir o roteiro documental próprio.
- Com administrador, configurar uma empresa fictícia e um usuário de teste. Confirmar perfil sem aprovação automática e isolamento entre empresas. Não alterar contas reais durante os testes.
- Chamar uma visita fictícia e conferir a conversa preenchida. **Não enviar a mensagem** durante homologação. Conferir que erro de gravação não abre WhatsApp.
- Selecionar a placa no lançamento, trocar a origem e confirmar que o vínculo antigo desaparece. Em novo lançamento válido, salvar e conferir **Em descarga**; em falha, conferir etapa preservada. Repetir o cenário de transferência entre containers.

Registros e arquivos de homologação do responsável não devem ser excluídos para testar retenção. A restauração do software não recupera arquivos fisicamente removidos.
