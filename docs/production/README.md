# Pacote de preparação do check-in

Tracks #50 e #34, P07–P09. Estes arquivos são modelos para revisão, não um
provisionador. Nenhum arquivo desta pasta é carregado automaticamente pela aplicação.
A ativação depende do P10 (PR #49), do candidato integrado validado e da aprovação P21.

## Preencher e preservar

Copiar os modelos para uma pasta privada **fora do repositório**. Preencher os
marcadores `__...__` com o inventário confirmado do ambiente e registrar a origem
de cada valor. Não colocar valores de segredos nos arquivos: usar referências com
versão do Secret Manager. Guardar a pasta com modo 0700 e arquivos 0600.

Antes de qualquer aplicação, salvar a configuração atual dos backends, IAM com
etag/condições, índices, revisão e digest das imagens. Não exportar conteúdo dos
segredos nem dados dos motoristas. Guardar essas evidências fora do GitHub público.

| Modelo | Como usar |
| --- | --- |
| `system-env.patch.example.json` | Mesclar entradas por `variable` ao apphosting.yaml atual, preservando as demais configurações. Não substituir o arquivo inteiro. |
| `portal.apphosting.example.json` | Configuração do novo backend do portal, com limites de execução e referências de segredos. |
| `bucket.example.json` | Corpo de criação do bucket na API Storage, depois de confirmar projeto e disponibilidade do nome. |
| `worker.service.example.json` | Corpo Cloud Run v2 para o serviço documental. Projeto/região pertencem à URL da API. Não aplicar ao backend gerenciado pelo App Hosting. |
| `worker.scheduler.example.json` | Corpo de criação do Scheduler, somente depois de validar o worker e aprovar a ativação. |

JSON é usado para revisão estruturada; os dois arquivos App Hosting devem ser
convertidos para YAML ou serializados como JSON válido no arquivo `apphosting.yaml`
do pacote de implantação. Não renomear/copiar modelos com marcadores para produção.
O domínio, bucket e projeto preenchidos precisam coincidir com a política exata
do P10. O código rejeita valores diferentes, mesmo que o modelo os aceite.

## P07 — recursos e permissões

Criar apenas os recursos ausentes. Se um nome existir, comparar a configuração e
interromper diante de divergência; não sobrescrever por conveniência.

| Identidade | Recurso e acesso proposto |
| --- | --- |
| Sistema interno | Manter acesso Firebase existente; `roles/storage.objectUser` apenas no bucket documental; `roles/iam.serviceAccountTokenCreator` somente sobre sua própria conta assinante, para URLs temporárias. |
| Portal | Conta própria do backend; somente seus segredos de integração e Turnstile. Sem acesso direto ao Firestore ou ao bucket documental. |
| Worker | Conta própria; `roles/datastore.user` no banco necessário e `roles/storage.objectUser` no bucket documental. Sem segredo HMAC do portal. |
| Agendador | Conta própria distinta do worker; `roles/run.invoker` somente no serviço do worker. Sem permissões de dados ou de leitura de segredos. |

Conferir também permissões herdadas e grupos. Não atribuir Owner/Editor como atalho.
Permissões de build/App Hosting são separadas das permissões de negócio acima:
conferir a identidade efetiva do novo backend antes de conceder segredos. Se o
portal reutilizar a conta privilegiada do sistema, a separação ainda não está pronta.
Preservar o acesso dos agentes gerenciados necessário ao App Hosting e Scheduler.
Fazer alterações aditivas e específicas; nunca substituir toda a política IAM.

Gerar HMAC de integração e de índices independentes (pelo menos 32 caracteres),
somente na execução autorizada. Integração é compartilhada entre sistema e portal;
índices, somente com o sistema. Turnstile, somente com o portal. Preservar o segredo
de rate limit atual do sistema e seu identificador de versão. Não copiar valores
de staging ou publicar uma chave JSON de conta de serviço. Usar ADC da execução.

O bucket usa acesso uniforme, prevenção de acesso público e CORS apenas para PUT
das duas origens HTTPS exatas. Download ocorre por URL temporária autorizada.
O modelo desativa versionamento e soft delete para manter a política de remoção
física descrita no produto; esta decisão deve constar no pacote P21. Não aplicar
ao bucket existente de outro uso. Não criar retenção imutável nem regra de exclusão
por idade do objeto: o prazo é contado a partir do encerramento/troca da visita.
Recuperação de bytes apagados não é garantida por rollback de código ou backup
do Firestore. Qualquer política de cópia adicional deve ser explicitamente definida.

## P08 — portal e integração

1. Preparar backend próprio do portal com identidade própria e SHA aprovado.
   Desabilitar publicação automática até concluir o pacote de lançamento.
2. Cadastrar o domínio aprovado no App Hosting e obter **os registros DNS reais**
   indicados pelo serviço. Não adivinhar IP, CNAME ou token de verificação.
3. Aplicar somente os registros do novo subdomínio após aprovação. Preservar o
   domínio do sistema interno, MX e outros registros. Aguardar certificado válido.
4. Criar/configurar widget Turnstile para o hostname exato; usar chave de site em
   BUILD/RUNTIME e segredo somente em RUNTIME. Não usar chaves de teste em produção.
5. Conferir base URL, hostname, CORS, proxy Google e o mesmo identificador/versão
   do HMAC nos dois aplicativos. GPS deve usar a decisão registrada pelo responsável.
6. Preservar App Check, credenciais Firebase e rate limit atuais do sistema. Uma
   mudança de modo de proteção exige seu próprio aceite e validação, não está
   implícita na instalação do check-in.

Modelos mantêm check-in e documentos desligados. No pacote de **ativação aprovado**,
alterar no sistema `CHECKIN_SYSTEM_RECORD_ENABLED=true`,
`CHECKIN_INTEGRATION_MODE=enforce`, `CHECKIN_ENFORCE_ROLLOUT_APPROVED=true` e
`CHECKIN_DOCUMENTS_ENABLED=true`; no portal, recompilar com
`NEXT_PUBLIC_CHECKIN_DOCUMENTS_ENABLED=true`. Não ativar parcialmente para usuários.
`NEXT_PUBLIC_CHECKIN_ENVIRONMENT=production` retira o aviso de homologação.
Conferir recuperação, GPS, envio e a regra de placas Chamadas antes de liberar acesso.

## P09 — worker e agenda documental

1. Conferir APIs, região, Artifact Registry e identidade de build; preparar somente
   o contexto `infrastructure/checkin-documents` do candidato com P10 integrado.
   Ele precisa incluir `runtime_config.py`, além de Dockerfile, main.py, preview.py
   e requirements.txt. Não executar `scripts/homologation/*` em produção.
2. Construir e registrar digest imutável. Preencher `image` como `...@sha256:...`.
   Guardar origem SHA, resultado de build e varredura da imagem no pacote privado.
3. Comparar `firestore.indexes.json` com os índices existentes; criar somente os
   ausentes e aguardar READY. Não excluir índices nem configurar TTL sobre visitas
   ou histórico. Conferir dados legados e datas incertas no P17 antes da varredura.
4. Implantar worker com identidade/variáveis corretas, IAM obrigatório, CPU por
   requisição, concorrência 1 e máximo de uma instância. A URL HTTPS do serviço
   pode existir publicamente, mas uma chamada sem identidade autorizada deve falhar.
5. Conceder ao agendador apenas invocação no serviço. O operador que configurar o
   job precisa poder associar essa identidade; manter o agente gerenciado do
   Cloud Scheduler com seu papel próprio. Não usar a conta do worker como chamador.
6. Obter a URI canônica do serviço. Scheduler: POST em `URI/run`; OIDC audience
   igual à URI base, sem `/run`. O token é gerado pelo Google, sem bearer estático.
7. Validar uma execução controlada autorizada e só então criar/ativar a agenda
   de cinco minutos. Verificar execução efetiva, erros e efeitos esperados.

O worker preserva 90 × 24 horas para versões trocadas e 12 meses calendário UTC
após encerramento para o documento atual, conforme o runbook de retenção. Testar
limites com fixtures próprias em homologação; não envelhecer dados reais para testar.
Conferir histórico preservado, documento de outra visita intacto e rejeição de
download vencido. Resultado HTTP do Scheduler sozinho não comprova remoção física.

**Expiração de pré-cadastro é outro processo.** O endpoint do portal
`/api/cron/expire-checkins` exige bearer próprio; ele não aceita automaticamente o
OIDC deste worker. Não apontar a agenda documental para essa rota, nem afirmar que
ela foi agendada. Sua automação precisa de implantação e aceite separados se entrar
no pacote de lançamento; não colocar um segredo fixo no JSON do Scheduler.

## Conferência e retorno

O pacote P21 deve listar SHAs, digests, versões de segredos, destinatários IAM,
mudanças de DNS, custos/limites e a sequência de ativação. P07–P09 ficam em andamento
até comprovar a configuração no destino autorizado; arquivos preparados não bastam.

Antes da ativação: nenhum marcador `__...__`, segredo literal, referência a staging
ou emulador pode permanecer. Conferir as variáveis com o código do candidato.
Validar configuração dos backends, acesso por perfil, CORS, URLs temporárias,
assinatura de integração, invocação não autenticada negada e agenda autenticada.

Em falha: interromper novos envios e avaliar a pausa explícita da agenda, preservando
o acompanhamento de retenção. Restaurar revisão/digest e configurações anteriores
conforme P18. Não apagar dados, bucket, segredos ou histórico como rollback.
No primeiro deploy, não há digest anterior do worker: pausar a agenda e impedir
novos envios enquanto se corrige. Documentos já removidos não voltam com o rollback.

## Referências

- [Configuração e segredos App Hosting](https://firebase.google.com/docs/app-hosting/configure).
- [Domínio próprio](https://firebase.google.com/docs/app-hosting/custom-domain).
- [URLs assinadas e permissões Storage](https://docs.cloud.google.com/storage/docs/access-control/signing-urls-with-helpers).
- [Scheduler com Cloud Run](https://docs.cloud.google.com/run/docs/triggering/using-scheduler).
- [Soft delete](https://docs.cloud.google.com/storage/docs/soft-delete).
- [Retenção do produto](../CHECKIN_RETENCAO_RUNBOOK.md).
