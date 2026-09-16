# Procedimento de mudanças — TransbordoLine

Acordado com o responsável pelo projeto em 15/09/2026. Aplica-se a funcionalidades, correções, infraestrutura, documentação e releases. O objetivo é que cada mudança tenha início, responsável, escopo, evidência e fim, sem depender do histórico de um chat.

## 1. Entrada: entender e registrar

Antes de alterar o sistema, identificar o repositório, estado da branch, alterações locais, ambiente alvo e autorização existente. Consultar issues, PRs e releases atuais; não inferir o estado pelo histórico de uma conversa.

Investigações somente de leitura podem preceder uma issue. Ao virar trabalho de alteração, abrir uma issue ou vincular a demanda a uma existente. Ajustes pequenos do mesmo escopo pertencem à mesma issue; não criar uma issue por arquivo ou commit.

A issue deve conter:

- Problema ou necessidade e resultado esperado.
- Escopo incluído e exclusões relevantes.
- Ambiente: local, homologação ou produção.
- Critérios de aceite verificáveis e plano de testes proporcional à mudança.
- Dependências, riscos, rollback e ações que precisam de aprovação.
- Links da branch, PR e evidências à medida que existirem.

Usar os labels do repositório. Associar ao milestone quando houver uma entrega programada. Uma pré-release de homologação deve estar identificada como tal e não deve ser confundida com a versão estável.

## 2. Preparação: branch e plano

Criar branch `codex/<tipo>-<descricao>` a partir da `main` remota atualizada, salvo base diferente explicitamente necessária e registrada. Usar um checkout/worktree separado quando houver trabalho local em andamento. Não apagar branches nem descartar, sobrescrever ou incluir alterações alheias.

Uma branch atende a uma issue ou a um conjunto de issues inseparáveis. Registrar a base e o motivo de qualquer dependência entre branches. Se componentes existentes ainda não estiverem versionados, separar sua importação da correção em commits distintos.

Definir a sequência de implementação, validação, implantação autorizada e aprovação final. Não exigir um documento de planejamento extenso para uma mudança simples.

## 3. Execução: mudanças pequenas e rastreáveis

Usar commits focados com Conventional Commits e referência à issue. Alterações de comportamento, dependências, refatorações e documentação devem ser separáveis para revisão quando tiverem motivos distintos.

Para bugs, registrar a evidência da causa e acrescentar teste de regressão quando houver uma forma adequada de reproduzir o problema. Para infraestrutura, conferir o ambiente e a configuração atual, preferir simulação e atualização restrita e guardar referência de rollback.

Ajustes documentais não exigem testes de aplicação sem relação com o conteúdo; verificar links, consistência e diff. Para código e infraestrutura, executar os gates aplicáveis e os checks obrigatórios do repositório. Nunca reduzir cobertura, auditoria ou segurança para obter aprovação artificial.

Não alterar produção, dados de negócio ou permissões por conveniência. Não ampliar o escopo para resolver problemas não relacionados: registrar uma demanda separada ou explicar a dependência antes de seguir.

## 4. Revisão: pull request

Abrir PR vinculado à issue. Usar rascunho enquanto houver implementação, validação ou decisões pendentes. O PR deve explicar o problema, a mudança final, como testar, resultados obtidos, ambiente validado, riscos e rollback.

Usar `Tracks #N` quando o merge não concluir toda a entrega. Usar `Closes #N` somente se o merge realmente satisfizer todos os critérios da issue. Issues de release ou de implantação não devem fechar antes da validação do ambiente prometido.

Conferir o diff completo, CI e revisões do commit atual. Distinguir revisão solicitada, ignorada, pendente e concluída. Corrigir achados relevantes ou registrar explicitamente uma pendência aceita pelo responsável; não declarar um gate aprovado sem evidência.

O GitHub pode ser público. Publicar somente código e evidências adequados a esse público. Segredos, tokens, documentos reais, dados pessoais, URLs assinadas e detalhes internos sensíveis ficam em evidência privada local. Não copiar logs inteiros sem revisão.

## 5. Homologação e aprovação de publicação

Validar exclusivamente no ambiente autorizado, com dados fictícios sempre que possível. Confirmar o resultado persistido e o comportamento real, não apenas o retorno de sucesso de um comando.

Quando houver critério de desempenho, custo ou observação temporal, medir a janela combinada e registrar seu início, fim e limitações. Não substituir evidência por estimativa. Se o prazo ainda não terminou, a validação está pendente.

Antes de solicitar aprovação de release, apresentar um pacote concreto:

- Issue e PR, commit exato e estado dos checks.
- Alterações incluídas e pendências restantes.
- Evidências dos testes e da homologação.
- Tag/versão proposta, notas da release e ambiente de destino.
- Passos de publicação e referência de rollback.

Pedir aprovação antes de criar a tag ou publicar release quando essa etapa estiver reservada ao responsável. Merge e deploy também precisam estar cobertos pela autorização existente; aprovação de homologação não autoriza produção. Não repetir perguntas para ações já autorizadas.

Uma pré-release pode registrar um commit de homologação sem merge na main, se esse for o plano aprovado. Não a marcar como versão estável mais recente. A promoção futura para produção continua sendo uma etapa própria.

## 6. Encerramento: comprovar e deixar continuidade

Após a ação aprovada, verificar o resultado real: revisão implantada, ambiente, tráfego, smoke test e ausência de regressões pertinentes. Confirmar separadamente commit, merge, tag, GitHub Release e deploy; um não comprova o outro.

Atualizar issue e PR com resultados, links e pendências. Fechar a issue somente quando seus critérios de aceite estiverem cumpridos, ou quando houver cancelamento explícito com justificativa. Se uma parte for adiada, criar ou vincular acompanhamento antes de encerrar a entrega original, com aceite do novo escopo.

Não encerrar nem excluir uma branch com trabalho não integrado. A limpeza de branches/worktrees só ocorre depois de confirmar que o trabalho está preservado e que a exclusão está autorizada.

Ao terminar ou interromper uma tarefa, registrar:

- O que foi concluído e onde.
- O que não foi concluído e por quê.
- Issue, branch, PR e commit atuais.
- Testes e ambiente efetivamente validados.
- Próxima ação concreta e quem precisa agir.

"Implementado localmente", "em homologação", "aguardando aprovação", "publicado" e "encerrado" são estados diferentes. Nunca chamar uma entrega de concluída se uma etapa obrigatória ainda falta.

## Checklist breve por demanda

- [ ] Issue criada ou existente vinculada; escopo e aceite definidos.
- [ ] Checkout, remoto, base e ambiente conferidos; trabalho anterior preservado.
- [ ] Branch e commits focados.
- [ ] Testes e documentação pertinentes concluídos.
- [ ] PR vinculado, diff revisado e checks verificados.
- [ ] Homologação e evidências obtidas, quando aplicável.
- [ ] Aprovação de publicação registrada, quando exigida.
- [ ] Publicação validada, ou estado pendente explicitamente registrado.
- [ ] Issue encerrada com evidências, ou continuidade documentada.
