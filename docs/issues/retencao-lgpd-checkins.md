# Rascunho de issue — retenção e LGPD dos check-ins

## Objetivo

Definir, com responsáveis jurídico e operacional, por quanto tempo a Line deve
reter dados pessoais e fiscais de pré-cadastros, check-ins, auditorias e linhas
Excel, além dos procedimentos de acesso, correção, anonimização e exclusão.

## Bloqueio da V1

A V1 não executa exclusão nem anonimização automática. Produção não deve ser
tratada como plenamente encerrada até esta decisão ser aprovada e convertida em
política operacional e técnica.

## Critérios de aceite sugeridos

- prazos por categoria de dado e fundamento legal documentados;
- definição do responsável por solicitações de titular;
- alinhamento entre Excel, Firestore, logs, backups e auditoria;
- rotina de retenção testada em staging, com preservação do mínimo de auditoria;
- runbook de incidente, exportação, correção e exclusão;
- revisão de textos de consentimento e do aviso de privacidade.

Este arquivo é apenas o rascunho local. Criar a issue no GitHub exige aprovação
explícita para a ação externa.
