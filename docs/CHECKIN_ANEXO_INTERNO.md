# Complemento de nota pendente pela Line

Tracks [#33](https://github.com/caissara2dev/novo-transbordo/issues/33), itens NF-01 a NF-04; [PR #35](https://github.com/caissara2dev/novo-transbordo/pull/35). Esta etapa pertence à branch V2 de homologação. Não autoriza merge nem produção.

## Uso na fila

Uma visita confirmada com documento pendente apresenta **Anexar foto ou PDF** para admin, supervisor e analista aprovados e ativos. A equipe escolhe o arquivo e confirma em **Enviar nota**. O envio exibe progresso e permite retomar após falhas, preservando o arquivo e os campos da classificação.

Após a confirmação do servidor, a visita mostra o documento recebido, download do original e evento **Nota fiscal anexada**, com autor e horário, no histórico. Imagens recebem prévia assíncrona; PDFs mantêm o original. O recebimento não libera/chama, não altera o status operacional e não resolve outras pendências.

O complemento também é permitido em visitas encerradas, para correção pela Line. Clientes nunca recebem esta interface ou acesso ao documento. Esta operação recusa documento já existente; substituição, exclusão e retenção seguem nas próximas entregas da issue #33.

## Contrato e proteção

- `POST /api/checkins/{id}/document`: `begin` recebe `operationId` UUID, `expectedVersion`, nome e tamanho; retorna sessão opaca e autorização de envio retomável para um objeto específico. `finalize` recebe `sessionId`.
- Arquivo direto ao Storage privado; 10.000.000 bytes, JPEG, PNG, HEIC/HEIF ou PDF. Conteúdo, tamanho real e geração do objeto são conferidos no servidor; extensão/MIME do navegador não bastam. PDF com conteúdo anexado após o marcador final é recusado.
- Sessão de uma hora vinculada ao usuário e à visita. Perfil é revalidado em transação antes da gravação; cota de 60 novas sessões por hora por usuário. Sessões internas não são aceitas pelas operações documentais públicas.
- Finalização atômica atualiza documento, versão, auditoria e vínculo temporário. Repetir uma confirmação recebida gera o mesmo documento e um único evento. Duas operações concorrentes não sobrescrevem a nota ou uma edição da visita.
- Originais preservados com SHA-256; prévia não é condição para confirmar recebimento. Temporários abandonados continuam compatíveis com a limpeza de 24 horas; sessões vinculadas não são removidas como temporárias.
- Alteração apenas documental pode avançar a versão do rascunho na tela; mudança concorrente de campos mantém o rascunho e exige revisão, conservando a proteção contra sobrescrita.

## Configuração de homologação

Preservar as guardas existentes, o bucket privado e as credenciais exclusivas de homologação. Acrescentar `CHECKIN_DOCUMENT_INTERNAL_ORIGIN` com a origem HTTPS exata do sistema. O CORS do bucket deve admitir essa origem em `PUT`, com `Content-Type`, `Content-Range` e `Range`, preservando a origem existente do portal. Não usar wildcard nem tornar o bucket público.

A entrega usa snapshot isolado do sistema e somente o target `checkin-system-nf`, projeto `line-transbordo-staging-382612`, região `us-central1`. Guardar revisão, digest, tráfego e configuração anteriores e atualizar CORS com precondição de metageneration. Não executar provisionamento geral, scripts que alteram usuários, nem deploy do portal/worker. O código conserva as restrições de staging; preparação de produção é uma entrega separada.

Rollback da aplicação: restaurar o rollout anterior do backend de homologação, conservando dados já gravados. A origem CORS adicional é compatível com a aplicação anterior; se necessário removê-la, alterar somente CORS, após reler metageneration. Evidências operacionais e configurações privadas ficam fora do GitHub.

## Validação

`npm run verify` cobre lint, tipos, índices, testes com emuladores, regras, E2E, build, bundle e auditorias. Os testes documentais verificam permissões/revogação, vínculo, conteúdo, expiração, conflito, repetição e auditoria. `tests/e2e/queue-invoice.spec.ts` cobre seleção, retomada, perda de resposta, rascunhos, histórico, perfis e tela estreita.

Após implantação, criar somente visita fictícia própria, anexar documento, recarregar, conferir auditoria e comparar o hash do original baixado. Observar a prévia de imagem pelo agendamento normal. Registrar resultado, commit e rollout na issue; teste local ou sucesso do comando de deploy não comprova homologação.
