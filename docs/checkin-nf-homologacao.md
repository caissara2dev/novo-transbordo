> Registro histórico da implementação/homologação. As frases de estado se referem à data do documento. Para a consolidação atual e as pendências de produção, consulte [CHECKIN_V2_ENTREGA.md](CHECKIN_V2_ENTREGA.md).

# Check-in documental: homologação de 14/09/2026

## Escopo e ambientes

Entrega limitada a registrar check-in, vincular original ou registrar exceção documental e consultar/baixar pela Line. Produção não foi alterada. O deploy foi uma origem local isolada, sem merge ou publicação nas branches de produção.

Projeto único autorizado: `line-transbordo-staging-382612` (número `431638748152`).

| Recurso | Nome |
|---|---|
| Portal App Hosting | `checkin-portal-nf` |
| Sistema App Hosting | `checkin-system-nf` |
| Bucket privado | `line-transbordo-staging-382612-checkin-nf` |
| Cloud Run privado | `checkin-document-worker` |
| Scheduler, a cada 5 minutos | `checkin-documents-maintenance` |
| Artifact Registry | `checkin-nf` |

URLs:
- https://checkin-portal-nf--line-transbordo-staging-382612.us-central1.hosted.app
- https://checkin-system-nf--line-transbordo-staging-382612.us-central1.hosted.app/checkins

O projeto de staging já continha dados de testes anteriores; não foram apagados. Novas visitas estão marcadas como homologação. O usuário de QA é fictício e exclusivo deste ambiente; credenciais ficam em arquivo local privado fora do código.

## Contratos e persistência

`POST /api/integrations/checkins/v1/documents` usa o verificador HMAC existente e um contrato estrito com `open`, `begin`, `status`, `finalize` e `failed`. O portal faz a verificação Turnstile e assina a integração; nunca recebe credenciais GCP no navegador. O identificador opaco da sessão é uma capacidade temporária e deve ser tratado como segredo de curta duração.

- `open`: associa identidade normalizada, operação e UUID do cliente; duração de uma hora. Limite por identidade e hora.
- `begin`: prepara um objeto específico e URL retomável GCS; limite de oito tentativas por sessão, uma ativa por vez. Não transporta arquivo no JSON.
- `finalize`/`failed`: verificam o objeto real, tamanho, assinatura de tipo e hash. Uma resposta de falha do navegador não vence um upload que já foi concluído. Contagem idempotente por tentativa, com revogação da sessão resumível quando necessário.
- Na confirmação, uma transação do Firestore registra visita, documento, vínculo da sessão e trabalho de prévia. Identidade/operação/expiração e duas falhas para exceção são validadas no servidor.
- A repetição de uma confirmação retorna a visita original. Nova sessão documental não pode substituir silenciosamente o documento de visita já confirmada.

Coleções privadas, negadas pelas regras do cliente Firebase:
`_checkinDocumentSessions`, `_checkinDocumentQuotas`, `_checkinTemporaryObjects`, `_checkinPreviewJobs`.

A visita contém `document.status` (`pending`/`received`) e `current` com ID do documento, objeto, geração, tipo, tamanho, hash e estado da prévia. O vínculo usa o ID definitivo da visita. O estado documental não altera o status operacional. Release e call são bloqueados no servidor e na tela quando falta documento.

## Arquivos e prévias

- Máximo: 10.000.000 bytes, um original atual por visita.
- JPEG/JPG, PNG, HEIC/HEIF e PDF. Validação do conteúdo no servidor além dos metadados do navegador.
- Original armazenado sem recompressão, geração fixa e SHA-256.
- Imagens: Pillow com pillow-heif/libheif, correção EXIF, proporção mantida, lado maior até 1.600 px, qualidade JPEG 85%, fundo branco para transparência e sem ampliação.
- A prévia pode falhar sem invalidar o original. Limite de decodificação de 40 MP protege o processador; uma imagem muito grande pode ficar apenas com original.
- PDF: original preservado, sem renderização de páginas nesta entrega.
- O Scheduler chama o worker com OIDC. O serviço não permite chamada pública. Prévia é assíncrona: pode levar alguns minutos.

O bucket exige acesso uniforme e prevenção de acesso público. CORS permite somente a origem do portal de homologação e PUT de upload. Soft delete está desativado apenas neste bucket novo para que a limpeza de temporários cumpra a exclusão configurada.

Downloads usam autorização ativa de admin/supervisor/analista e URL assinada com validade de 60 segundos, fixada à geração do original. A API do cliente não inclui documentos. Não há links permanentes públicos. O download é registrado no histórico sem armazenar a URL assinada.

## Limpeza e regras futuras

O worker remove sessões e objetos temporários não vinculados após 24 horas; há uma marcação transacional que impede remover o arquivo confirmado simultaneamente. Também limpa seleções substituídas antes da confirmação. Teste real de limpeza usou somente objetos fictícios envelhecidos artificialmente; o objeto atual permaneceu vinculado.

