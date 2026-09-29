# Sistema de Locação de Patinetes e Motos Elétricas
## Especificação técnica e handoff

**Versão:** 1.1 — setembro/2026
**Status:** MVP completo e testado. Banco provisionado. Faltam dois passos para entrar no ar — ver seção 10.
**Escala alvo:** 1 loja, ~200 patinetes + 10 motos elétricas, 2 a 4 dispositivos simultâneos.

---

## 1. O que é

Sistema de balcão para locação por tempo de equipamentos de mobilidade elétrica. Cobre o ciclo completo: saída do veículo, contrato com assinatura eletrônica, vistoria fotográfica, controle de lacre, devolução com cobrança de excedente e avaria, caixa diário e demonstrativo financeiro.

Foi construído como protótipo validado com o dono da operação. **Toda regra de negócio aqui descrita foi acordada e testada com ele** — não são suposições. O que precisa de decisão técnica está marcado como tal na seção 8.

### Arquivos

| Arquivo | O que é |
|---|---|
| `index.html` | **É o que vai para produção.** Aplicação completa com persistência em Supabase. URL e chave pública já configuradas. Deploy é copiar este arquivo para um host estático. |
| `app.html` | Mesma aplicação com dados em `localStorage`. Serve para rodar offline, sem servidor, e para testar mudanças sem tocar em dados reais. Gerada a partir da mesma base. |
| `1-banco-de-dados.sql` | Schema Postgres, RLS, function de gravação e bucket de storage. Idempotente. |
| `proposta-visual.html` | Mockup do painel com dados fictícios. Só referência de design, não é código de produção. |
| `_estilo.css`, `_nuvem.js`, `_fotos.js`, `_lacres.js`, `_inventario.js`, `_arranque.js` | Fragmentos usados para montar os HTML. Já estão embutidos. **Podem ser ignorados** ou usados como ponto de partida se você for modularizar. `app.html` + os fragmentos de nuvem geram o `index.html`. |

Ambiente já provisionado: projeto Supabase `locadora`, região `sa-east-1`, schema aplicado e testado. URL e chave pública já estão dentro do `index.html`.

---

## 2. Arquitetura atual

```
Navegador (single-file HTML, sem build, sem framework)
   │
   ├── estado da aplicação: objeto JS `DB` em memória
   │
   ├── persistência: 1 registro JSONB em Postgres, versionado
   │      RPC salvar_estado(doc, versao, por) → optimistic lock
   │      Realtime UPDATE em `estado` → recarrega nos outros dispositivos
   │
   ├── fotos: Supabase Storage, bucket privado `vistorias`, signed URLs
   │
   └── histórico imutável: tabela `eventos` (append-only, sem policy de UPDATE/DELETE)
```

**Decisões e por quê:**

- **Single-file, sem framework.** O protótipo precisava rodar sem infraestrutura para validar regras de negócio com o cliente. Cumpriu esse papel. Não é a escolha para produção — ver seção 8.
- **Estado como documento único versionado.** Permitiu migrar de `localStorage` para servidor trocando apenas duas funções, sem reescrever a aplicação. O lock otimista resolve concorrência entre dispositivos sem perda silenciosa: se a versão enviada não é a atual, o servidor recusa e devolve o estado novo. **Testado.**
- **`eventos` append-only no banco, não na aplicação.** As tabelas `eventos` e `snapshots` não têm policy de UPDATE nem DELETE. Sem policy, a operação é negada pelo RLS. A imutabilidade é garantida pelo Postgres, não por código de aplicação.
- **Auth de loja + PIN de operador.** Um usuário Supabase Auth libera o dispositivo; dentro da aplicação, cada atendente entra com PIN de 4 dígitos que identifica quem operou. Isso é uma simplificação consciente — ver seção 8.

---

## 3. Modelo de dados (objeto `DB`)

