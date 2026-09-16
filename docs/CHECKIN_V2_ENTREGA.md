# Check-in V2 — consolidação do código de homologação

Tracks [#32](https://github.com/caissara2dev/novo-transbordo/issues/32). Esta entrega publica código e documentação para revisão; não implanta recursos nem promove o check-in para produção.

## Componentes e origem

| Componente | Localização | Origem |
|---|---|---|
| Sistema e APIs internas | Este repositório, branch `codex/checkin-v2-staging` | Commit local `dbe0d12` e alterações documentais da homologação |
| Portal do motorista | [checkin-line-portal](https://github.com/caissara2dev/checkin-line-portal), branch `codex/checkin-v2-staging` | Snapshot sanitizado do portal testado no celular |
| Processador de imagens | `infrastructure/checkin-documents` | Commits do PR #31, incluindo CPU por requisição |
| Protótipos | `prototype/` | Demonstrações locais com dados fictícios; não são deploy de produção |

Base de integração: main `df04b85`, v2.5.1. Preservadas as alterações do display, lançamentos e versão do Next.js dessa base. O PR #16 mantém a proposta histórica da V1/Excel e não representa esta versão V2. Não foi apagado ou mergeado.

A pasta `src` do sistema foi comparada com o snapshot local utilizado no último deploy da homologação antes da integração; nenhuma divergência foi encontrada. O portal foi importado com código, assets e testes, excluindo builds, relatórios gerados e credenciais. Documentos de validação antigos são históricos; os testes desta consolidação serão registrados no PR.

## Capacidades presentes

- Fila interna, atribuição de cliente, campos compartilhados, pendências, liberação e chamada como ações distintas.
- Portal restrito do cliente e API limitada ao cliente vinculado e aos campos permitidos.
- Confirmação de chegada gravada no sistema, sem dependência obrigatória de Excel.
- GPS pontual e registro documental por visita; original privado, prévia de imagem, consulta/download pela Line.
- Exceção documental após falhas verificadas e bloqueio de liberação/chamada quando falta documento.
- Vínculo com lançamento salvo para iniciar descarga; CSV filtrado independente da confirmação.
- Portal público com código/sem código, recuperação/consulta e ajustes feitos após o feedback Android.

## Validação reproduzível

Use Node 22/npm compatível com `engines` e apenas emuladores ou ambiente de teste autorizado.

```sh
npm ci
npm run verify
npm run build:prototype
# Em ambiente Python isolado, com requirements do worker instalados:
python -m unittest discover -s infrastructure/checkin-documents -p test_preview.py
```

A cobertura inicia o Firestore Emulator na porta 8188 e executa a suíte documental com projeto `demo-checkin-nf`; o runner recusa outro destino. `npm test` sem o emulador pode indicar os casos documentais como ignorados: isso não é evidência de que passaram. O gate completo é `npm run verify`, que inclui a cobertura com emulador. Protótipos possuem `npm run test:prototype` com servidor Vite próprio. Nenhum script administrativo de `scripts/homologation` deve ser executado para rodar testes locais.

## Pendências antes de produção

- Complemento/substituição do documento pela Line e exclusão manual com as permissões aprovadas. A exceção sem nota não tem ainda um fluxo interno completo para resolver o bloqueio.
- Retenção: versões substituídas por 90 dias e documento atual por 12 meses após conclusão/cancelamento; histórico textual preservado com a visita.
- Últimos ajustes de UI/UX, incluindo revisão da administração de acessos e das ações operacionais em relação ao protótipo aprovado.
- Homologação completa de permissões entre empresas, concorrência, falhas de rede, GPS real, câmera/galeria/PDF e compatibilidade com lançamentos existentes.
- Preparação de produção: bucket, identidades, segredos, origens, agendamentos e domínios. Há guardas documentais e do worker restritas à homologação; alterá-las exige uma entrega própria, não uma remoção improvisada.
- Plano de entrada em operação para a fila aberta, backup/rollback compatível e aprovação do responsável antes de merge/deploy/release.

## Scripts administrativos e documentos históricos

Os scripts de homologação registram como o ambiente de teste foi preparado. Alguns concedem permissões ou escrevem dados de QA; não fazem parte do build nem são chamados pelo CI. Não os execute em lote, não use em produção e não reprovisione um ambiente existente sem inspecionar o efeito. Arquivos referenciados em `/tmp` são material local privado e não estão no repositório.

Para corrigir exclusivamente a cobrança do worker, use o comando dedicado do PR #31 e seu runbook. A consolidação preserva o fix e não exige reaplicá-lo.

## Encerramento desta entrega

A issue de consolidação pode ser encerrada quando os dois componentes estiverem publicados em branches/PRs, os resultados de validação estiverem registrados e as pendências acima tiverem acompanhamento. Isso não encerra a homologação nem autoriza produção. Use `Tracks`, não fechamento automático, nos PRs enquanto a entrega completa estiver pendente.

Acompanhamento: [documentos internos e retenção #33](https://github.com/caissara2dev/novo-transbordo/issues/33) e [UI/UX, homologação e produção #34](https://github.com/caissara2dev/novo-transbordo/issues/34).
