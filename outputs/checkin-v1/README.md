# Artefato de staging do Check-in V1

`Agendamento Line Transportes - Staging.xlsx` é uma planilha vazia e sem dados
pessoais, criada para testar o contrato do Power Automate.

- aba: `Sheet1`;
- tabela oficial de referência: `OfficeForms.Table`;
- tabela sanitizada de staging: `CheckinsV1`;
- 19 colunas: as 18 existentes na planilha oficial, na mesma ordem e grafia,
  mais `Identificador de check-in` ao final;
- os dois cabeçalhos de ciência usam os textos aprovados para o Check-in V1;
- nenhuma fórmula ou linha de motorista.

A fonte oficial foi inspecionada localmente em 10/08/2026. As 1.692 respostas
existentes foram removidas da cópia, sem alterar o arquivo de origem e sem
versionar dados pessoais. Na mesma data, o upload manual do arquivo sanitizado
foi confirmado na biblioteca `Terminal - Line`, pasta `Documentos/linebot`.
O contrato, o schema, o payload de teste e o Office Script de inclusão estão em
`power-automate/`. O fluxo do Power Automate ainda não foi configurado nem
validado ponta a ponta.
