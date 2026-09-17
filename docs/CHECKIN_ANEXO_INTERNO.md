# Notas fiscais na fila: complemento, substituição e histórico

Tracks [#33](https://github.com/caissara2dev/novo-transbordo/issues/33), itens NF-01 a NF-09; [PR #35](https://github.com/caissara2dev/novo-transbordo/pull/35). Esta etapa pertence à branch V2 de homologação. Não autoriza merge nem produção.

## Uso na fila

Uma visita confirmada com documento pendente apresenta **Anexar foto ou PDF** para admin, supervisor e analista aprovados e ativos. A equipe escolhe o arquivo e confirma em **Enviar nota**. O envio exibe progresso e permite retomar após falhas, preservando o arquivo e os campos da classificação.

Após a confirmação do servidor, a visita mostra o documento recebido, download do original e evento **Nota fiscal anexada**, com autor e horário, no histórico. Imagens recebem prévia assíncrona; PDFs mantêm o original. O recebimento não libera/chama, não altera o status operacional e não resolve outras pendências.

O complemento também é permitido em visitas encerradas, para correção pela Line. Clientes nunca recebem esta interface ou acesso ao documento. O complemento recusa documento já existente; para trocá-lo, use a ação explícita de substituição abaixo. Exclusão manual e expiração do documento atual após 12 meses seguem nas próximas entregas da issue #33.

## Substituição da nota recebida

No bloco **Nota fiscal**, selecione **Substituir documento**, escolha a foto/PDF e confirme **Substituir nota**. O arquivo atual continua disponível até o servidor validar e concluir o novo envio. Cancelar a seleção, falhar no envio ou encontrar conflito não troca a nota. Se a visita mudar durante a operação, confira a nova informação antes de iniciar outra troca.

A transação arquiva a versão anterior, vincula a nova à mesma visita e registra **Nota fiscal substituída** com autor, horário e nomes dos documentos. Não muda etapa operacional, pendências, cliente nem campos compartilhados. O rascunho da classificação permanece na tela; o recebimento não o salva implicitamente.

**Histórico dos documentos** consulta as versões anteriores sob demanda, em páginas de 20. Admin, supervisor e analista ativos/aprovados podem baixar o original durante 90 dias após a troca. Clientes não acessam essa consulta. A prévia exibida é vinculada ao ID do documento e não permanece mostrando a nota anterior depois da troca.

## Retenção de versões substituídas

Cada versão recebe prazo de 90 × 24 horas a partir da substituição confirmada, independente da conclusão da visita. Após o prazo, a API recusa downloads, inclusive antes da próxima execução de limpeza. Links assinados expiram em no máximo 60 segundos e nunca ultrapassam o vencimento da versão.

O worker remove somente original e prévia da versão vencida, usando suas gerações específicas. Confere vínculo à visita, objeto temporário já vinculado, caminhos esperados e ausência do documento entre os atuais; coordena a limpeza com jobs de prévia. Falha parcial mantém a operação retomável, sem declarar o arquivo removido antes da conclusão. Metadados textuais e auditoria permanecem. O documento atual não é removido por essa rotina; sua expiração de 12 meses e exclusão manual ainda são entregas próprias.

## Contrato e proteção

- `POST /api/checkins/{id}/document`: `begin` recebe `operationId` UUID, `expectedVersion`, nome e tamanho; `replaceDocumentId` é obrigatório para substituir e identifica o documento atual esperado. Sem ele, a operação só complementa pendência. Retorna sessão opaca e autorização de envio retomável para um objeto específico. `finalize` recebe `sessionId`.
- `GET /api/checkins/{id}/document?history=true[&cursor=ID]` retorna somente metadados do histórico. `GET ...?version=ID` autoriza download de uma versão da própria visita; `preview=true` continua disponível para prévias prontas.
- Arquivo direto ao Storage privado; 10.000.000 bytes, JPEG, PNG, HEIC/HEIF ou PDF. Conteúdo, tamanho real e geração do objeto são conferidos no servidor; extensão/MIME do navegador não bastam. PDF com conteúdo anexado após o marcador final é recusado.
- Sessão de uma hora vinculada ao usuário e à visita. Perfil é revalidado em transação antes da gravação; cota de 60 novas sessões por hora por usuário. Sessões internas não são aceitas pelas operações documentais públicas.
- Finalização atômica atualiza documento, versão, auditoria e vínculo temporário. Repetir uma confirmação recebida gera o mesmo documento e um único evento. Duas operações concorrentes não sobrescrevem a nota ou uma edição da visita.
- Originais preservados com SHA-256; prévia não é condição para confirmar recebimento. Temporários abandonados continuam compatíveis com a limpeza de 24 horas; sessões vinculadas não são removidas como temporárias.
- Alteração apenas documental pode avançar a versão do rascunho na tela; mudança concorrente de campos mantém o rascunho e exige revisão, conservando a proteção contra sobrescrita.

## Configuração de homologação

Preservar as guardas existentes, o bucket privado e as credenciais exclusivas de homologação. Acrescentar `CHECKIN_DOCUMENT_INTERNAL_ORIGIN` com a origem HTTPS exata do sistema. O CORS do bucket deve admitir essa origem em `PUT`, com `Content-Type`, `Content-Range` e `Range`, preservando a origem existente do portal. Não usar wildcard nem tornar o bucket público.

A entrega usa snapshot isolado do sistema e somente o target `checkin-system-nf`, projeto `line-transbordo-staging-382612`, região `us-central1`. Guardar revisão, digest, tráfego e configuração anteriores e atualizar CORS com precondição de metageneration. Não executar provisionamento geral, scripts que alteram usuários, nem deploy do portal. A entrega de retenção atualiza somente a imagem do worker por digest, com etag e máscara de containers, preservando `cpuIdle: true`, recursos, escala, tráfego, identidade, IAM e o agendamento de cinco minutos. Criar somente os dois índices de `_checkinDocumentVersions` declarados no manifesto; não remover índices existentes. O código conserva as restrições de staging; preparação de produção é uma entrega separada.

Rollback da aplicação: restaurar o rollout anterior do backend de homologação, conservando dados já gravados. Para o worker, restaurar o digest anterior preservado. O worker antigo não remove versões arquivadas: a limpeza fica suspensa até corrigir e reimplantar, sem apagar o histórico. A origem CORS adicional é compatível com a aplicação anterior; se necessário removê-la, alterar somente CORS, após reler metageneration. Evidências operacionais e configurações privadas ficam fora do GitHub.

## Validação

`npm run verify` cobre lint, tipos, índices, testes com emuladores, regras, E2E, build, bundle e auditorias. Os testes documentais verificam permissões/revogação, vínculo, conteúdo, expiração, conflito, repetição e auditoria. `tests/e2e/queue-invoice.spec.ts` cobre seleção, retomada, perda de resposta, rascunhos, histórico, perfis e tela estreita.

Após implantação, criar somente visita fictícia própria, anexar documento, recarregar, conferir auditoria e comparar o hash do original baixado. Observar a prévia de imagem pelo agendamento normal. Registrar resultado, commit e rollout na issue; teste local ou sucesso do comando de deploy não comprova homologação.

Os testes de `infrastructure/checkin-documents/test_*.py` cobrem prévias (incluindo HEIC e orientação) e retenção com relógio controlado. O teste de 90 dias não exige esperar esse prazo real: envelhecer somente uma versão fictícia própria na homologação permite comprovar a limpeza, sem alterar documentos do responsável. Evidências sanitizadas e estado de deploy são registrados na issue #33, não inferidos deste documento.
