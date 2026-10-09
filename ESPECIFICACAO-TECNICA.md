# Sistema de Locação de Patinetes e Motos Elétricas
## Especificação técnica e handoff

**Versão:** 1.1 — setembro/2026
**Status:** MVP completo e testado. Banco provisionado. Faltam dois passos para entrar no ar — ver seção 10.
**Escala alvo:** 1 loja, ~200 patinetes + 10 motos elétricas, 2 a 4 dispositivos simultâneos.

---

## 1. O que é

Sistema de balcão para locação por tempo de equipamentos de mobilidade elétrica. Cobre o ciclo completo: pagamento e contrato com assinatura eletrônica no balcão, vistoria de saída e de chegada pelo link público no celular (fotos, etiqueta escaneada e horário), devolução com cobrança de excedente e avaria, caixa diário e demonstrativo financeiro. A identificação do veículo em saída e chegada é **sempre o QR da etiqueta** — não há número digitado em nenhum ponto.

Foi construído como protótipo validado com o dono da operação. **Toda regra de negócio aqui descrita foi acordada e testada com ele** — não são suposições. O que precisa de decisão técnica está marcado como tal na seção 8.

### Arquivos

| Arquivo | O que é |
|---|---|
| `index.html` | **É o que vai para produção.** Aplicação completa com persistência em Supabase. URL e chave pública já configuradas. Deploy é copiar este arquivo para um host estático. |
| `app.html` | Mesma aplicação com dados em `localStorage`. Serve para rodar offline, sem servidor, e para testar mudanças sem tocar em dados reais. Gerada a partir da mesma base. |
| `1-banco-de-dados.sql` | Schema Postgres, RLS, function de gravação e bucket de storage. Idempotente. |
| `proposta-visual.html` | Mockup do painel com dados fictícios. Só referência de design, não é código de produção. |
| `_estilo.css`, `_nuvem.js`, `_fotos.js`, `_inventario.js`, `_arranque.js` | Fragmentos usados para montar os HTML. Já estão embutidos. **Podem ser ignorados** ou usados como ponto de partida se você for modularizar. `app.html` + os fragmentos de nuvem geram o `index.html`. |

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
- **Login por e-mail + senha, dois níveis.** A sessão é um token HMAC assinado em `lib/auth.js`. A senha nunca vai para o servidor em texto claro nem fica guardada assim: o navegador deriva PBKDF2-SHA256 com salt de 16 bytes e 120 mil iterações, e o documento guarda só `salt` + `hash` — o servidor refaz a derivação e compara na hora de entrar. Existem dois níveis, **Administrador** e **Atendente**; os papéis antigos (`gerente`, `operador`) são convertidos na migração e o PIN de 4 dígitos foi removido. Ver seção 4.7 e a pendência da seção 8.2.
- **Bibliotecas só na CDN, sem build.** `qrcodejs` (QR do balcão e das etiquetas),
  `jspdf` (folha de etiquetas em PDF) e `@zxing/library` (leitor da etiqueta no
  celular, carregada sob demanda e só quando a câmera abre). São três `<script>` de
  terceiros, todos só no navegador: sem internet a tela avisa (não quebra), e o PDF cai
  para a folha de impressão. Ver seções 4.8 e 4.12.

---

## 3. Modelo de dados (objeto `DB`)