```js
{
  empresa: { nome, cnpj, endereco, telefone },

  config: {
    toleranciaMin,        // int, minutos de cortesia antes de cobrar excedente
    urlBase,              // base do link de assinatura
    exigirFoto,           // bool
    exigirLacre,          // bool
    inventarioDias        // int, periodicidade esperada da conferência de frota (default 7)
  },

  contrato: "string com {{placeholders}}",   // ver seção 5

  tipos: [{
    id: 'patinete'|'moto', nome, excedenteMin,   // R$ por minuto excedido
    tarifas: [{ id, label, min, valor }]
  }],

  pecas: [{ id, tipoId, nome, valor, total? }], // total:true = reposição do veículo inteiro

  veiculos: [{ id, codigo, tipoId, placa, status: 'loja'|'rua'|'manutencao' }],

  clientes: [{ id, nome, cpf, telefone, email, doc, criadoEm }],

  // um contrato pode cobrir vários veículos
  grupos: [{
    id, clienteId, clienteNome, clienteCpf,
    inicio, fimPrevisto, duracao, tarifaLabel,
    valorBase,                   // soma dos veículos
    pagamento,
    assinatura,                  // dataURL PNG
    contrato,                    // texto final renderizado, congelado
    assinaturaCanal: 'celular'|'balcao', assinadoEm, assinaturaToken,
    obsSaida, obsVistoria,
    atendenteId, atendente,
    locacaoIds: [], status: 'ativo'|'finalizado'
  }],

  // uma linha por veículo — é a unidade de cronômetro, devolução e faturamento
  locacoes: [{
    id, grupoId, veiculoId, veiculoCodigo,
    clienteId, clienteNome, clienteCpf,
    tipoId, tipoNome, tarifaId, tarifaLabel, minutos,
    inicio, fimPrevisto, fimReal,
    valorBase, valorExcedente, minutosExcedente,
    valorDanos, danos: [{ pecaId, nome, valor }],
    pagamento, pagamentoExcedente,
    obsSaida, obsEntrada, obsVistoria,
    atendenteSaida, atendenteEntrada,
    fotosSaida:   [{ id, caminho, legenda, ts }],
    fotosEntrada: [{ id, caminho, legenda, ts }],
    lacreSaida, lacreEsperado, lacreEntrada,
    status: 'ativa'|'finalizada'|'estornada',
    estorno?: { ts, usuario, usuarioId, motivo, detalhe, valor }
  }],

  despesas: [{
    id, dia: 'YYYY-MM-DD', categoria, descricao, valor,
    forma, pago, fixoId, usuario,
    estornada?: { ts, usuario, detalhe }
  }],

  custosFixos: [{ id, nome, categoria, valor, diaVenc, ativo, criadoEm }],

  caixas: [{
    dia: 'YYYY-MM-DD', aberturaTs, saldoInicial, operador, operadorId,
    status: 'aberto'|'fechado',
    fechamentoTs, saldoContado, esperado, operadorFech, obs
  }],

  usuarios: [{ id, nome, pin, papel: 'gerente'|'atendente', ativo, criadoEm, ultimoAcesso }],

  auditoria: [{ id, ts, usuarioId, usuario, acao, detalhe, ref }],

  // mapa, não array — acesso O(1) por número
  lacres: {
    "4001": { n, status: 'estoque'|'aplicado'|'rompido', veiculoId,
              recebidoEm, recebidoPor, aplicadoEm, aplicadoPor,
              rompidoEm, rompidoPor, locacaoId }
  },

  divergencias: [{ id, ts, tipo, detalhe, usuario, resolvida,
                   veiculoId?, esperado?, informado?, locacaoId?, inventarioId? }],

  inventarios: [{
    id, ts, usuario, duracaoSeg, totalFrota, encontrados,
    naRua:        [{ id, codigo }],                    // ausentes justificados
    faltando:     [{ id, codigo, tipo, status }],      // não encontrados
    achadosNaRua: [{ id, codigo }],                    // estavam na loja mas o sistema dizia alugado
    obs
  }],

  seq: { /* contadores de id por entidade */ }
}
```

---

## 4. Regras de negócio

Estas regras foram definidas pelo dono. **Não altere sem confirmar com ele.**

### 4.1 Tabela de preços

| Período | Patinete | Moto elétrica |
|---|---|---|
| 15 min | R$ 20,00 | R$ 50,00 |
| 30 min | R$ 30,00 | R$ 75,00 |
| 1 hora | R$ 60,00 | R$ 150,00 |

