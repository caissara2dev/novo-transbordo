# Runbook documental: retenção, exclusão e recuperação operacional

Tracks [issue #33](https://github.com/caissara2dev/novo-transbordo/issues/33) e [PR #35](https://github.com/caissara2dev/novo-transbordo/pull/35). Etapa implantada em homologação em 17/09/2026; consultar esses registros para as evidências e limitações atuais. Merge, release e produção continuam separados.

## Política e execução

| Documento | Marco e prazo | Disponibilidade / limpeza |
|---|---|---|
| Atual | 12 meses calendário UTC após `closedAtIso`; clamp de 29/02 | API bloqueia no limite; worker destaca o recibo e remove os objetos |
| Substituído | 90 × 24 horas após a troca | API bloqueia no limite; worker remove original e prévia |
| Exclusão solicitada | Solicitação por admin/supervisor, com motivo | API deixa de emitir acesso; worker remove os objetos de forma assíncrona |
| Data antiga incerta | Sem prazo inferido por conveniência | `documentRetentionReviewRequired=true`; conferência necessária |

O agendamento existente roda a cada cinco minutos. Uma solicitação pode exigir outra execução se houver prévia com lease ativo, erro de Storage ou remoção parcial. O histórico textual não depende da existência dos objetos.

`deletion-requested` significa solicitação registrada; `deleting`, operação em processamento/repetição; `deleted`, remoção física confirmada. Nunca apresentar apenas o sucesso da API como confirmação de eliminação física. Prévia atrasada não pode recolocar um arquivo removido.

## Preparar datas antigas

Executar da raiz do checkout, com credenciais administrativas já autorizadas para o projeto de homologação. O script recusa outro projeto e não altera objetos do Storage.

```sh
node scripts/homologation/backfill-document-closure.cjs --dry-run
```

Conferir `backfill`, `review`, `eligibleForExpiration` e `nextCursor`. O último permite continuar em lotes de até 500 visitas, com `--start-after=UUID`. `eligibleForExpiration` conta notas atuais que passariam a ser elegíveis à remoção pelo worker depois da aplicação das datas. Antes de aplicar, verificar se esses casos são os esperados no ambiente autorizado.

```sh
node scripts/homologation/backfill-document-closure.cjs --apply --project=line-transbordo-staging-382612
```

A aplicação relê visita e revisões na transação, usa precondição da atualização e registra auditoria. Conflito aborta sem sobrescrever. Uma revisão deve comprovar a transição para a situação terminal atual e suas versões; `PRE_REGISTRATION_EXPIRED` é aceito somente com o marcador de expiração correspondente. Ambiguidade, histórico incompleto e datas existentes inconsistentes exigem revisão. `updatedAtIso` nunca é tratado como data de conclusão.

## Implantar e comprovar

1. Confirmar commit, testes, projeto, backend e revisão atuais; salvar as configurações e digests anteriores em evidência privada.
2. Preparar os índices documentais do manifesto sem remover índices existentes. O índice da nova expiração contém status, status documental, flag de conferência e prazo.
3. Avaliar/aplicar o backfill autorizado antes de habilitar a varredura para legados. A nova API grava os marcos nos encerramentos futuros.
4. Implantar o backend e imagem do worker exclusivamente na homologação. Preservar `cpuIdle: true`, recursos, escala, IAM, bucket privado e agendamento.
5. Testar em visita fictícia própria: exclusão manual, expiração exata de 12 meses, 90 dias, conflito, download recusado e leitura do histórico após remoção. Datas envelhecidas são permitidas somente nesses registros de teste próprios.
6. Confirmar ausência das gerações específicas dos objetos, permanência do recibo textual e dos eventos; conferir que outra visita e seu documento atual continuam íntegros.

Os testes locais com relógio controlado não substituem essa comprovação no ambiente. Evidências ficam em `outputs/checkin-final-alignment-2026-09-17/`, no workspace; publicar somente resultados sanitizados na issue/PR.

## Falha e rollback

Para conter uma falha da nova lógica, restaurar o digest anterior do worker e o rollout anterior do backend, com a configuração preservada e atualização condicionada ao estado atual. O worker anterior conserva a limpeza de 90 dias, mas não conclui as novas solicitações manuais ou a expiração atual de 12 meses. Conferir os registros `deletion-requested`/`deleting` antes de retomar a nova revisão.

**Rollback de software não recupera arquivos já excluídos.** O recibo e a auditoria permitem explicar a remoção, mas não reconstruir a foto/PDF. Não apagar o histórico para ocultar um erro. Recuperação de conteúdo depende de uma cópia independente comprovadamente disponível; não presumir que backup de Firestore contém os bytes do Storage.

Não modificar datas para contornar uma falha, não apagar metadados para forçar repetição e não restaurar um recibo removido como documento atual sem uma operação própria autorizada. A retomada normal preserva as gerações, o token da execução e a idempotência.