```js
{
  empresa: { nome, cnpj, endereco, telefone },

  config: {
    toleranciaMin,        // int, minutos de cortesia antes de cobrar excedente
    urlBase,              // base do link de assinatura
    exigirFoto,           // bool
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

  usuarios: [{ id, nome, email, papel: 'administrador'|'atendente', ativo,
               salt, hash,          // PBKDF2-SHA256, 120 mil iterações, hex
               criadoEm, ultimoAcesso }],

  auditoria: [{ id, ts, usuarioId, usuario, acao, detalhe, ref }],

  divergencias: [{ id, ts, tipo, detalhe, usuario, resolvida,
                   veiculoId?, esperado?, informado?, locacaoId?, inventarioId? }],

  inventarios: [{
    id, ts, usuario, duracaoSeg, totalFrota, encontrados,
    naRua:        [{ id, codigo }],                    // ausentes justificados
    faltando:     [{ id, codigo, tipo, status }],      // não encontrados
    achadosNaRua: [{ id, codigo }],                    // estavam na loja mas o sistema dizia alugado
    obs
  }],

  manutencoes: [{
    id, veiculoId, veiculoCodigo, tipoId,
    criadoEm, usuario, status: 'aberta'|'fechada',
    pecas:  [{ pecaId: id|null, nome, valor }],        // pecaId null = linha livre
    obs,
    fotos:  [{ id, caminho, legenda, ts }],
    concluidaEm?, concluidaPor?, obsConclusao?
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

- O sistema já vem com esses dois tipos. A loja pode criar **outros por marca/modelo**
  direto no formulário da Frota (**+ Veículo**, **Editar** e **Cadastrar em lote**),
  escolhendo `+ Novo tipo (marca e modelo)`: nome, tipo de origem, preço de cada duração e
  excedente por minuto — **cada modelo tem preço segmentado**. A tabela de peças do tipo de
  origem vem junto (dá para desmarcar) e os ajustes finos ficam em Configurações →
  Peças e Configurações → Tabela de preços, que também apaga tipo sem uso (recusa se há
  veículo ou locação no histórico). Criar e excluir tipo ficam na auditoria.
- O tipo novo entra em tudo que lê a lista de tipos: filtro da Frota, cadastro em lote,
  etiquetas, wizard, peças e contrato. Se os modelos tiverem durações diferentes, o
  passo 3 do wizard só oferece as **comuns** aos tipos selecionados.

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
- Estorno é exclusivo do papel `administrador`.

### 4.7 Papéis e acesso

Só existem dois níveis: **Administrador** e **Atendente**. Os papéis antigos são
convertidos na migração do documento (`papelDe`: `gerente` → administrador, o resto →
atendente), o campo `pin` é apagado e, se o nome do usuário parecer um e-mail, ele é
promovido a `email` da conta.

| Ação | Atendente | Administrador |
|---|---|---|
| Operar balcão e caixa | sim | sim |
| Abrir o registro de manutenção (peças e foto do veículo) | sim | sim |
| Excluir uma pendência da fila da vistoria (estorno em modo fila) | sim | sim |
| Ver o financeiro do mês | — | sim |
| Ver a seção Relatórios do mês no painel | — | sim |
| Ver a aba Manutenção, a aba Histórico e a aba Configurações | — | sim |
| Estornar locação ou lançamento | — | sim |
| Alterar preços e tabela de peças | — | sim |
| Concluir uma manutenção (devolver o veículo para a loja) | — | sim |
| Cadastrar usuários | — | sim |
| Tratar divergências | — | sim |
| Zerar o sistema | — | sim |

Regra de integridade: sempre deve existir pelo menos um administrador ativo.

**Uma tela de acesso só (e-mail + senha).** Quem tem as credenciais da loja
(`LOJA_EMAIL`/`LOJA_SENHA`) entra e recebe o papel que a conta já tiver no documento
(sem conta, `administrador`); quem foi cadastrado na aba *Usuários* entra com o e-mail
e a senha dele. Conta com `ativo === false` é recusada mesmo com a senha certa (e o
servidor responde `conta_bloqueada`, não "credenciais inválidas"). Erros possíveis:
`credenciais_ausentes` (400), `credenciais_invalidas` (401), `conta_bloqueada` (401),
`loja_nao_configurada` (503).

**Senha derivada, nunca guardada em claro.** O navegador calcula
`PBKDF2-SHA256(senha, salt, 120000 iterações, 256 bits)` com um salt aleatório de
16 bytes por usuário; o documento guarda `salt` e `hash` em hex e o servidor
(`lib/auth.js`) refaz exatamente a mesma derivação para comparar
(`crypto.pbkdf2Sync`). A comparação usa saída igual em tamanho, sem vazar diferença
pelo tempo. Teste J do `npm test` prova que navegador e servidor derivam a mesma
chave — se divergirem, ninguém entra pela conta cadastrada.

**Sessão no aparelho.** Depois de entrar, o token vale 12 h e o sistema abre direto no
painel: `arrancar` valida o token, `resolverSessao()` relê o papel pelo e-mail no
documento e só cai na tela de login se não houver sessão ou ela tiver expirado. Só se
pede a senha de novo ao expirar, ao sair ou em aparelho sem sessão.

**Atendente.** Opera o balcão — locação, devolução, vistoria, clientes e caixa do dia —
e **só enxerga quatro abas: Painel, Frota, Vistoria e Clientes**. As abas *Manutenção,
Histórico, Configurações, Financeiro e Usuários* estão na constante
`ABAS_SOMENTE_ADMIN`: `aplicarPermissoes` as esconde e as desliga, `irPara` manda de
volta ao painel se ele chegar por atalho, `renderHistorico` e `renderConfig` têm
trava própria dentro da função de desenho, `renderFinanceiro` e `renderRelatorios`
também, a seção *Relatórios do mês* nasce escondida no painel e o indicador de
faturamento do dia some. O que ele **pode** fazer sozinho é abrir o registro de
manutenção do veículo (peças e foto, seção 4.13) e excluir uma pendência da fila da
vistoria (seção 4.8) — nas duas, o veículo nunca saiu da locadora.

**Aba Manutenção (exclusiva do administrador).** Ver seção 4.13.

**Aba Usuários (exclusiva do administrador).** Criação e edição de usuários saíram de
*Configurações* para uma aba própria — é ali que se cadastra cada conta com **nome,
e-mail, senha (mínimo de 6 caracteres, única no sistema), nível e situação
ativo/bloqueado**. A edição deixa a senha em branco para manter a atual. O formulário
exige que o sistema continue com pelo menos um administrador ativo. Quem não é
administrador não vê a aba; se chegar por atalho (`irPara('usuarios')`), é mandado de
volta ao painel, e o botão de cadastrar continua atrás de `exigirAdministrador`.

**Seção Relatórios do mês (exclusiva do administrador).** Ver seção 4.11.

### 4.8 Vistoria fotográfica (link público no celular)

A vistoria saiu do balcão: quem fotografar e conferir a saída é o **celular**, pelo link
público `/vistoria/{token}`. O token é gerado uma vez (`config.vistoriaToken`), fica em
**Configurações → Link da vistoria** com QR Code para escanear, e é o mesmo todo dia —
quem tem o link **não entra no sistema**: só enxerga a fila e grava a vistoria. O
payload público não leva CPF, usuários nem o contrato, e o token é comparado sem vazar
diferença pelo tempo.

- **Pagamento — uma forma só ou uma por veículo.** No passo 3 o atendente escolhe entre
  **"Uma forma para toda a locação"** (padrão, o comportamento de sempre) e **"Forma por
  veículo"**: aparece a tabela com um select por patinete/moto do grupo, a soma de cada
  forma na hora e o botão **"Aplicar a forma padrão a todas"**. A forma vai para
  `loc.pagamento` de **cada** veículo — é exatamente o campo que `entradasDoDia()` (Caixa
  do dia), o Financeiro ("Forma") e a exportação CSV já leem — então a divisão aparece na
  apuração sem tratamento nenhum; `grupo.pagamento` guarda a forma única quando todas são
  iguais. Dividido, `{{pagamento}}` do contrato vira
  "Cartão de crédito (MOTO-02), Dinheiro (MOTO-01), Pix (PAT-001, PAT-002, PAT-003)", a
  lista de equipamentos traz **"— pago em {forma}"** em cada linha (o contrato já diz
  "conforme a discriminação por equipamento acima") e os resumos do balcão, da assinatura
  no celular e do link da vistoria passam a ter **uma linha por forma**. Com uma forma só,
  tudo continua idêntico ao de antes. O **excedente da devolução em grupo continua sendo
  cobrado com uma forma só** (seção 4.9).
- **Saída — "Vistoriado e liberar".** O balcão encerra a locação em **3 passos**
  (veículos → cliente → pagamento, contrato e assinatura); o botão final é
  **"Pagar e enviar para vistoria"**: grava `pagoEm`, contrato e assinatura, marca a
  locação como **pendente** e o grupo como `aguardando_vistoria`. O veículo **continua
  na loja, porém travado** para nova locação (`veiculoTravado` = existe locação
  pendente daquele veículo) e **nenhum relógio corre**. A tela
  final entrega o link com QR. No celular: até 3 fotos (Frente, Lateral, Detalhe),
  **leitura da etiqueta do patinete** e observações → a locação vira `ativa` com a hora
  real de saída, o veículo sai para `rua`, `fotosSaida` é gravada em `public.fotos` e o
  relógio começa a contar. **Não existe campo de lacre em nenhum ponto**: quem escaneou
  a etiqueta identificou o veículo físico (seção 4.9), então não há número a digitar nem
  divergência a registrar.
- **Etiqueta do patinete (QR ou código de barras).** A etiqueta colada no veículo leva
  **só o código** (`PAT-001`), gerado na seção **QR Codes** de *Configurações* (seção 4.12). No cartão da
  vistoria há um botão **Escanear código do patinete** (e no topo da página, **Escanear
  patinete**): abre um visor escuro com mira e a câmera lê pela **ZXing**
  (`BrowserMultiFormatReader.decodeFromVideoDevice`, CDN carregada sob demanda e
  parada ao fechar). Sem permissão de câmera ou em aparelho sem leitor, o rodapé do
  visor oferece **Digitar o código** — a etiqueta é curta (`PAT-001`). A leitura é
  normalizada (espaços, caixa, prefixo `veeloway:` e link) e **conferida no servidor**
  nos dois casos (`liberar` e `chegada`): código vazio → `400 veiculo_nao_escaneado`;
  código de outro patinete → `409 veiculo_incorreto`, com o código lido e o esperado na
  mensagem. Lido certo, o cartão mostra "✓ PAT-001 identificado", pulsa e o servidor
  grava. Ler de cima (botão do topo) localiza o cartão na fila pelo código e preenche a
  identificação sozinho.
- **Chegada — "Registrar chegada".** Pelo mesmo link: fotos da entrega, estado
  (loja / manutenção) e observações → a locação vira `devolvida` com `fimReal`
  naquela hora (o relógio para) e o veículo volta para `loja`. **A cobrança de
  excedente e de avaria continua sendo fechada no balcão**, na tela de entrada, que já
  lê `fotosEntrada`, `obsVistoria` e a hora registrada no celular.
- **Excluir da fila (estorno em modo fila).** O cartão *pago aguardando liberação* tem
  o botão **Excluir** (`excluirDaFila` → `estornarLocacao(id, { fila: true })`). O modo
  fila serve **só para locação pendente** e **não exige administrador** — quem paga
  tira da fila e ninguém saiu da locadora. O valor sai do faturamento e das entradas
  do dia, a locação vira `estornada` com `estorno.fila = true`, motivo, detalhe,
  usuário e hora, e a auditoria grava `fila_excluida`; se era a última pendência (sem
  na rua) do contrato, o grupo fecha junto. Nada é apagado.
- **A aba Vistoria do balcão guarda só o link.** Cabeçalho com **Copiar link** e o
  link público num `linkbox`; **sem QR e sem botão de WhatsApp** — os dois continuam
  em **Configurações → Link da vistoria**, junto com *Gerar novo link*
  (`gerarNovoLinkVistoria`), que é quem redesenha o QR (`#cfgVistQr`).