### 4.2 Excedente de tempo

- Cobrado **por fração de minuto**: cada minuto iniciado conta como minuto cheio (`Math.ceil`).
- Valor por minuto: **R$ 1,00** patinete, **R$ 2,50** moto. Derivado da tarifa de 1 hora dividida por 60.
- Tolerância padrão: **5 minutos**, configurável.
- **A tolerância é cortesia, não desconto.** Passando dela, cobram-se todos os minutos de atraso desde o fim do período contratado — não os minutos menos a tolerância.
  - Exemplo confirmado: patinete de 30 min devolvido em 47 min → 17 min × R$ 1,00 = **R$ 17,00** de excedente. Não R$ 12,00.
- Calculado **por veículo**, não por contrato.

### 4.3 Momento do pagamento e competência de caixa

- O **pacote é pago antecipadamente**, na saída.
- **Excedente e avaria** são apurados e cobrados na devolução.
- Para o caixa, a entrada é lançada **no dia em que o dinheiro entra**: o pacote no dia da saída (`inicio`), o excedente e a avaria no dia da devolução (`fimReal`). Uma locação que atravessa a meia-noite tem receita em dois dias distintos. Isso é intencional.

### 4.4 Locação com vários veículos

- Um contrato cobre N veículos. **O período é o mesmo para todos**; o preço soma conforme o tipo de cada um.
  - Exemplo: 3 patinetes + 2 motos por 1 hora = 3×60 + 2×150 = **R$ 480,00**.
- O locatário é responsável por todos os veículos do contrato, inclusive os conduzidos por acompanhantes. Cláusula explícita no contrato.
- **Devolução dos dois modos**: veículo a veículo (cada um com seu cronômetro e seu excedente) ou o grupo inteiro de uma vez. O contrato só encerra quando o último volta.
- A devolução em grupo **não lança avaria** — se um voltou danificado, aquele veículo é fechado individualmente. Decisão de UX para não sobrecarregar a tela de grupo.

### 4.5 Trava de caixa

- **Sem caixa aberto no dia, o sistema não libera veículo nem registra entrada.** Vale para saída e para devolução, porque o pagamento é antecipado — se o caixa estiver fechado na saída, o valor fica fora do fechamento.
- Ao ser bloqueado, o operador recebe a opção de abrir (ou reabrir) o caixa ali mesmo, e a ação pendente continua de onde parou.
- Fechar o caixa com veículos na rua é permitido, com aviso. Se algum voltar depois, exige reabertura.
- Fechamento confere dinheiro: `saldoInicial + entradas em dinheiro − saídas pagas em dinheiro` contra o valor contado. Diferença é registrada com autor e horário.
- O fechamento também mostra **as entradas somadas por forma de pagamento** (Pix, cartão de débito, cartão de crédito, dinheiro) e o total — o mesmo detalhe que sai na impressão, para o conferente ver antes de confirmar.

### 4.6 Imutabilidade e estorno

- **Nada é apagado.** Erro se corrige com estorno.
- Locação estornada: `status = 'estornada'`, valor sai do faturamento (`totalLoc()` retorna 0), registro permanece visível e riscado no histórico, com motivo obrigatório, autor e data. Se estava na rua, o veículo volta para a loja.
- Despesa: editável **apenas enquanto não paga**. Depois de paga, só estorno.
- Estorno é exclusivo do papel `gerente`.

### 4.7 Papéis

| Ação | Atendente | Gerente |
|---|---|---|
| Operar balcão e caixa | sim | sim |
| Estornar locação ou lançamento | — | sim |
| Alterar preços e tabela de peças | — | sim |
| Cadastrar usuários | — | sim |
| Registrar lote de lacres | — | sim |
| Tratar divergências | — | sim |
| Zerar o sistema | — | sim |

Regra de integridade: sempre deve existir pelo menos um gerente ativo.

**Operador (papel operacional).** Opera o balcão — locação, devolução, vistoria,
clientes e histórico — mas **não enxerga o financeiro**: a aba *Financeiro* fica
oculta e o indicador de faturamento do dia some do painel.