Não implementado nesta entrega: complemento/substituição pela equipe, exclusão manual, versões históricas de substituições, expiração de 90 dias dessas versões e de 12 meses do documento atual após conclusão/cancelamento. O histórico textual seguirá a visita. Não anunciar essas políticas como limpeza já ativa.

## Registro da implantação no workspace original

Este procedimento documenta a montagem original da homologação; não é um comando pronto para executar em clones novos. O script exige a pasta irmã `checkin-portal-v2` e arquivos privados de configuração em `/tmp`, ausentes no GitHub. Antes de um novo deploy, é necessário adaptar e revisar as origens para os checkouts e commits aprovados, evitando capturar o portal antigo. Essa preparação faz parte da issue #34.

`scripts/homologation/prepare-release.py` gera `.staging/checkin-nf-release` por lista de arquivos permitidos. Não copia `.env`, credenciais privadas nem o `apphosting.yaml` original com padrões de produção. Os dois manifests gerados possuem projeto, bucket, origens e referências Secret Manager explícitas de staging.

O deploy usa o Firebase CLI com `--project line-transbordo-staging-382612 --only apphosting:checkin-system-nf,apphosting:checkin-portal-nf`. Para alterar só o portal, restrinja `--only apphosting:checkin-portal-nf`.

Scripts administrativos têm guarda do ID do projeto e evitam imprimir segredos. Não executar provisionamento novamente sem inspecionar o estado: concessões de acesso de build foram concluídas pelo CLI oficial. `provision.cjs` não deve ser usado para sobrescrever políticas já concedidas. O frontend usa conta própria; não tem acesso direto ao bucket de documentos.

Secret Manager: `CHECKIN_NF_HMAC`, `CHECKIN_NF_INDEX`, `CHECKIN_NF_RATE`, `CHECKIN_NF_TURNSTILE`. Não documentar seus valores nem usar chaves de produção. O widget Turnstile novo permite somente o hostname deste portal; o widget anterior permaneceu intocado.

## Validação executada e pendente

- Portal: 46 testes, typecheck e lint.
- Sistema: 69 testes selecionados de serviços/handlers/fila e 11 testes documentais com Firestore Emulator real. O teste de emulador só roda com projeto `demo-checkin-nf`, evitando limpeza de coleções em nuvem.
- Worker: 5 testes, incluindo HEIC gerado/decodificado, orientação EXIF e dimensões.
- Nuvem: JPEG sem código; PDF com código; repetição sem duplicar; hash do original após download; preview ready; anonimato e cliente recusados; duas falhas de uploads parciais reais e exceção; duas transições rejeitadas sem mudar a visita; limpeza de abandonado preservando o atual.
- Interface: login de analista, lista das três visitas, documento pendente bloqueando liberação e controles de download/prévia disponíveis.
- Portal no navegador: envio real de JPEG concluído pela própria interface, com “Nota recebida”. Antes disso, uma espera na verificação Turnstile motivou timeout de segurança, timeout de rede e mensagens por fase, mantendo campos e recuperação de resultado. A confirmação no computador foi corretamente interrompida por GPS indisponível, preservando campos e documento. A confirmação completa pelo celular ainda precisa ser comprovada.

Pendentes de homologação física: Android/Chrome e iPhone/Safari, câmera/galeria/HEIC/PDF reais, permissões recusadas, qualidade/legibilidade da prévia e interrupção/retomada da rede no telefone. O GPS mantém o centro (-23.9608, -46.3336), raio 20 km e demais validações existentes. Não usar GPS sintético do teste técnico como evidência de GPS real de um aparelho.

Evidências locais e roteiro: `outputs/checkin-nf-homologacao-2026-09-14/` na raiz do workspace. Nenhuma senha está neste documento.

Referências oficiais: [GCS resumable uploads](https://docs.cloud.google.com/storage/docs/performing-resumable-uploads), [instalação pillow-heif](https://pillow-heif.readthedocs.io/en/latest/installation.html), [limites de formatos do Sharp](https://sharp.pixelplumbing.com/install/).

## Revisão do portal após feedback Android

A continuação de uma sessão documental agora usa `__Host-checkin-nf`, cookie HttpOnly/Secure/SameSite=Strict com ID de sessão, expiração e assinatura HMAC separada por contexto. Emitido somente após Turnstile válido e resposta bem-sucedida do backend documental. Não há reaproveitamento do token Turnstile (ele continua de uso único), mudança do widget Cloudflare ou redução das validações de identidade/GPS no sistema. A confirmação com a mesma sessão pode usar a autorização, necessária também para repetição idempotente em caso de resposta perdida; demais operações públicas continuam exigindo segurança própria. Outra aba com outra sessão pode substituir o cookie e solicitar nova verificação, sem aceitar autorização cruzada.

Testes de regressão no portal: `android-feedback.test.tsx` (DOM), `document-session-route.test.ts` (endpoint e autorização) e `document-session-client.test.ts` (renovação e erros). Total do portal: 63 testes passando. As primeiras execuções reproduziram a placa sem aviso, JSON técnico, nome longo e três solicitações de segurança no mesmo upload.