- **Vistoriadas hoje abre as fotos da saída.** A coluna *Fotos* é um botão com as
  miniaturas (até 3) e a contagem; o clique chama `verFotos(id, 'saida')` e abre as
  imagens daquela saída com legenda e hora. Como o atendente **não tem a aba
  Histórico**, é por ali que ele confere a vistoria de saída.
- **A chegada registrada só existe com o caixa aberto.** O bloco `#vistCardFecha` é
  desenhado só quando `caixaAberto()` é verdadeiro; **ao fechar o caixa**, toda locação
  em `devolvida` do dia vira `finalizada` (com `atendenteEntrada`, grupo fechado e log
  `chegadas_encerradas`) e o bloco some — **sem lançar cobrança nova**: o que era
  devido foi cobrado antes da saída, no balcão de entrada. O excedente e a avaria de
  quem ainda está na rua continuam sendo cobrados na tela de entrada
  (`abrirDevolucao`, que continua acessível pelo Painel e pela Frota enquanto a
  locação está `ativa`).
- **No celular, quadro de três colunas.** `vistoria.html` virou um `.kanban` com
  **a vistoriar**, **na rua** e **entregues** (mesmos ids `#fila`, `#rua`, `#hoje`).
  No celular as colunas correm na horizontal com `scroll-snap` (uma por vez); a partir
  de 900 px as três abrem lado a lado. A coluna *entregues* só recebe as chegadas
  enquanto a API entregar `caixaAberto !== false` (helper `caixaAberto(db, diaHoje)` em
  `api/vistoria.js`); fechou, ela limpa sozinha e as entregas ficam no histórico.
- Mínimo de **1 foto por veículo**, configurável em `config.exigirFoto`.
- Compressão no cliente: maior lado 900px, JPEG qualidade 0,55; no servidor o limite é
  600 KB por imagem e o caminho é `vistoria/{locacaoId}/…` (URL assinada de 6 h).
- A página `vistoria.html` não tem tela de login, é `noindex`, relê a fila a cada 8 s e
  **não redesenha** enquanto houver foco em foto ou em campo digitando. A gravação
  (`api/vistoria.js`) passa pelo lock otimista (`salvar_estado`) e só aceita `liberar`
  e `chegada`; token/ação/locação inválidos respondem 401/400/404. A logo dessa página
  (e da assinatura) entra em caminho **absoluto** (`/assets/…`): as duas abrem sob
  `/vistoria/{token}` e `/assinar/{token}`, onde o caminho relativo daria 404.