**Aba Usuários (exclusiva do gerente).** Criação e edição de usuários saíram de
*Configurações* para uma aba própria, visível só para o gerente — é ali que se
cadastra o nível abaixo dele (operador ou atendente), com PIN de 4 dígitos e
situação ativo/bloqueado. Quem não é gerente não vê a aba; se chegar por atalho
(`irPara('usuarios')`), é mandado de volta ao painel, e o botão de cadastrar
continua atrás de `exigirGerente`. O atendente mantém o restante do acesso
previsto na tabela acima.

### 4.8 Vistoria fotográfica

- Até 3 fotos por veículo na saída (frente, lateral, detalhe) e 3 na entrada.
- Mínimo de **1 foto por veículo obrigatória**, configurável em `config.exigirFoto`.
- Compressão no cliente: maior lado 800px, JPEG qualidade 0,55 (~50 KB/foto).
- Existe para sustentar a cobrança de avaria. O contrato tem cláusula em que o cliente declara ter visto as imagens e concordar que retratam o estado do equipamento.
- **Foto do documento do cliente.** Na tela do cliente da locação anexa-se a imagem da
  CNH, RG ou passaporte — pela câmera do aparelho **ou por upload** de arquivo já
  existente (foto, scan ou arquivo). A obrigatoriedade é configurável em dois níveis:
  globalmente em Configurações (`config.exigirDocFoto`) e por locação, para a
  atendente exigir na alta temporada ou diante de um cliente com comportamento
  duvidoso. A foto vai para a ficha do cliente e volta sozinha na locação seguinte.

### 4.9 Controle de lacres

Mecanismo de controle interno contra locação não registrada — o risco identificado pelo dono foi **funcionário alugar e ficar com o dinheiro sem lançar no sistema**.

- Todo veículo parado na loja fica com um lacre plástico numerado.
- O estoque de lacres é registrado por faixa numérica pelo gerente. **Só números em estoque podem ser usados.**
- **Na saída**, o atendente informa o número do lacre que rompeu. O sistema compara com o esperado:
  - confere → segue;
  - divergente → **permite seguir, mas registra divergência** com veículo, esperado, informado, autor e horário. Não bloqueia de propósito: divergência pode ter causa legítima, e o valor está no registro, não no impedimento.
  - sem número → bloqueia.
- **Na entrada**, informa o novo lacre aplicado. Validado contra estoque: recusa número inexistente, já rompido ou aplicado em outro veículo.
- **Conferência cega no fechamento:** lista os veículos que deveriam estar na loja; o número esperado **só aparece depois** que o operador digita o que encontrou. Toda diferença gera divergência nomeando o veículo.
- Divergências exigem apuração descrita pelo gerente para serem encerradas, e isso vai para a auditoria.

**Premissa operacional, não técnica:** o controle só tem valor se os lacres ficarem com o dono e forem entregues por turno em quantidade controlada. Com acesso livre ao lote, o atendente rompe, entrega o veículo e aplica um lacre novo — e o sistema não vê nada. Isso está documentado para o cliente.

### 4.10 Inventário da frota

Segunda camada do mesmo controle. Enquanto a conferência de lacres olha só o que está na loja, o inventário cobre **a frota inteira**, e responde à pergunta "sumiu algum veículo?".

- Periodicidade esperada configurável em `config.inventarioDias`, padrão **7 dias**. O painel exibe aviso quando vence, e quando nunca houve conferência.
- A contagem é feita **por entrada de código**, não por lista marcável: o operador digita ou lê o código de cada veículo que encontrou fisicamente. Escolha deliberada — com 210 veículos, uma lista de checkboxes é lenta e convida a marcar tudo sem olhar.
- A lista de pendentes começa **oculta**, atrás de um botão. Mesma razão da conferência cega de lacres.
- Veículos com `status = 'rua'` são **justificados automaticamente** e não contam como faltantes.
- Existe atalho "marcar tudo como encontrado", com confirmação. Foi incluído para conferência visual em bloco; o cliente foi orientado a reservar o inventário para o gerente, não para quem opera o balcão.

Dois resultados geram divergência:

| Situação | Tipo | Significado |
|---|---|---|
| Deveria estar (loja ou manutenção) e não foi encontrado | `veiculo_nao_encontrado` | Possível desaparecimento. |
| Foi encontrado na loja, mas o sistema diz `rua` | `veiculo_na_loja_como_rua` | Quase sempre **devolução não registrada**. A divergência nomeia a locação aberta e o cliente, com orientação de conferir se o dinheiro entrou. |

O inventário **não altera o status de nenhum veículo automaticamente.** Só registra. A correção é decisão humana, via apuração da divergência.

Histórico completo em Configurações: data, autor, total da frota, conferidos, na rua, faltantes com códigos e observações.

---

## 5. Contrato

Template em `DB.contrato`, com substituição de `{{placeholder}}`. O texto renderizado é **congelado** em `grupo.contrato` no momento da assinatura — alterações posteriores no template não afetam contratos já assinados.

Placeholders: `numero`, `cliente`, `cpf`, `telefone`, `email`, `documento`, `lista_veiculos`, `quantidade`, `veiculo`, `tipo`, `placa`, `tarifa`, `inicio`, `fim`, `valor`, `pagamento`, `tolerancia`, `excedente`, `vistoria`, `atendente`, `empresa`, `cnpj`, `endereco`, `telefone_empresa`, `data`.

Conteúdo jurídico (redigido com base na legislação brasileira; **não passou por advogado — recomende revisão**):

- Enquadramento como Equipamento de Mobilidade Individual Autopropelido, Resolução CONTRAN nº 996/2023 (motor ≤ 1.000 W, velocidade máxima de fabricação ≤ 32 km/h, dispensa de registro, licenciamento e habilitação).
- Responsabilidade solidária do locatário por todos os equipamentos do contrato.
- Excedente por fração, com tolerância declarada.
- Vistoria fotográfica de saída e entrada como prova de estado, com as ressalvas anotadas no corpo do contrato.
- Avaria conforme tabela de peças anexa, prevalecendo o valor efetivo do reparo quando inferior.
- Furto, roubo e não devolução: valor de reposição, comunicação imediata e BO em 24 h.
- LGPD, art. 7º II e V, incluindo imagens da vistoria e assinatura, com prazo de eliminação.
- Assinatura eletrônica: MP nº 2.200-2/2001, art. 10, §2º. Registro de data, hora, canal, token e atendente responsável.
- Foro do domicílio do locatário (evita nulidade por abusividade no CDC).

**Atenção regulatória:** o enquadramento como autopropelido depende de o veículo respeitar 1.000 W e 32 km/h. Acima disso é ciclomotor e exige ACC ou CNH A, emplacamento e outra redação de contrato. O cliente afirmou estar dentro do limite; vale confirmar na nota fiscal.

### Assinatura eletrônica

Duas vias: **celular do cliente** (fluxo principal) e **balcão** (fallback). O protótipo tem uma simulação da tela do celular — o link e o QR estão desabilitados e marcados como inativos, porque exigem a aplicação publicada.

**Pendente de implementação real:** rota `/assinar/:token` que serve a tela de assinatura, grava a assinatura vinculada ao token e notifica o balcão (Realtime já disponível). O componente de canvas de assinatura já existe e é reutilizável.

---

## 6. Telas

| Tela | Conteúdo |
|---|---|
| **Painel** | KPIs; faixa de alerta do atraso mais crítico; veículos na rua agrupados por contrato, com cronômetro, barra de progresso e estado (em uso / terminando nos últimos 10 min / atrasado); alerta sonoro e notificação do navegador ao estourar. |
| **Caixa do dia** | Seletor de data; abertura com fundo de troco; entradas por forma de pagamento; saídas com categoria; fechamento com conferência de dinheiro; conferência cega de lacres; impressão do fechamento com linhas de assinatura. |
| **Frota** | Lista com filtro, lacre atual, status, nº de locações e faturamento por veículo; cadastro individual e em lote; botão de conferência da frota. |
| **Clientes** | Busca por nome, CPF ou telefone; histórico e total gasto. |
| **Histórico** | Locações com filtro por período; base, excedente, avaria e total; acesso às fotos de saída e entrada, ao contrato e ao estorno. |
| **Financeiro** | Demonstrativo de fluxo do mês (entradas por origem, saídas por categoria, resultado, margem); custos fixos recorrentes; movimento dia a dia com destaque do melhor dia; faturamento por veículo, tipo, pacote e forma de pagamento; exportação CSV. |
| **Usuários** | Lista da loja (nome, papel, último acesso); cadastro e edição de operador, atendente e gerente — PIN de 4 dígitos e situação ativo/bloqueado — mais a explicação de cada nível. Aba exclusiva do gerente. |
| **Configurações** | Empresa; tolerância; tabela de preços; tabela de peças; template do contrato; lacres; conferência da frota e histórico; divergências; trilha de auditoria; backup e restauração; sair da conta. |

