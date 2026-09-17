> Registro histórico da implementação/homologação. As frases de estado se referem à data do documento. Para a consolidação atual e as pendências de produção, consulte [CHECKIN_V2_ENTREGA.md](CHECKIN_V2_ENTREGA.md).

# Check-in v2 — implementação e homologação

Data: 10/09/2026. Trabalho local em `codex/checkin-system-v2`, baseado na main
`efa3abf5ed7448f5c32253f18984eaa997eb9ae2` (v2.5.0). Branch antiga e alterações
originais preservadas. Nenhum deploy, push, dado Firebase ou planilha real alterado.

## Entregas

| Entrega | Evidência / entrada |
|---|---|
| Protótipo analista + cliente | `npm run prototype`, porta 4173, dados fictícios |
| Gestão pela Line | `/checkins`: atribuição, correção com motivo, pendências, liberar e chamar |
| Portal do cliente | `/customer/checkins`: consulta própria e três campos |
| Administração | `/queue-access`: habilitar empresa, dispensar amostra e vincular conta existente |
| Registro oficial | confirmação/walk-in em `/api/integrations/checkins/v1` sem Excel |
| Operador | visita chamada preenche cliente/placa; somente salvar evento inicia descarga |
| Exportação | CSV filtrado, BOM UTF-8 e separador `;`, proteção contra fórmulas |
| Portal motorista | worktree separado; aparência preservada, aviso de privacidade alinhado à captura |

Para testar o protótipo: atribua DEMO-01 a ALLOG, salve, alterne para ALLOG e edite
os três campos. Volte para a Line, resolva as pendências, salve, libere e chame.
A área “Simulação do lançamento” demonstra sucesso/falha de salvamento. Os
controles de demonstração também simulam conflito, erro na exportação, cliente
sem portal e cliente sem amostra. Reiniciar restaura os dados fictícios.

## Reaproveitamento

Portal, formulários e recuperação preservados. Reutilizados domínio de check-in,
validação GPS, índices HMAC, locks de CNH/placa, replay de requisição e expiração.
Fila usa novas telas compartilhadas entre protótipo e aplicação. Vínculo produtivo
foi integrado às transações atuais da v2.5.0. Não foram trazidos adapters Excel,
Power Automate nem ações antigas sem uso. Sem dependência nova de serviço externo.
Vite já existia transitivamente e foi declarado para reproduzir o protótipo.
Next.js/Sharp e dependências transitivas foram atualizados para corrigir os
avisos encontrados. Consulte [resultados da validação](checkin-v2-validacao.md).

## Execução local

```sh
npm ci
npm run prototype
npm run test:prototype # com o protótipo em execução
npm run build:prototype
npm run lint
npm run typecheck
npm run test:coverage
npm run verify:firestore-indexes
npm run test:rules # Java 21 necessário
npm run test:e2e
npm run build
npm run verify:server-bundle
```

Use apenas emuladores ou projeto de homologação. `.env.example` mantém a nova
integração desligada. Para testar o fluxo completo, configure auth e Firestore
emuladores, HMACs de teste e centro/raio fictícios; nunca reutilize segredos de
produção. `CHECKIN_SYSTEM_RECORD_ENABLED=true` habilita o módulo e
`CHECKIN_INTEGRATION_MODE=observe` habilita o contrato e vínculo opcional.
`enforce` exige também `CHECKIN_ENFORCE_ROLLOUT_APPROVED=true`. As APIs da Line
continuam disponíveis enquanto SYSTEM=true, inclusive para consultar filas
existentes quando a integração pública está em off.

Use Node 22 e npm 10/11, conforme engines do projeto.
E2E pode usar build com `E2E_USE_BUILD=true`, compilado antes com as variáveis
públicas dos emuladores. Assim, recargas do servidor de desenvolvimento não
interrompem a interação. Arquivos gerados em outputs não participam do lint.

## Homologação operacional antes de produção

1. Validar estas telas com um analista e um usuário ALLOG usando dados de teste.
   Conferir nomes dos campos, tipos de veículo/produto, transições e visual móvel.
2. Criar projeto/ambiente separado, instalar os índices e regras. Configurar
   HMACs/geofence, verificação de e-mail, App Check e limites de requisição do
   portal. Alinhar key-id e segredo de integração entre portal e backend conforme o
   contrato existente; nunca expor os segredos no browser.
3. Conceder ANALYST a uma conta de teste e CUSTOMER a outra, vinculada a ALLOG.
   Testar duas empresas, cliente não participante, processo sem amostra, revogação,
   duas sessões concorrentes e cliente tentando acessar uma visita de outra empresa.
4. Fazer check-in real de teste no portal, confirmar entrada sem cliente e GPS
   exclusivo da Line. Validar recuperação, duplicidade, localização recusada e
   repetição da confirmação após perda de resposta.
5. Percorrer atribuição → salvar → resolver pendência → liberar → chamar → operador
   selecionar → salvar lançamento. Falha no evento deve preservar CHAMADO. Testar
   exclusão/restauração antes de encerrar a visita e rejeição após encerramento.
6. Validar lançamentos atuais sem vínculo em observe, e transferências entre
   containers com a funcionalidade existente. Verificar exportação filtrada no Excel.
7. Definir a política de retenção/consulta do GPS e aprovar o texto de privacidade
   junto ao processo da Line. Alinhar a comunicação de que check-in não garante ordem.
8. Inventariar a fila aberta e qualquer reserva pendente legada. Preparar uma
   migração explícita com conferência e backup se houver dados a trazer. A rotina
   não importa planilhas, não reconcilia reservas antigas automaticamente e não
   alimenta planilhas em segundo plano.
9. Registrar evidência, responsável pelo piloto, janela de ativação e versão
   compatível para retorno. Aprovar externamente a publicação de backend e portal;
   começar com observe, depois avaliar enforce. Nenhuma dessas ações foi executada.

## Recuperação

Não voltar a uma versão que desconheça checkInId após a primeira gravação
vinculada. Pausar novos check-ins/vínculos colocando integração em off, manter
SYSTEM=true para a Line consultar/corrigir a fila, e usar versão compatível com
exclusão/restauração atômicas. Nunca editar a visita separadamente para simular um
lançamento salvo. Restaurar backup exige uma operação planejada e autorização.
A exportação pode ser repetida sem alterar o estado da fila.

## Limites desta entrega

Os testes locais e o protótipo não representam homologação em ambiente remoto.
Acesso de contas reais, publicação, migração inicial e alimentação automática de
planilhas permanecem fora desta execução. CSV é o formato entregue; não gera XLSX.
A localização exata fica no registro interno; o protótipo usa coordenadas fictícias.