- Existe para sustentar a cobrança de avaria. O contrato tem cláusula em que o cliente
  declara ter visto as imagens e concordar que retratam o estado do equipamento.
- **Foto do documento do cliente.** Na tela do cliente da locação anexa-se a imagem da
  CNH, RG ou passaporte — pela câmera do aparelho **ou por upload** de arquivo já
  existente (foto, scan ou arquivo). A obrigatoriedade é configurável em dois níveis:
  globalmente em Configurações (`config.exigirDocFoto`) e por locação, para a
  atendente exigir na alta temporada ou diante de um cliente com comportamento
  duvidoso. A foto vai para a ficha do cliente e volta sozinha na locação seguinte.

### 4.9 Identificação do veículo (QR da etiqueta)

O módulo de **controle de lacres foi removido** — estoque, aplicação, rompimento,
conferência cega e as divergências `lacre_*` não existem mais em nenhuma tela, no
documento nem na API. O que responde ao mesmo risco hoje é a etiqueta:

- Todo veículo parado na loja tem etiqueta com QR (`PAT-001`), gerada na seção
  **QR Codes** de *Configurações* (seção 4.12). O QR leva **só o código** — é o que o
  celular lê.
- **Na saída e na chegada**, a vistoria exige a leitura da etiqueta: sem etiqueta
  lida → `400 veiculo_nao_escaneado`; etiqueta de outro patinete →
  `409 veiculo_incorreto`, com o código lido e o esperado na mensagem. Nenhum número é
  digitado e nenhum campo de lacre nasce no documento.
- A identificação é **quem escaneou e em que momento** — mesma informação que o lacre
  registrava, agora sem número para trocar nem estoque para burlar.
- Divergências continuam existindo, mas só as de contagem: `contagem`,
  `veiculo_nao_encontrado` e `veiculo_na_loja_como_rua` (seção 4.10).

Migração automática no primeiro carregamento: apaga `DB.lacres`,
`config.exigirLacre` e os campos `lacreEsperado` / `lacreSaida` / `lacreEntrada` de
todas as locações.

### 4.10 Inventário da frota

Segunda camada da conferência física: o inventário cobre **a frota inteira**, e responde à pergunta "sumiu algum veículo?".

- Periodicidade esperada configurável em `config.inventarioDias`, padrão **7 dias**. O painel exibe aviso quando vence, e quando nunca houve conferência.
- A contagem é feita **por entrada de código**, não por lista marcável: o operador digita ou lê o código de cada veículo que encontrou fisicamente. Escolha deliberada — com 210 veículos, uma lista de checkboxes é lenta e convida a marcar tudo sem olhar.
- A lista de pendentes começa **oculta**, atrás de um botão — a contagem só vale alguma coisa se o operador não tiver a resposta na mão.
- Veículos com `status = 'rua'` são **justificados automaticamente** e não contam como faltantes.
- Existe atalho "marcar tudo como encontrado", com confirmação. Foi incluído para conferência visual em bloco; o cliente foi orientado a reservar o inventário para o administrador, não para quem opera o balcão.

Dois resultados geram divergência:

| Situação | Tipo | Significado |
|---|---|---|
| Deveria estar (loja ou manutenção) e não foi encontrado | `veiculo_nao_encontrado` | Possível desaparecimento. |
| Foi encontrado na loja, mas o sistema diz `rua` | `veiculo_na_loja_como_rua` | Quase sempre **devolução não registrada**. A divergência nomeia a locação aberta e o cliente, com orientação de conferir se o dinheiro entrou. |

O inventário **não altera o status de nenhum veículo automaticamente.** Só registra. A correção é decisão humana, via apuração da divergência.

Histórico completo em Configurações: data, autor, total da frota, conferidos, na rua, faltantes com códigos e observações.

### 4.11 Relatórios do mês

Seção recolhível dentro do **Painel**, exclusiva do administrador (nasce fechada e só
aparece para ele). Enquanto o
*Financeiro* responde "deu lucro?", o *Relatórios* responde "como foi o mês?".

- Seletor de mês (`type="month"`, padrão = mês corrente) redesenha a página ao trocar.
- **KPIs:** viagens, faturamento, ticket médio e dias com movimento.
- **Clientes que mais viajaram:** ranking com nº de viagens e faturamento; o
  primeiro entra destacado. Limite de 8 linhas na tela.
- **Melhor dia:** dias do mês ordenados por faturamento (desempate por nº de viagens),
  com dia da semana ao lado. Limite de 8 linhas.
- **Horário de pico:** as faixas de hora com movimento, ordenadas pela maior, com
  barra proporcional (`n / máximo`) e a faixa seguinte indicada ("10h às 11h").
- **Resumo em uma coluna:** viagens, faturamento, ticket médio, dias com movimento,
  viagens por dia ativo, melhor dia, cliente destaque e hora mais movimentada.

Cálculo (`relatorioDoMes(mes)`): soma `DB.locacoes` cujo `mesKey(inicio)` é o mês
escolhido e que não estão estornadas; faturamento por `totalLoc()` (base + excedente +
avaria); horas pelo `getHours()` do `inicio`. Mês vazio devolve zeros e `null`, e as
três tabelas mostram linha de "sem movimento" — a tela nunca quebra. Defesa dupla:
a seção do painel já nasce oculta para o atendente e `renderRelatorios()` retorna cedo
se não for administrador.

### 4.12 Etiquetas QR da frota

A seção **QR Codes**, dentro de **Configurações** (recolhida por padrão, com um clique
para expandir), gera a etiqueta colada em cada
patinete. O QR leva **só o código do veículo** (`PAT-001`) — é o que o celular da
vistoria lê e o que o servidor confere (seção 4.8). Prefixar o conteúdo mudaria o que o
servidor espera, então o texto é exatamente `v.codigo`.