Wizard de locação em 5 passos: veículos (seleção múltipla) → cliente → período → vistoria e lacre → contrato e assinatura.

Tema escuro e claro, alternável, preferência gravada por dispositivo. Escuro é o padrão: o painel é tela de vigilância, e os estados de cor precisam saltar.

---

## 7. Banco de dados

Ver `1-banco-de-dados.sql`. Resumo:

- `estado` — 1 linha (`id = 1`), `doc jsonb`, `versao bigint`.
- `eventos` — append-only. Policies: SELECT e INSERT para `authenticated`. Sem UPDATE, sem DELETE.
- `snapshots` — cópia diária do `doc`, gerada dentro da própria function de gravação (máx. 1 por dia).
- `salvar_estado(p_doc, p_versao, p_por)` → `(ok, versao, doc)`. `SELECT ... FOR UPDATE` na linha do estado; se `versao` divergir, retorna `ok = false` com o estado atual e **não grava**.
- Bucket `vistorias`, privado. Policies de SELECT e INSERT. Sem DELETE nem UPDATE.
- Realtime habilitado em `estado`.

> **Nota:** no SQL entregue, `salvar_estado` está como `security invoker`, de forma que o RLS do chamador se aplica. Se você mudar para `definer`, revise as policies.

Validado em ambiente real: gravação com versão correta retorna `ok=true`; com versão defasada retorna `ok=false` e preserva o estado; snapshot gerado automaticamente; advisor de segurança do Supabase sem apontamentos.

---

## 8. Dívida técnica e recomendações

Ordenado por urgência. O item 8.1 é bloqueante para produção.

### 8.1 O estado monolítico não escala — resolver antes de operar

O `doc` inteiro é reescrito a cada alteração (gravação debounced em 600 ms).

Estimativa com dados do cliente: ~50 locações/dia. Cada registro de locação, com metadados de fotos, danos e lacres, gira em torno de 800 bytes de JSON. Em um ano são ~18.000 locações, ou cerca de **15 MB só no array `locacoes`**. Com ~200 gravações por dia, isso significa trafegar na ordem de **3 GB/dia** de payload no fim do primeiro ano — para uma operação de uma loja.

Além do custo, isso estoura o plano gratuito do Supabase (500 MB de banco, 5 GB de egress/mês) em poucos meses e degrada a percepção de velocidade no balcão.

**Recomendação:** normalizar em tabelas (`veiculos`, `clientes`, `grupos`, `locacoes`, `despesas`, `caixas`, `lacres`, `divergencias`, `auditoria`) e manter em JSONB apenas configuração e catálogos pequenos (`config`, `tipos`, `pecas`, `contrato`). A tabela `eventos` já existente dá segurança para essa migração: o histórico de operações está registrado fora do `doc`.

Como paliativo, se precisar operar antes da refatoração: arquivar locações finalizadas com mais de 60 dias em tabela separada e mantê-las fora do `doc`.

### 8.2 Autenticação de operador é simplificada

- PIN de 4 dígitos **em texto claro** dentro do `doc`.
- Um único usuário Supabase Auth para a loja; a identidade do operador só existe na aplicação.
- Consequência: o campo "quem fez" na auditoria é confiável para uso gerencial, mas não é prova forte. Para um controle antifraude — que é justamente a motivação do módulo de lacres —, isso é frágil.

