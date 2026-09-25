# Processador de notas: CPU por requisição

Tracks #30. Pré-release planejada: `checkin-nf-staging.2026-09-15.1`.

Esta entrega corrige apenas a infraestrutura de homologação. Não representa o release completo do check-in, não modifica a aplicação em produção e não publica suas telas ou contratos documentais. O código existente do processador foi importado em um commit separado da correção.

## Causa e correção

O deploy especificava CPU/memória sem `resources.cpuIdle: true`. Na API v2, informar limites de recursos exige declarar esse campo explicitamente para preservar CPU por requisição. Com execuções periódicas, a instância permaneceu faturável entre chamadas.

O worker conclui a geração de prévias e a limpeza dentro de `POST /run`, antes da resposta HTTP. Portanto, não necessita de CPU após responder. A frequência atual do agendador pode ser preservada.

Referências: [ResourceRequirements](https://docs.cloud.google.com/run/docs/reference/rest/v2/Container), [PATCH/validateOnly](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services/patch).

## Limite operacional

A atualização deve atingir somente o serviço permitido pelo comando, usando credenciais locais já autorizadas. O comando recusa outro destino, configuração inesperada e atualização concorrente. A configuração anterior e os detalhes de revisão/tráfego ficam em evidência local privada, fora do Git.

- Simulação é o padrão; aplicação exige `--apply`.
- Validar o PATCH com `validateOnly` antes da aplicação.
- Alterar apenas CPU por requisição, preservando imagem, variáveis, probes, limites, escala, conta de serviço, IAM e agendador.
- Não executar os scripts de provisionamento/build/deploy completo para esta manutenção.
- Reexecução com configuração já correta deve encerrar sem nova revisão.

## Comandos

Requer Node.js 22, dependências do repositório e autenticação administrativa existente para o ambiente permitido. O comando não cria serviço ausente.

```sh
# Validação sem persistir configuração
node scripts/homologation/update-worker-billing.cjs

# Aplicação: escolher um diretório novo fora do Git para a evidência privada
node scripts/homologation/update-worker-billing.cjs --apply --evidence-dir=/caminho/privado/rollback

# Repetir a consulta: deve informar already-correct sem criar revisão
node scripts/homologation/update-worker-billing.cjs
```

A validação da API retorna uma representação temporária da operação; ela não deve ser consultada posteriormente como uma operação persistida. O comando confere a resposta inline e só acompanha a operação real de atualização.

## Critérios de aceite

- Testes de regressão da configuração, destino incorreto, conflitos e repetição.
- Testes de prévia: HEIC, orientação EXIF, dimensões, transparência e arquivo inválido.
- Verificação completa do repositório e revisão do PR.
- Nova revisão pronta com mesma imagem efetiva e tráfego atendido.
- Documento fictício com prévia pronta e hash do original preservado; dados existentes não são usados como fixture.
- Após estabilização, janela completa de uma hora, com baixo movimento, abaixo de 360 segundos faturáveis em todas as revisões do worker. Registrar quantidade de requisições e limites da comparação.

Instância viva não significa CPU faturada continuamente no modo por requisição. O gate mede tempo faturável; o faturamento financeiro pode demorar a refletir a alteração e depende de créditos e outros serviços.

## Rollback e publicação

Em regressão funcional atribuída à alteração, restaurar a configuração anterior do campo ou o tráfego para a revisão anterior, mantendo dados e permissões. Registrar que isso retoma temporariamente o consumo contínuo. Não reverter por simples atraso de métricas.

A tag e a pré-release só serão publicadas após aprovação explícita do responsável, com commit e evidências finais apresentados. O PR permanece separado da promoção para produção. Uma futura integração à main deve manter `cpuIdle: true` no deploy do worker e repetir o gate de configuração no ambiente de destino.

Credenciais, URLs de upload/download assinadas, dados de documentos e detalhes de faturamento ficam fora desta documentação pública.
