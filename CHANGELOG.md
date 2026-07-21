# Changelog

Todas as alterações relevantes deste projeto serão registradas neste arquivo.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto usa
[Versionamento Semântico](https://semver.org/lang/pt-BR/).

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