**Recomendação:** usuário Auth por operador, ou no mínimo hash do PIN (`bcrypt`) com verificação no servidor via RPC. E RLS por usuário nas tabelas normalizadas.

### 8.3 Sem retenção nem limpeza de fotos

O bucket cresce indefinidamente e não há rotina de expurgo. O contrato promete eliminação após o prazo prescricional. Implementar job de retenção.

### 8.4 Realtime substitui o estado inteiro

Ao receber UPDATE de outro dispositivo, o `DB` é trocado e as telas repintadas. O wizard em andamento (`W`) não é afetado porque vive em variável separada, mas modais abertos que leem `DB` podem exibir dado defasado. Baixa probabilidade na prática; some com a normalização.

### 8.5 Pendências funcionais conhecidas

- **Rota `/assinar/:token`** — assinatura remota real (seção 5).
- **QR Pix com valor exato por locação** — discutido com o cliente e não implementado. É a medida de maior impacto contra desvio de dinheiro, porque tira o numerário da mão do atendente. Prioridade alta do ponto de vista de negócio.
- **Multi-loja** — não existe. Hoje há um estado único. Entra naturalmente com a normalização.
- **NFS-e** — sem emissão. O cliente foi orientado a alinhar com o contador.
- **Indicadores por atendente** (faturamento por turno comparável, estornos por pessoa, diferenças de caixa recorrentes, veículo parado em dia de movimento) — especificado com o cliente, não construído. Complementa os módulos de lacre e inventário.
- **Comprovante para o cliente** com número do contrato, impresso ou por WhatsApp — especificado, não construído. Transforma o cliente em conferência da locação registrada.
- **Foto do documento e selfie do cliente** — especificado, não construído. Componente de captura já existe.
- **Rastreador com bloqueio remoto nas 10 motos** — decisão de compra do cliente, fora do software. Faixa de mercado levantada: R$ 40 a R$ 60/mês por veículo.
- **Sem testes automatizados no repositório.** Os cenários abaixo foram validados com scripts jsdom durante o desenvolvimento, mas não ficaram versionados. Vale reescrevê-los.

---

## 9. Cenários de teste validados

Reproduza estes casos — cobrem as regras que mais custam dinheiro se quebrarem.

**Preço e excedente**
1. Patinete 30 min devolvido em 47 min → base R$ 30,00 + excedente 17 min × R$ 1,00 = **R$ 47,00**.
2. Moto 15 min devolvida com 20 min de atraso → R$ 50,00 + 20 × R$ 2,50 = **R$ 100,00**.
3. Moto 60 min com 3 min de atraso e tolerância 5 → **R$ 150,00**, sem excedente.
4. 3 patinetes + 2 motos por 1 hora → **R$ 480,00**. Por 30 min → R$ 240,00. Por 15 min → R$ 160,00.

**Multi-veículo e devolução**
5. Contrato de 5 veículos: devolver 1 com avaria individualmente, depois os 4 restantes em grupo. Faturamento = 480 + valor da peça.
6. Após devolver todos, o grupo passa a `finalizado` e o painel fica vazio.

**Caixa**
7. Com caixa fechado, tanto nova locação quanto devolução são bloqueadas, com opção de abrir na hora e retomar a ação.
8. Fundo R$ 200 + entradas em dinheiro R$ 480 − saídas em dinheiro R$ 50 → esperado R$ 630. Contando R$ 620, o sistema acusa falta de R$ 10 e grava autor e horário.
9. Custo fixo de R$ 4.000 com vencimento dia 10 aparece sozinho no caixa daquele dia como "a pagar".

**Estorno**
10. Estornar locação de R$ 60 → faturamento do mês volta a R$ 0,00, o registro continua na lista marcado como estornada, o veículo volta para a loja.
11. Atendente não consegue estornar; gerente consegue.

**Lacres**
12. Saída sem informar lacre é bloqueada.
13. Informar lacre diferente do esperado: permite seguir e gera divergência nomeando veículo, esperado e informado.
14. Entrada recusa lacre inexistente, já rompido e aplicado em outro veículo.
15. Conferência cega com um número trocado gera divergência apontando o veículo correto.

