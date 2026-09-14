# Release 2.5.1 — redução de consultas do display

Acompanhamento: [issue #27](https://github.com/caissara2dev/novo-transbordo/issues/27).

## Diagnóstico e decisão

O display executava consultas periódicas ao endpoint `/api/display/overview`,
mesmo sem mudanças operacionais. Cada resposta relê dados do dia operacional e
containers abertos, além das verificações de acesso e controle de requisições.
Os custos variam com documentos retornados, número de telas e tempo de uso.

A versão anterior agendava chamadas a cada 30 segundos, abortando a chamada
anterior no navegador. Abortar no navegador não garante cancelar o trabalho já
iniciado no servidor. O diagnóstico encontrou tráfego repetido do painel em
janelas sem mutações operacionais e reproduziu esse mecanismo com dados fictícios.
Detalhes operacionais e logs brutos não são publicados.

Foi escolhido o Plano A: reduzir chamadas, mantendo a mesma API e consultas.
A aprovação inclui implementação, staging, publicação após gates e conferência
em produção. Migração de provedor, cache compartilhado e resumos materializados
não integram esta release.

## Comportamento

- Consulta inicial quando a tela está visível.
- Próxima consulta 120 segundos após conclusão da anterior; sem fila de tentativas.
- Aba oculta não inicia chamadas; uma chamada em andamento pode terminar.
- Retorno à aba antecipa uma chamada, com mínimo de 30 segundos entre disparos.
- No máximo uma tentativa ativa por tela. Falhas aguardam 120 segundos, inclusive
  se a aba alternar rapidamente entre visível e oculta.
- Timeout de 30 segundos aborta a tentativa no cliente, indica desatualização e
  conserva os últimos dados. Respostas tardias são ignoradas.
- Desmontagem cancela temporizadores, remove o listener e descarta respostas.
- Relógio a cada segundo, rotação a cada 10 segundos, privacidade e cálculos iguais.

Em condições normais, dados novos podem levar cerca de dois minutos mais a rede
para aparecer. Desligar apenas o monitor pode não ocultar a aba. Não há coordenação
entre computadores. Telas abertas antes do deploy precisam ser recarregadas.

## Comparação controlada (não é previsão de fatura)

Em uma hora continuamente visível, com respostas imediatas e sem navegação:

| Cadência | Chamadas, incluindo a inicial | Leituras com fixture de 42 por chamada |
| --- | ---: | ---: |
| 30 segundos | 121 | 5.082 |
| 60 segundos | 61 | 2.562 |
| 120 segundos | 31 | 1.302 |

A redução é 74,4% frente a 30 segundos e 49,2% frente a 60 segundos nessa janela.
A comparação de 60 segundos representa a cadência efetiva encontrada em parte do
tráfego observado, que difere do temporizador de 30 segundos do código antigo.
As 42 leituras são um cenário fixo para comparação, não custo constante da API.
Pausa de aba oculta não foi incluída nessa estimativa. A conta total também contém
outras telas, serviços, gravações, franquias e créditos.

## Ajuste necessário de dependências

O lockfile da base falhou nos gates de auditoria por alertas de Next.js e Sharp.
Para cumprir a publicação com auditoria aprovada, Next.js passou de 16.2.12 para
16.3.5 e o override de Sharp passou de 0.35.3 para 0.35.4. Atualizações transitivas
são as necessárias a esses pacotes; sem atualização ampla ou redução de severidade.

Referências oficiais: [Next.js](https://github.com/vercel/next.js/security/advisories/GHSA-2xp9-vwfh-vxw4),
[Sharp](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c).

## Validação e publicação

- Testes unitários usam relógio controlado para cadência, visibilidade, resposta
  lenta, falha síncrona/assíncrona, timeout, resposta tardia e desmontagem.
- E2E usa Auth Emulator e respostas fictícias para conferir privacidade, relógio,
  rotação, dados preservados, recuperação e estados inicial/oculto.
- Gate completo: `npm ci && npm run verify`, Node 22 e Java 21.
- Staging: preview isolado no projeto Firebase `line-transbordo-staging-382612`.
- Produção: App Hosting `novo-transbordo`, projeto `line-transbordo`, via `main`.
- Regras, índices, backfill e migração: não aplicáveis; nenhum contrato de banco mudou.
- Registro estável inicial: `efa3abf5ed7448f5c32253f18984eaa997eb9ae2`, build
  `build-2026-09-06-001`. Reconfirmar antes de promover.
- Reversão de emergência: restaurar o rollout estável compatível, preservar os
  dados e abrir correção/revert por PR. A restauração também repõe as dependências
  anteriores; preferir correção que conserve os patches de segurança quando viável.

Os resultados efetivos, commit validado, URL de staging, CI, rollout e observação
serão registrados na issue de release. A tag e a GitHub Release só serão criadas
após smoke autenticado e observação inicial de produção concluídos.

### Evidência local — 14/09/2026

`npm run verify` concluído com sucesso: 385 testes unitários/integração, 17 testes
de regras e 19 E2E. Cobertura: 92,21% statements, 84,14% branches, 96,41% functions,
93,14% lines. Lint, TypeScript, manifesto de índices, build e bundle server/client
aprovados. Auditoria geral sem critical e auditoria de produção sem high/critical;
resta um aviso moderate de produção, abaixo do limite bloqueante já estabelecido.

O Next.js regenerou sua orientação de agentes e a referência de tipos de parâmetros
raiz; esses arquivos acompanham a atualização de framework. O teste antigo de
estado desatualizado passou a avançar o relógio em 120 segundos, preservando suas
asserções de layout e conteúdo.
