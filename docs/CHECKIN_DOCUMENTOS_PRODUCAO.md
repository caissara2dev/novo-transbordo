# Configuração documental por ambiente

Preparação P10 / #48. A publicação depende do pacote e aprovação em #34.
Esta mudança não habilita documentos no `apphosting.yaml` nem cria recursos cloud.

## Sistema

O servidor valida a configuração antes de abrir o bucket ou emitir capacidade de upload/download.
Além de `CHECKIN_DOCUMENTS_ENABLED=true` e um `CHECKIN_INDEX_HMAC_SECRET` próprio
com pelo menos 32 caracteres, exige os destinos exatos:

| Ambiente | CHECKIN_DOCUMENT_ENVIRONMENT | FIREBASE_PROJECT_ID | CHECKIN_DOCUMENT_BUCKET | CHECKIN_PORTAL_ORIGIN |
| --- | --- | --- | --- | --- |
| Homologação | ausente ou `staging` | `line-transbordo-staging-382612` | `line-transbordo-staging-382612-checkin-nf` | `https://checkin-portal-nf--line-transbordo-staging-382612.us-central1.hosted.app` |
| Produção | `production` obrigatório | `line-transbordo` | `line-transbordo-checkin-nf` | `https://checkin.linebot.com.br` |

O nome de bucket e a origem de produção são destinos previstos, ainda sujeitos ao provisionamento
e verificação em P07/P08. Não basta editar estas variáveis para concluir a implantação.
Outro domínio ou bucket exige mudança revisada nesta política e em seus testes.
Não usar emuladores nos ambientes cloud. Configuração cruzada ou incompleta falha com HTTP 503.

Testes locais preservam projetos `demo-*` somente com `FIRESTORE_EMULATOR_HOST` definido,
seletor ausente ou `demo` e bucket com prefixo `demo-`. Seus destinos de teste não são usados na nuvem.

## Worker

Usa `GOOGLE_CLOUD_PROJECT`, `CHECKIN_DOCUMENT_BUCKET` e o mesmo seletor
`CHECKIN_DOCUMENT_ENVIRONMENT`. Admite somente os dois pares cloud acima; produção
exige `production`. A validação ocorre antes de criar clientes Firestore/Storage.
O worker cloud não aceita emuladores nem projetos demo. Os testes Python usam clientes simulados.
O Dockerfile inclui `runtime_config.py`, necessário na imagem implantada.

## Ativação e rollback

1. Concluir P07–P09: bucket privado, identidades/IAM mínimos, segredos independentes,
   domínio/certificado, CORS do portal e da fila interna, Turnstile e Scheduler com OIDC.
   Preservar credenciais existentes do sistema. Não copiar segredos ou dados de staging.
2. Preparar configurações de sistema, portal e worker com os valores acima, incluindo a origem
   interna `CHECKIN_DOCUMENT_INTERNAL_ORIGIN=https://linebot.com.br`. Ela continua sujeita
   à validação de origem HTTPS exata já implementada para anexos internos.
3. Conferir o candidato e os testes em P20 e obter aprovação de publicação em P21.
4. No deploy aprovado, publicar a imagem do worker antes de habilitar o fluxo documental,
   verificar IAM/agenda e então validar envio, leitura e retenção em produção.

Para interromper novos envios, desabilitar `CHECKIN_DOCUMENTS_ENABLED` no sistema e a
interface correspondente no portal. Para rollback de código, restaurar os SHAs/imagens
registrados no pacote da release. Não excluir bucket, documentos ou segredos como rollback.
Avaliar separadamente a pausa do Scheduler para não interromper a retenção silenciosamente.
