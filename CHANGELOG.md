# Changelog

Todas as alterações relevantes deste projeto serão registradas neste arquivo.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto usa
[Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [2.2.1] - 2026-08-11

### Corrigido

- Ao selecionar `Editar` no histórico, o formulário de edição passa a ser revelado no topo da
  tela e recebe foco, inclusive quando o mesmo lançamento é selecionado novamente.

### Segurança

- As resoluções transitivas de `brace-expansion` e `nanoid` foram atualizadas para versões
  corrigidas, mantendo a auditoria das dependências de produção sem vulnerabilidades conhecidas.

## [2.2.0] - 2026-07-27

Esta release incorpora integralmente o trabalho desenvolvido para a linha 2.1.
Não existe release nem tag `v2.1.0` separada.

### Adicionado

- Bomba 3 com as mesmas regras operacionais, filtros e indicadores das bombas existentes.
- Estados de container Cheio, Parcial, Pulmão, Blend cheio e Blend parcial.
- Estado atual materializado, histórico encadeado e proteção contra atualizações concorrentes.
- Tela de consulta de containers abertos, ciclos, motivos e placas relacionadas.
- Backfill protegido e idempotente para materializar containers legados como Cheio.
- Display operacional `/display`, otimizado para TVs 16:9, com atualização a cada 30 segundos e rotação automática de clientes.
- Papel `DISPLAY` gerenciável por administradores e endpoint exclusivo `GET /api/display/overview`.
- Ociosidade automática para todo trecho descoberto antes de um lançamento produtivo.
- Categoria interna `INTERVALO_OPERACIONAL` para intervalos dispensados de justificativa.
- Preview versionado da linha do tempo em `POST /api/events/gap-preview`.
- Configuração administrativa global do limite sem justificativa, entre 0 e 60 minutos.
- Identificação da origem `MANUAL` ou `AUTO_GAP` e vínculo entre o intervalo gerado e o produtivo.

### Alterado

- Lançamentos produtivos passam a consultar o ciclo atual do container antes da gravação.
- O estado do container usa uma interface compacta, otimizada para o fluxo atual e para operação em celulares.
- Relatórios, detalhamento e CSV passam a aceitar filtros e campos de estado do container.
- O login direciona contas `DISPLAY` diretamente para a tela de TV, sem menu, rodapé ou controles operacionais.
- O formulário passa a iniciar no modo produtivo e mantém o lançamento ocioso manual atrás de
  `Registrar ociosidade`.
- Intervalos acima do limite exigem uma causa para cada trecho não coberto por ociosidades manuais.
- Relatórios, gráficos, detalhamento e CSV incluem o rótulo `Intervalo operacional`.
- Edições, exclusões e restaurações atualizam a versão da linha do tempo e preservam a auditoria dos
  eventos automáticos vinculados.
- O histórico identifica lançamentos automáticos e mostra, a partir da segunda visita, um resumo
  operacional das passagens anteriores do mesmo ciclo do container.
- Display, containers e configurações passam a usar a mesma linguagem visual das demais telas.

### Corrigido

- Ordenação do histórico para manter o produtivo acima da ociosidade automática que o antecede.
- Filtros do histórico deixam de depender de combinações de índices compostos não publicadas.
- Avisos de sucesso passam a usar uma aparência positiva, distinta das mensagens de erro.
- O Firebase Admin passa a ser empacotado no servidor para evitar falhas ESM/CJS nas APIs do
  preview e do App Hosting.
- A configuração pública do App Hosting passa a usar o App ID e a API key reais do app Web de
  produção.
- O App Hosting passa a inicializar App Check com a site key reCAPTCHA Enterprise registrada para
  o app Web de produção.
- O backfill de containers passa a aguardar a execução completa antes de encerrar o processo e
  confirmar a contagem materializada.

### Segurança

- A coleção `containerStates` permanece inacessível diretamente pelo cliente; leitura e escrita passam pelas APIs autenticadas.
- Contas `DISPLAY` ficam bloqueadas em todas as APIs operacionais, mantendo acesso apenas à autenticação, ao próprio perfil e ao resumo do display.
- Preview e gravação validam a mesma versão da linha do tempo e retornam conflito quando há alteração
  concorrente.
- O produtivo, seus intervalos automáticos e o estado do container são persistidos em uma única
  transação.
- Dependências de runtime foram atualizadas e o lockfile da release não possui vulnerabilidades
  conhecidas no `npm audit --omit=dev`.
- O Dependabot passa a propor semanalmente atualizações menores e de correção, agrupadas entre
  dependências de produção e desenvolvimento.

## [2.0.0] - 2026-07-21

### Adicionado

- Painel de relatórios V2 com filtros, indicadores, gráficos, detalhamento e exportação CSV.
- Identificação visual para ambientes de homologação.
- Testes automatizados das regras do Firestore.
- Base de CI para validar lint, testes, regras e build em pull requests.

### Alterado

- Histórico operacional com identificação de placa/container e melhor aproveitamento de espaço.
- Fluxo de publicação passa a usar `main` como fonte da produção estável.

### Segurança

- Escritas diretas em perfis de usuários foram bloqueadas nas regras do Firestore.
- Alterações de aprovação e papel permanecem restritas às APIs administrativas.

[2.0.0]: https://github.com/caissara2dev/novo-transbordo/releases/tag/v2.0.0
[2.2.0]: https://github.com/caissara2dev/novo-transbordo/releases/tag/v2.2.0
[2.2.1]: https://github.com/caissara2dev/novo-transbordo/releases/tag/v2.2.1
