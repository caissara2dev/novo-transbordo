# Changelog

Todas as alterações relevantes deste projeto serão registradas neste arquivo.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto usa
[Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [2.1.0] - 2026-07-23

### Adicionado

- Bomba 3 com as mesmas regras operacionais, filtros e indicadores das bombas existentes.
- Estados de container Cheio, Parcial, Pulmão, Blend cheio e Blend parcial.
- Estado atual materializado, histórico encadeado e proteção contra atualizações concorrentes.
- Tela de consulta de containers abertos, ciclos, motivos e placas relacionadas.
- Backfill protegido e idempotente para materializar containers legados como Cheio.

### Alterado

- Lançamentos produtivos passam a consultar o ciclo atual do container antes da gravação.
- O estado do container usa uma interface compacta, otimizada para o fluxo atual e para operação em celulares.
- Relatórios, detalhamento e CSV passam a aceitar filtros e campos de estado do container.

### Segurança

- A coleção `containerStates` permanece inacessível diretamente pelo cliente; leitura e escrita passam pelas APIs autenticadas.

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
[2.1.0]: https://github.com/caissara2dev/novo-transbordo/releases/tag/v2.1.0