- **Fonte do QR:** `qrFonte(texto)` cria um `QRCode` temporário (qrcodejs, `CorrectLevel.M`)
  e lê a matriz do modelo interno (`_oQRCode.getModuleCount()` / `isDark(r,c)`), com
  cache por texto. **Fallback:** se a matriz não estiver acessível, guarda o `<canvas>`
  gerado (660 px) e o usa como imagem. Sem `window.QRCode` (sem internet) devolve
  `null` e a tela mostra *“QR indisponível”* em vez de quebrar.
- **Saídas da mesma folha A4** (3 × 6 células de 70 × 49,5 mm, etiqueta de 66 × 46 mm):
  - **PDF** — jsPDF (`jspdf.umd.min.js` via CDN, `unit:'mm'`, `format:'a4'`); cada
    módulo escuro do QR vira um `rect` **vetorial**, com os módulos contíguos da mesma
    linha fundidos num retângulo só (`run-length`), o que reduz o tamanho do arquivo.
  - **SVG** — montado à mão a partir da mesma matriz: um único `<path>` por etiqueta,
    `viewBox` em unidades de módulo, `shape-rendering="crispEdges"`. Folha inteira num
    arquivo só, com a altura em nº de páginas.
  - **PNG** — `canvas` a 200 dpi, até 2 folhas (36 etiquetas) por arquivo; acima disso
    avisa para usar o PDF.
  - **Imprimir folha** — a mesma grade em HTML no `#printarea` do sistema (QR em
    `<svg>`), com `page-break` por folha, e `window.print()`. É o fallback quando o
    jsPDF não carregar.
- **Na Frota**, a linha de cada veículo tem o botão **Etiqueta** (`baixarEtiqueta(id)`),
  que baixa o PNG daquele patinete (66 × 46 mm a 300 dpi).
- **Cadastrar em lote** termina oferecendo **“Gerar etiquetas”**: grava os ids criados
  em `etqFoco`, abre a seção de *Configurações* (`abrirSecaoEtiquetas`) e filtra a grade
  só para aquela frota nova (o botão *Ver toda a frota* limpa o filtro).
- A grade mostra até 60 pré-visualizações (SVG) e informa a quantidade de etiquetas e
  de folhas A4; busca por código e filtro por tipo.

### 4.13 Manutenção de veículos

A aba **Manutenção** (logo depois de *Frota* na navegação, exclusiva do administrador
— `ABAS_SOMENTE_ADMIN`) guarda o conserto de cada veículo parado. O registro mora em
`DB.manutencoes`, com `seq.manutencao` (seção 3).

- **Lista** — duas tabelas: **Em manutenção** (veículo, tipo, desde quando, as peças,
  as fotos, a observação e os botões **Peças e foto** e **Concluir**) e **Concluídas**
  (as mesmas colunas, com quem abriu, quem concluiu e as duas datas).
  `renderManutencao` tem trava própria de administrador.
- **Abrir o registro** (`abrirManutencao`) — marca as peças na tabela de peças do
  tipo do veículo (`DB.pecas` filtrado por `tipoId`), com o valor ao lado, mais a
  linha livre **Outra (digitar)**; a observação; e até 3 fotos (`LEG_VIST`, o mesmo
  `painelFotos`/`ligarFotos` das demais telas, miniatura via `Fotos.obter`). O
  registro nasce `status: 'aberta'`, com `criadoEm`, `usuario` e `veiculoCodigo`;
  salvar de novo atualiza o mesmo registro. **O atendente também pode abrir** (sem
  `exigirAdministrador`): escolher *Manutenção* como status no cadastro do veículo
  abre o quadro logo em seguida (`virouManut`), e a vistoria de chegada marcada como
  *manutenção* já aparece na aba sem detalhamento, com o botão **Peças e foto**.
- **Concluir** (`concluirManutencao`) — exige dizer o que foi feito; então o veículo
  volta para `loja`, os registros abertos viram `fechada` com `concluidaEm`,
  `concluidaPor` e `obsConclusao`, e a auditoria grava `manutencao_concluida`
  (`manutencao_aberta` e `manutencao_atualizada` ao abrir e ao salvar).
