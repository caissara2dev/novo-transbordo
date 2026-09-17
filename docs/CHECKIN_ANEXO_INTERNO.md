# Notas fiscais na fila: complemento, substituição, exclusão e retenção

Tracks [#33](https://github.com/caissara2dev/novo-transbordo/issues/33), com os registros de implementação e validação de cada etapa; [PR #35](https://github.com/caissara2dev/novo-transbordo/pull/35). Esta etapa pertence à branch V2 de homologação. Não autoriza merge nem produção.

A etapa de exclusão manual e expiração do documento atual foi implantada em homologação em 17/09/2026: sistema `build-2026-09-17-003` e worker `checkin-document-worker-00005-nrh`, código `c8a2e3d`. Os resultados e limites de validação são mantidos na issue #33/PR #35; implantação não equivale a aceite operacional nem a publicação em produção.

## Uso na fila

Uma visita confirmada com documento pendente apresenta **Anexar foto ou PDF** para admin, supervisor e analista aprovados e ativos. A equipe escolhe o arquivo e confirma em **Enviar nota**. O envio exibe progresso e permite retomar após falhas, preservando o arquivo e os campos da classificação.

Após a confirmação do servidor, a visita mostra o documento recebido, download do original e evento **Nota fiscal anexada**, com autor e horário, no histórico. Imagens recebem prévia assíncrona; PDFs mantêm o original. O recebimento não libera/chama, não altera o status operacional e não resolve outras pendências.

O complemento e a substituição também são permitidos em visitas encerradas antes do vencimento documental, para correção pela Line; receber outro arquivo não reinicia o prazo da visita. Clientes nunca recebem esta interface ou acesso ao documento. O complemento recusa documento já existente; para trocá-lo, use a ação explícita de substituição abaixo. Após o vencimento, novos envios e autorizações de download da nota atual são recusados; o histórico textual permanece.

## Substituição da nota recebida

No bloco **Nota fiscal**, selecione **Substituir documento**, escolha a foto/PDF e confirme **Substituir nota**. O arquivo atual continua disponível até o servidor validar e concluir o novo envio. Cancelar a seleção, falhar no envio ou encontrar conflito não troca a nota. Se a visita mudar durante a operação, confira a nova informação antes de iniciar outra troca.

A transação arquiva a versão anterior, vincula a nova à mesma visita e registra **Nota fiscal substituída** com autor, horário e nomes dos documentos. Não muda etapa operacional, pendências, cliente nem campos compartilhados. O rascunho da classificação permanece na tela; o recebimento não o salva implicitamente.

**Histórico dos documentos** consulta as versões anteriores sob demanda, em páginas de 20. Admin, supervisor e analista ativos/aprovados podem baixar o original durante 90 dias após a troca. Clientes não acessam essa consulta. A prévia exibida é vinculada ao ID do documento e não permanece mostrando a nota anterior depois da troca.

## Retenção de versões substituídas

Cada versão recebe prazo de 90 × 24 horas a partir da substituição confirmada, independente da conclusão da visita. Após o prazo, a API recusa downloads, inclusive antes da próxima execução de limpeza. Links assinados expiram em no máximo 60 segundos e nunca ultrapassam o vencimento da versão.

O worker remove somente original e prévia da versão vencida, usando suas gerações específicas. Confere vínculo à visita, objeto temporário já vinculado, caminhos esperados e ausência do documento entre os atuais; coordena a limpeza com jobs de prévia. Falha parcial mantém a operação retomável, sem declarar o arquivo removido antes da conclusão. Metadados textuais e auditoria permanecem. Essa regra de 90 dias continua independente da regra de 12 meses aplicada ao documento atual. Uma solicitação manual válida pode antecipar a remoção, sem modificar o prazo original para simular uma expiração.

## Exclusão manual e documento atual

Somente admin e supervisor ativos/aprovados podem solicitar exclusão de uma versão exata, informando um motivo de até 300 caracteres. Analista pode anexar, substituir e baixar; não pode excluir. A requisição revalida o perfil, a versão da visita e o documento esperado. Repetir a mesma operação não cria outra exclusão.

Ao excluir o documento atual, a transação o destaca para o histórico com `kind=manual-deletion`, `state=deletion-requested` e marcador com solicitante/motivo; a visita fica com `document.current=null`, `document.status=pending`, versão incrementada e auditoria. O status operacional permanece inalterado. A exclusão de versão antiga preserva o documento atual e seu prazo original de 90 dias.

A indisponibilidade na API ocorre na solicitação. A remoção física é assíncrona, pelo worker: somente depois de remover original e prévia a versão recebe `state=deleted` e o evento **Arquivo da nota fiscal removido**. Falha parcial permanece retomável. URLs assinadas já emitidas podem permanecer válidas por seu prazo residual, de no máximo 60 segundos; solicitar exclusão não recolhe arquivos que alguém já baixou.

## Expiração do atual após 12 meses

O marco é a conclusão/cancelamento confirmado, registrado em `closedAtIso`. `documentExpiresAtIso` corresponde a 12 meses de calendário em UTC: 29/02 passa a 28/02 no ano seguinte, conservando horário e milissegundos. O prazo não conta a partir do upload, de outra edição ou de uma substituição.

A API bloqueia novas autorizações de leitura e novos envios na data limite. O worker consulta visitas terminais com prazo vencido e `documentRetentionReviewRequired=false`; em transação, confere novamente as datas, vínculo, versão e ausência de operação oficial pendente. Destaca a nota para o histórico com `kind=current-expiration`, mantém os metadados e registra **Nota fiscal expirada**, sem alterar a etapa operacional. A limpeza usa gerações exatas, respeita prévias em andamento e registra a finalização uma única vez.

Visitas antigas sem marco comprovado não recebem uma data estimada. O backfill usa somente revisões que comprovem a transição terminal; casos inconclusivos recebem `documentRetentionReviewRequired=true` e exigem conferência. Ver [runbook de retenção](CHECKIN_RETENCAO_RUNBOOK.md) e [roteiro desktop](CHECKIN_DOCUMENTOS_ROTEIRO_DESKTOP.md).

## Contrato e proteção

- `POST /api/checkins/{id}/document`: `begin` recebe `operationId` UUID, `expectedVersion`, nome e tamanho; `replaceDocumentId` é obrigatório para substituir e identifica o documento atual esperado. Sem ele, a operação só complementa pendência. Retorna sessão opaca e autorização de envio retomável para um objeto específico. `finalize` recebe `sessionId`.
- `POST /api/checkins/{id}/document`: a ação `delete` recebe `operationId`, `documentId`, `expectedVersion` e `reason`; retorna a visita e `deletionRequested=true`. Isso confirma a solicitação, não a remoção física.
- `GET /api/checkins/{id}/document?history=true[&cursor=ID]` retorna somente metadados do histórico. `GET ...?version=ID` autoriza download de uma versão da própria visita; `preview=true` continua disponível para prévias prontas.
- Arquivo direto ao Storage privado; 10.000.000 bytes, JPEG, PNG, HEIC/HEIF ou PDF. Conteúdo, tamanho real e geração do objeto são conferidos no servidor; extensão/MIME do navegador não bastam. PDF com conteúdo anexado após o marcador final é recusado.
- Sessão de uma hora vinculada ao usuário e à visita. Perfil é revalidado em transação antes da gravação; cota de 60 novas sessões por hora por usuário. Sessões internas não são aceitas pelas operações documentais públicas.
- Finalização atômica atualiza documento, versão, auditoria e vínculo temporário. Repetir uma confirmação recebida gera o mesmo documento e um único evento. Duas operações concorrentes não sobrescrevem a nota ou uma edição da visita.
- Originais preservados com SHA-256; prévia não é condição para confirmar recebimento. Temporários abandonados continuam compatíveis com a limpeza de 24 horas; sessões vinculadas não são removidas como temporárias.
- Alteração apenas documental pode avançar a versão do rascunho na tela; mudança concorrente de campos mantém o rascunho e exige revisão, conservando a proteção contra sobrescrita.

## Configuração de homologação

Preservar as guardas existentes, o bucket privado e as credenciais exclusivas de homologação. Acrescentar `CHECKIN_DOCUMENT_INTERNAL_ORIGIN` com a origem HTTPS exata do sistema. O CORS do bucket deve admitir essa origem em `PUT`, com `Content-Type`, `Content-Range` e `Range`, preservando a origem existente do portal. Não usar wildcard nem tornar o bucket público.

A entrega usa snapshot isolado do sistema e somente o target `checkin-system-nf`, projeto `line-transbordo-staging-382612`, região `us-central1`. Guardar revisão, digest, tráfego e configuração anteriores e atualizar CORS com precondição de metageneration. Não executar provisionamento geral, scripts que alteram usuários, nem deploy do portal. A entrega de retenção atualiza somente a imagem do worker por digest, com etag e máscara de containers, preservando `cpuIdle: true`, recursos, escala, tráfego, identidade, IAM e o agendamento de cinco minutos. Criar os índices documentais declarados no manifesto, incluindo a varredura de visitas terminais por prazo; não remover índices existentes. O código conserva as restrições de staging; preparação de produção é uma entrega separada.

Rollback da aplicação: restaurar o rollout anterior do backend de homologação, conservando dados já gravados. Para o worker, restaurar o digest anterior preservado. O worker da etapa anterior mantém a rotina de 90 dias, mas não processa a nova expiração de 12 meses nem as novas solicitações manuais. Restaurar código não recupera bytes já removidos. Conferir o [runbook](CHECKIN_RETENCAO_RUNBOOK.md) antes do rollback. A origem CORS adicional é compatível com a aplicação anterior; se necessário removê-la, alterar somente CORS, após reler metageneration. Evidências operacionais e configurações privadas ficam fora do GitHub.

## Validação

`npm run verify` cobre lint, tipos, índices, testes com emuladores, regras, E2E, build, bundle e auditorias. Os testes documentais verificam permissões/revogação, vínculo, conteúdo, expiração, conflito, repetição e auditoria. `tests/e2e/queue-invoice.spec.ts` cobre seleção, retomada, perda de resposta, rascunhos, histórico, perfis e tela estreita.

Após implantação, criar somente visita fictícia própria, anexar documento, recarregar, conferir auditoria e comparar o hash do original baixado. Observar a prévia de imagem pelo agendamento normal. Registrar resultado, commit e rollout na issue; teste local ou sucesso do comando de deploy não comprova homologação.

Os testes de `infrastructure/checkin-documents/test_*.py` cobrem prévias (incluindo HEIC e orientação), exclusão manual, 90 dias e 12 meses com relógio controlado. Os testes de `document-retention` e `backfill-document-closure` verificam calendário, simulação, proveniência das datas, precondição de escrita e conflito. O teste de 90 dias não exige esperar esse prazo real: envelhecer somente uma versão fictícia própria na homologação permite comprovar a limpeza, sem alterar documentos do responsável. Evidências sanitizadas e estado de deploy são registrados na issue #33, não inferidos deste documento.

Evidências locais da nova etapa: `outputs/checkin-final-alignment-2026-09-17/`, no workspace TRANSBORDO. Não publicar credenciais, documentos reais, URLs assinadas ou configurações privadas no GitHub.