**Inventário da frota**
19. Frota nunca conferida → painel exibe o aviso; após conferir, o aviso desaparece.
20. Código inexistente é recusado; código repetido avisa que já foi conferido.
21. Frota de 6 veículos com 1 alugado: conferir 4 → contadores mostram 4 encontrados, 1 na rua, 1 não visto.
22. Concluir com 1 faltante → divergência `veiculo_nao_encontrado` com o código, e resumo na tela.
23. Conferir um veículo marcado como `rua` → aviso imediato, e ao concluir gera `veiculo_na_loja_como_rua` nomeando a locação e o cliente.
24. Alterar `inventarioDias` muda o vencimento do aviso.

**Vistoria**
16. Com `exigirFoto` ativo, não avança sem pelo menos 1 foto por veículo.
17. A ressalva digitada na vistoria aparece no corpo do contrato assinado.

**Concorrência**
18. Gravar com versão defasada retorna `ok=false`, não sobrescreve, e o cliente assume o estado do servidor.

---

## 10. Deploy

O ambiente Supabase **já está provisionado e testado**. O schema foi aplicado, a function de gravação foi validada com caso de sucesso e caso de conflito, o bucket existe, o Realtime está ligado e o advisor de segurança não aponta nada. As chaves já estão no `index.html`.

**O que falta para entrar no ar:**

1. **Criar o usuário da loja** — Supabase → Authentication → Users → Add user. E-mail e senha à escolha do cliente, com **Auto Confirm User marcado** (sem isso o login não passa). Essa senha é do cliente; não foi criada por terceiros de propósito.
2. **Publicar o `index.html`** em qualquer host estático, com esse nome. Cloudflare Pages no plano gratuito permite uso comercial e serve bem — é arrastar o arquivo em Create a project → Upload assets. Netlify e similares também servem. Vercel Hobby **não**: os termos proíbem uso comercial.
3. **Primeiro acesso:** login da loja → criar o gerente com PIN → criar a frota → preencher dados da empresa em Configurações → preencher `urlBase` com `https://SEU-DOMINIO/assinar` → cadastrar atendentes → registrar o lote de lacres e aplicar na frota.

**Para rodar sem servidor** (desenvolvimento, demonstração, teste de mudança): abrir `app.html` no navegador. Mesma aplicação, dados em `localStorage`, nenhum risco para os dados reais.

**Atualizações:** publicar um `index.html` novo. Os dados não são afetados — vivem no Supabase, separados do host estático. Se você modificar `app.html`, regere o `index.html` aplicando os fragmentos de nuvem (`_nuvem.js`, `_fotos.js`, `_arranque.js`) no lugar da camada local; o processo está descrito nos próprios comentários dos fragmentos.

**Validação do `index.html` entregue:** testado com cliente Supabase simulado — login recusando senha errada, carga do estado, gravação via RPC, gravação de eventos no histórico imutável, upload de foto, e o caso de conflito de versão com recarga automática. Todos os módulos (lacres, inventário, divergências, tema) presentes e funcionais na versão de nuvem.

---

## 11. Contexto de negócio útil

- Operação em cidade de litoral. Pico em fins de semana e temporada.
- 200 patinetes e 10 motos. Motos valem ~R$ 11.000 cada; bateria de moto ~R$ 4.600.
- Sem caução e sem retenção de documento — decisão do dono.
- Todo pacote é pago antecipadamente.
- A tabela de peças tem ~25 valores levantados de fornecedores reais em julho/2026 e o restante é estimativa de mercado. **Precisa ser confirmada com o fornecedor dele antes de servir de base para cobrança.**
- Dois riscos declarados pelo dono, em ordem de preocupação: **desvio interno** (funcionário alugar sem registrar e ficar com o dinheiro) e não devolução por cliente. Os módulos de lacre, inventário e divergências existem por causa do primeiro — não são requisito genérico de controle de estoque, são antifraude interna. Considere isso antes de simplificá-los.
- O sistema será operado por atendentes com pouca familiaridade com software. Cada passo adicionado ao balcão custa tempo real de atendimento — a vistoria fotográfica já adiciona cerca de 20 segundos por locação, e existe a opção de desligá-la em Configurações justamente por isso.