- **Espelho no app offline** — `app.html` tem a mesma aba, as mesmas funções e a
  migração do banco local; só a trava de papel não existe lá, porque o demo não tem
  login.

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
| **Painel** | KPIs; faixa de alerta do atraso mais crítico; veículos na rua agrupados por contrato, com cronômetro, barra de progresso e estado (em uso / terminando nos últimos 10 min / atrasado); alerta sonoro e notificação do navegador ao estourar; **locações abertas** agrupadas por contrato com botão de entrada; **Caixa do dia** (seção recolhível) e **Relatórios do mês** (seção recolhível, só administrador). |
| **Caixa do dia** | Seção dentro do Painel, recolhível: seletor de data; abertura com fundo de troco; entradas por forma de pagamento; saídas com categoria; fechamento com conferência de dinheiro; impressão do fechamento com linhas de assinatura. |
| **Frota** | Lista com filtro (busca, **tipo** e status), status, nº de locações e faturamento por veículo; cadastro individual e em lote — os dois com **`+ Novo tipo (marca e modelo)`**, que cria o tipo com preço próprio na hora (seção 4.1); botão de conferência da frota; **botão *Etiqueta* por linha** (PNG da etiqueta QR daquele patinete). Veículo com locação pendente aparece travado, com pill *aguardando vistoria* e atalho para a fila. |
| **QR Codes** | Seção recolhível no topo de **Configurações** (a navegação não tem mais essa aba): etiquetas da frota, grade de pré-visualização com busca e filtro por tipo, contagem de etiquetas e de folhas A4, e quatro saídas da mesma folha (3 × 6): **Baixar PDF**, **PNG**, **SVG** e **Imprimir folha**. Clicar em *Ver toda a frota* limpa o filtro do atalho do lote. |
| **Manutenção** | Duas tabelas: **Em manutenção** (peças marcadas na tabela do tipo, mais a linha livre *Outra*, fotos, observação, e os botões **Peças e foto** e **Concluir**) e **Concluídas** (quem abriu, quem concluiu e as duas datas). Abre sozinha ao escolher *Manutenção* no cadastro do veículo (seção 4.13). Exclusiva do administrador. |
| **Vistoria** | Cabeçalho com **Copiar link** e o link público (**sem QR e sem WhatsApp** — os dois ficam em Configurações); quatro blocos: pago aguardando liberação (com **Excluir**, que estorna a pendência e devolve o veículo), na rua (com fechamento no balcão), chegada registrada (**só com o caixa do dia aberto**) e vistoriadas hoje (**com as fotos da saída clicáveis**). No celular, cada cartão tem **Escanear código do patinete** e há **Escanear patinete** no topo; a página é um quadro de três colunas (seção 4.8). |
| **Clientes** | Busca por nome, CPF ou telefone; histórico e total gasto; *Editar* e *Excluir* o cadastro — a exclusão é recusada com devolução em aberto, avisa que o histórico mantém nome e CPF, e vai para a auditoria. |
| **Histórico** | Locações com filtro por período; base, excedente, avaria e total; acesso às fotos de saída e entrada, ao contrato e ao estorno. |
| **Financeiro** | Demonstrativo de fluxo do mês (entradas por origem, saídas por categoria, resultado, margem); custos fixos recorrentes; movimento dia a dia com destaque do melhor dia; faturamento por veículo, tipo, pacote e forma de pagamento; exportação CSV. Exclusiva do administrador. |
| **Relatórios** | Seção recolhível do Painel, com fechamento do mês numa tela: viagens, faturamento, ticket médio, dias com movimento, ranking de clientes, melhor dia, horário de pico com barra e resumo em uma coluna. Seletor de mês. Exclusiva do administrador (seção 4.11). |
| **Usuários** | Lista da loja (nome, e-mail, papel, último acesso); cadastro e edição de conta — e-mail, senha (mínimo 6, única), nível Atendente ou Administrador e situação ativo/bloqueado — mais a explicação de cada nível. Aba exclusiva do administrador. |
| **Configurações** | Seção **QR Codes** recolhida no topo; empresa; tolerância; tabela de preços; tabela de peças; template do contrato; conferência da frota e histórico; divergências; **link da vistoria (QR, copiar, WhatsApp, gerar novo)**; trilha de auditoria; backup e restauração; sair da conta. |

Wizard de locação em **3 passos**: veículos (seleção múltipla) → cliente → pagamento,
contrato e assinatura. No passo 3 a forma de pagamento pode ser **uma só para toda a
locação ou uma por veículo** (seção 4.8). O botão final **"Pagar e enviar para vistoria"**
grava o pagamento, deixa a locação pendente, trava o veículo e entrega o link público da
vistoria (seção 4.8).

Tema escuro e claro, alternável, preferência gravada por dispositivo. Escuro é o padrão: o painel é tela de vigilância, e os estados de cor precisam saltar.

**Identidade visual — VeeLo Way · Mobilidade Urbana: amarelo e preto.** O logo
(`assets/logo-veeloway.jpeg`) entra como favicon, na barra do topo, na tela de acesso
(e-mail + senha), na assinatura eletrônica que o cliente abre no celular e na página da
vistoria — nestas duas últimas em caminho **absoluto** (`/assets/…`), porque abrem sob
`/assinar/{token}` e `/vistoria/{token}`, onde o relativo daria 404. As cores
vêm das variáveis do tema: `--brand` (amarelo) e `--ink` (preto usado por cima do
amarelo), iguais nos dois temas; `--brand-fg` resolve o texto da marca em fundo claro,
onde amarelo não teria contraste. Regra: **texto sobre amarelo é sempre `--ink`**, nunca
branco — botão principal, aba ativa e cabeçalho de total.
O nome padrão da empresa também é a marca: lojas que ainda guardam o nome de fábrica
("Minha Locadora") são renomeadas para **VeeLo Way** quando o estado é carregado.

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

Estimativa com dados do cliente: ~50 locações/dia. Cada registro de locação, com metadados de fotos e danos, gira em torno de 800 bytes de JSON. Em um ano são ~18.000 locações, ou cerca de **15 MB só no array `locacoes`**. Com ~200 gravações por dia, isso significa trafegar na ordem de **3 GB/dia** de payload no fim do primeiro ano — para uma operação de uma loja.

Além do custo, isso estoura o plano gratuito do Supabase (500 MB de banco, 5 GB de egress/mês) em poucos meses e degrada a percepção de velocidade no balcão.

**Recomendação:** normalizar em tabelas (`veiculos`, `clientes`, `grupos`, `locacoes`, `despesas`, `caixas`, `divergencias`, `auditoria`) e manter em JSONB apenas configuração e catálogos pequenos (`config`, `tipos`, `pecas`, `contrato`). A tabela `eventos` já existente dá segurança para essa migração: o histórico de operações está registrado fora do `doc`.

Como paliativo, se precisar operar antes da refatoração: arquivar locações finalizadas com mais de 60 dias em tabela separada e mantê-las fora do `doc`.

### 8.2 Identidade mora no documento

- E-mail, nível, `salt` e `hash` dos usuários vivem dentro do `doc` versionado — não há provedor de identidade por pessoa, nem sessão gerenciada por dispositivo.
- O servidor assina e valida o token, mas o papel é relido do próprio documento: quem tem acesso à gravação do `doc` pode alterar níveis (o lock otimista e a auditoria mitigam, não eliminam).
- Não há segundo fator. Para o controle antifraude (QR da etiqueta na saída e na chegada + inventário da frota), isso continua não sendo prova forte.

**Recomendação:** provedor de identidade por pessoa (usuário real por atendente) com sessão gerenciada, MFA opcional e RLS por usuário nas tabelas normalizadas da seção 8.1. O formato `salt` + `hash` PBKDF2 já está pronto para ser carregado por um provedor sem mudar a tela de login.

### 8.3 Sem retenção nem limpeza de fotos

O bucket cresce indefinidamente e não há rotina de expurgo. O contrato promete eliminação após o prazo prescricional. Implementar job de retenção.

### 8.4 Realtime substitui o estado inteiro

Ao receber UPDATE de outro dispositivo, o `DB` é trocado e as telas repintadas. O wizard em andamento (`W`) não é afetado porque vive em variável separada, mas modais abertos que leem `DB` podem exibir dado defasado. Baixa probabilidade na prática; some com a normalização.

### 8.5 Pendências funcionais conhecidas

- **Rota `/assinar/:token`** — assinatura remota real (seção 5).
- **QR Pix com valor exato por locação** — discutido com o cliente e não implementado. É a medida de maior impacto contra desvio de dinheiro, porque tira o numerário da mão do atendente. Prioridade alta do ponto de vista de negócio.
- **Multi-loja** — não existe. Hoje há um estado único. Entra naturalmente com a normalização.
- **NFS-e** — sem emissão. O cliente foi orientado a alinhar com o contador.
- **Indicadores por atendente** (faturamento por turno comparável, estornos por pessoa, diferenças de caixa recorrentes, veículo parado em dia de movimento) — especificado com o cliente, não construído. Complementa o inventário e as divergências.
- **Comprovante para o cliente** com número do contrato, impresso ou por WhatsApp — especificado, não construído. Transforma o cliente em conferência da locação registrada.
- **Foto do documento e selfie do cliente** — especificado, não construído. Componente de captura já existe.
- **Rastreador com bloqueio remoto nas 10 motos** — decisão de compra do cliente, fora do software. Faixa de mercado levantada: R$ 40 a R$ 60/mês por veículo.
- **Fechamento do caixa encerra as chegadas sem cobrança nova.** Todas as locações
  `devolvida` do dia viram `finalizada` no fechamento (seção 4.8). Se o balcão deixar
  passar, **excedente e avaria de uma chegada já registrada não são cobrados** — não
  há mais tela de entrada para ela. Hoje a cobrança é feita antes da saída, no
  balcão de entrada. Defesa possível: rodar `abrirDevolucao` para essas locações
  antes de fechar, ou lançar a diferença na hora.
- **Atendente pode excluir pendências da fila.** O modo fila do estorno (seção 4.8)
  dispensa o administrador porque o veículo nunca saiu da locadora. É decisão do
  operador: para exigir senha do administrador, trocar `!fila &&` por
  `exigirAdministrador(...)` em `estornarLocacao`.
- **Testes automatizados versionados.** `npm test` cobre as regras de dinheiro, sessão,
  senha, papéis, relatórios, identidade, vistoria, a operação enxuta e o banco
  (transação descartada); `npm run verificar` repete a operação no site publicado
  (inclui a vistoria pública). Os cenários abaixo estão no script — vale mantê-los em
  dia ao mudar regra.

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
11. Atendente não consegue estornar nem abrir o financeiro; administrador consegue.

**Acesso e relatórios**
25. Senha errada devolve 401 e não abre sessão; conta bloqueada é recusada mesmo com a senha certa.
26. Usuário cadastrado entra pelo e-mail (sem diferenciar maiúsculas); navegador e servidor derivam a mesma chave.
27. Atendente não vê as abas Financeiro e Usuários nem a seção Relatórios do mês do painel — e, se chegar por atalho, volta para o painel.
28. Relatório do mês conta só as viagens não estornadas daquele mês; mês vazio devolve zeros nas quatro tabelas.

**Identificação pela etiqueta (sem lacre)**
12. Saída sem ler a etiqueta do patinete é bloqueada (`400 veiculo_nao_escaneado`).
13. Etiqueta de outro patinete na saída é recusada (`409 veiculo_incorreto`, com os dois códigos na mensagem); com a certa a locação libera e **nenhum campo de lacre nasce no documento**.
14. A página da vistoria e `api/vistoria.js` não citam lacre em ponto algum, e nenhuma divergência `lacre_*` é criada.

**Inventário da frota**
19. Frota nunca conferida → painel exibe o aviso; após conferir, o aviso desaparece.
20. Código inexistente é recusado; código repetido avisa que já foi conferido.
21. Frota de 6 veículos com 1 alugado: conferir 4 → contadores mostram 4 encontrados, 1 na rua, 1 não visto.
22. Concluir com 1 faltante → divergência `veiculo_nao_encontrado` com o código, e resumo na tela.
23. Conferir um veículo marcado como `rua` → aviso imediato, e ao concluir gera `veiculo_na_loja_como_rua` nomeando a locação e o cliente.
24. Alterar `inventarioDias` muda o vencimento do aviso.

**Vistoria**
16. Com `exigirFoto` ativo, a liberação pelo celular não avança sem pelo menos 1 foto por veículo.
17. A observação digitada na vistoria do celular aparece na tela de entrada do balcão.
29. "Pagar e enviar para vistoria" grava a locação como pendente, o veículo fica travado na loja e nenhum relógio corre até a liberação.
30. Sem sessão e sem token (ou com token errado) a fila não abre (401); o payload público não traz CPF, usuários nem contrato.
31. Liberar torna a locação ativa com a hora real, tira o veículo para a rua e começa a contagem; a chegada para o relógio na hora do celular e devolve o veículo para a loja.
32. Liberação e chegada não gravam campo algum de lacre: o documento da locação fica com fotos, observações e horários — a identificação é o QR escaneado.
33. Sem ler a etiqueta, a liberação não sai (`400 veiculo_nao_escaneado`); lendo o código de outro patinete, `409 veiculo_incorreto`.
34. Leitura com espaço, caixa diferente ou link (`https://…/PAT-001`) conta como o mesmo código; o cartão mostra a identificação e o cartão pisca.

**Etiquetas QR da frota**
35. A seção QR Codes (dentro de Configurações) lista a frota (busca e filtro por tipo), informa nº de etiquetas e folhas A4 e mostra as pré-visualizações em SVG; recolhida por padrão, expande com um clique.
36. Baixar PDF gera A4 com 3 × 6 etiquetas e QR em retângulos vetoriais; Imprimir folha usa o `#printarea` com quebra de página; PNG sai até 2 folhas por arquivo; SVG sai folha inteira (todas as páginas).
37. Cada linha da Frota baixa a etiqueta daquele patinete em PNG (66 × 46 mm); "Cadastrar em lote" abre a oferta de etiquetas e filtra a grade pela frota nova, com *Ver toda a frota* para voltar.
38. Sem internet, a tela avisa “QR indisponível” em vez de quebrar, e o PDF cai para a folha de impressão.

**Forma de pagamento por veículo**
39. Passo 3 com "Forma por veículo": 3 patinetes no Pix, uma moto em dinheiro e outra no crédito → cada locação grava a sua forma e o fechamento do dia separa as três (Pix, Dinheiro, Cartão de crédito) além do total.
40. "Aplicar a forma padrão a todas" iguala as linhas da tabela; voltando para "Uma forma para toda a locação" o resumo volta a ser uma linha só, idêntica à de antes. O contrato dividido traz a forma em cada equipamento; o excedente da devolução em grupo continua com um select único.

**Tipos de veículo (marca/modelo)**
41. No cadastro de veículo (e em *Editar* e *Cadastrar em lote*), trocar o Tipo por `+ Novo tipo (marca e modelo)` abre o bloco com nome, tipo de origem, preço de cada duração e excedente; salvar cria o tipo, grava o veículo com ele e o tipo já aparece no filtro da Frota, no lote, nas peças e no wizard — com preço próprio (ex.: 15 min a R$ 25,00 e excedente a R$ 1,80).
42. A tabela de peças vem copiada do tipo de origem (dá para desmarcar); Configurações → Tabela de preços edita o preço do tipo novo e o apaga **só** quando está sem veículo e sem histórico, com confirmação — recusa com aviso quando há veículo ou locação. Criar e excluir ficam na auditoria. Com durações diferentes entre modelos, o passo 3 só oferece as comuns.

**Clientes**
43. A linha do cliente tem *Editar* e *Excluir*. Excluir com devolução em aberto é recusado com o motivo na hora; com histórico, a confirmação avisa que nome e CPF já gravados em cada locação seguem lá e some só a ficha; confirmado, as locações ficam intactas e a ação vai para a auditoria (`cliente_excluido`). Sem locação nenhuma, a confirmação é só o nome.

**Concorrência**
18. Gravar com versão defasada retorna `ok=false`, não sobrescreve, e o cliente assume o estado do servidor.

---

## 10. Deploy

O ambiente Supabase **já está provisionado e testado**. O schema foi aplicado, a function de gravação foi validada com caso de sucesso e caso de conflito, o bucket existe, o Realtime está ligado e o advisor de segurança não aponta nada. As chaves já estão no `index.html`.

**O que falta para entrar no ar:**

1. **Criar o usuário da loja** — Supabase → Authentication → Users → Add user. E-mail e senha à escolha do cliente, com **Auto Confirm User marcado** (sem isso o login não passa). Essa senha é do cliente; não foi criada por terceiros de propósito.
2. **Publicar o `index.html`** em qualquer host estático, com esse nome. Cloudflare Pages no plano gratuito permite uso comercial e serve bem — é arrastar o arquivo em Create a project → Upload assets. Netlify e similares também servem. Vercel Hobby **não**: os termos proíbem uso comercial.
3. **Primeiro acesso:** entrar com `LOJA_EMAIL` / `LOJA_SENHA` → criar a frota → preencher dados da empresa em Configurações → preencher `urlBase` com `https://SEU-DOMINIO/assinar` → na aba **Usuários** cadastrar as contas da loja (e-mail, senha, nível).

**Para rodar sem servidor** (desenvolvimento, demonstração, teste de mudança): abrir `app.html` no navegador. Mesma aplicação, dados em `localStorage`, nenhum risco para os dados reais.

**Atualizações:** publicar um `index.html` novo. Os dados não são afetados — vivem no Supabase, separados do host estático. Se você modificar `app.html`, regere o `index.html` aplicando os fragmentos de nuvem (`_nuvem.js`, `_fotos.js`, `_arranque.js`) no lugar da camada local; o processo está descrito nos próprios comentários dos fragmentos.

**Validação do `index.html` entregue:** testado com cliente Supabase simulado — login recusando senha errada, carga do estado, gravação via RPC, gravação de eventos no histórico imutável, upload de foto, e o caso de conflito de versão com recarga automática. Todos os módulos (inventário, divergências, tema) presentes e funcionais na versão de nuvem.

---

## 11. Contexto de negócio útil

- Operação em cidade de litoral. Pico em fins de semana e temporada.
- 200 patinetes e 10 motos. Motos valem ~R$ 11.000 cada; bateria de moto ~R$ 4.600.
- Sem caução e sem retenção de documento — decisão do dono.
- Todo pacote é pago antecipadamente.
- A tabela de peças tem ~25 valores levantados de fornecedores reais em julho/2026 e o restante é estimativa de mercado. **Precisa ser confirmada com o fornecedor dele antes de servir de base para cobrança.**
- Dois riscos declarados pelo dono, em ordem de preocupação: **desvio interno** (funcionário alugar sem registrar e ficar com o dinheiro) e não devolução por cliente. Os módulos de inventário e divergências existem por causa do primeiro — não são requisito genérico de controle de estoque, são antifraude interna. Considere isso antes de simplificá-los. O controle de lacres, que existia pelo mesmo motivo, **foi removido**: hoje o antifraude é o QR da etiqueta em saída e chegada (seção 4.9) mais a conferência física da frota (seção 4.10).
- O sistema será operado por atendentes com pouca familiaridade com software. Cada passo adicionado ao balcão custa tempo real de atendimento — a vistoria fotográfica já adiciona cerca de 20 segundos por locação, e existe a opção de desligá-la em Configurações justamente por isso.
