# patinente-erp

Sistema de balcão para locação por tempo de patinetes e motos elétricas. Cobre o ciclo
completo: saída do veículo, contrato com assinatura eletrônica, vistoria fotográfica,
controle de lacre, devolução com excedente e avaria, caixa diário, inventário de frota e
demonstrativo financeiro.

A especificação completa (regras de negócio, telas, dívida técnica e cenários de teste)
está em [`ESPECIFICACAO-TECNICA.md`](./ESPECIFICACAO-TECNICA.md). **Não altere regra de
negócio sem confirmar com o dono da operação.**

---

## Arquitetura

```
Navegador (index.html — sem build, sem framework)
   │
   ├── estado da aplicação: objeto JS `DB` em memória
   │
   ├── /api/*  …… Vercel Functions (Node) — autenticação, gravação e leitura
   │       │
   │       └── Postgres hospedado na Vercel (Marketplace → Neon)
   │              estado (1 linha versionada) · eventos (append-only)
   │              snapshots · fotos · assinaturas
   │
   ├── lock otimista: POST /api/estado recusa versão defasada e devolve o estado novo
   │       → o aparelho recarrega a versão da nuvem em vez de sobrescrever
   │
   └── sincronização: a cada 5 s o cliente pergunta só a versão; muda, recarrega
           → voltar para a aba confere na hora e repinta a aba aberta
```

- **`index.html`** — aplicação de produção (acesso por e-mail + senha, com os níveis
  Administrador e Atendente).
- **`app.html`** — mesma aplicação em `localStorage`, para rodar offline/demonstração sem
  tocar nos dados reais.
- **`assinar.html`** — tela que o cliente abre em `/assinar/{token}` para assinar no celular.
- **`api/`** — funções da Vercel. Nenhuma chave fica no navegador; a sessão é um token HMAC.
- **`lib/`** — módulos compartilhados (banco, sessão, HTTP).
- **`schema.sql`** — estrutura do banco, idempotente.
- **`scripts/`** — aplicar schema e testes.

---

## 1. Criar o banco (só você faz — leva 2 minutos)

O provisionamento passa pelo Marketplace da Vercel e exige sua conta.

1. Painel da Vercel → projeto **patinente-erp** → aba **Storage** → **Browse Marketplace**.
2. Busque **Postgres** (Neon) → **Create Database** → plano gratuito.
3. Na hora de conectar, marque o projeto **patinente-erp**. A Vercel cria sozinha a
   variável `POSTGRES_URL` em *Environment Variables* e dá um novo deploy.

> Alternativa: `vercel integration add neon` no terminal com um token que tenha escopo de
> usuário/marketplace.

## 2. Aplicar o schema

```bash
npm install
npx vercel env pull .env.local   # baixa POSTGRES_URL, AUTH_SECRET, LOJA_*
npm run schema                   # idempotente — pode rodar de novo
npm test                         # regras de dinheiro, sessão e banco
```

Ou, sem puxar as variáveis para a máquina, aplique pelo próprio site publicado
(a rota usa a sessão da loja, a mesma de `LOJA_EMAIL`/`LOJA_SENHA`):

```bash
# 1) abre a sessão (mesmas credenciais do login da loja)
TOKEN=$(curl -s -X POST https://SEU-DOMINIO/api/login -H 'content-type: application/json' \
  -d '{"email":"SEU-EMAIL","senha":"SUA-SENHA"}' | node -e "process.stdin.on('data',d=>process.stdout.write(JSON.parse(d).token))")

# 2) aplica o schema (idempotente) e confere as regras do banco
curl -X POST https://SEU-DOMINIO/api/admin/banco -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"acao":"aplicar"}'
curl -X POST https://SEU-DOMINIO/api/admin/banco -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"acao":"conferir"}'
```

`conferir` roda lock otimista, imutabilidade do histórico, fotos e assinaturas
dentro de uma transação **descartada**: não deixa dado para trás.

## 3. Credenciais da loja

Já existem no projeto (Settings → Environment Variables):

| Variável | O que é |
|---|---|
| `POSTGRES_URL` | Conexão com o Postgres (criada pelo Marketplace). |
| `AUTH_SECRET` | Segredo que assina a sessão e os links temporários das fotos. |
| `LOJA_EMAIL` / `LOJA_SENHA` | Acesso da loja que libera o aparelho. **Troque por credenciais do cliente.** |

Troque `LOJA_SENHA` antes de liberar em produção: `vercel env rm LOJA_SENHA production`
e `vercel env add LOJA_SENHA production`.

## 4. Primeiro acesso

1. Abra o site → entre com **e-mail e senha** (as `LOJA_EMAIL` / `LOJA_SENHA`).
2. Criar a frota (wizard de boas-vindas) e preencher os dados da empresa em **Configurações**.
3. `urlBase` de assinatura fica em branco = usa o próprio domínio (`https://SEU-DOMINIO/assinar`).
4. Na aba **Usuários**, cadastrar as pessoas da loja com **e-mail, senha e nível**
   (Administrador ou Atendente), registrar o lote de lacres e aplicá-los na frota.

### Papéis

| Papel | O que faz |
|---|---|
| **Atendente** | Opera o balcão: locação, devolução, vistoria, clientes, histórico e caixa do dia. **Não enxerga o financeiro, os relatórios nem os usuários** — a aba *Financeiro*, a aba *Relatórios* e o faturamento do dia ficam escondidos. |
| **Administrador** | Tudo do atendente, mais o financeiro do mês, a aba **Relatórios** e a aba **Usuários**: estorna locações e lançamentos, altera preços e tabela de peças, cadastra usuários, registra lote de lacres, trata divergências e zera o sistema. |

Sempre deve existir pelo menos um administrador ativo.

As abas **Financeiro**, **Relatórios** e **Usuários** são exclusivas do administrador.
Quem não é administrador não vê nenhuma das três — se chegar por atalho, volta para
o painel. É na aba **Usuários** que se cria cada conta com **e-mail, senha e nível**;
a senha nunca fica em texto claro: o navegador deriva PBKDF2-SHA256 com salt próprio
(120 mil iterações) e o servidor guarda só o hash.

Depois de entrar, a sessão fica no aparelho (token de 12 h): só pede a senha de novo
ao abrir o sistema, ao expirar ou ao sair.

### Relatórios (só administrador)

A aba **Relatórios** fecha o mês numa tela só — o seletor de calendário escolhe o mês
e a página responde: viagens, faturamento, ticket médio, dias com movimento, os
clientes que mais viajaram (com faturamento), o melhor dia, as horas de pico com
barra de movimento e um resumo em uma coluna. Sem viagens no mês, tudo aparece em zero.

### Foto do documento do cliente (CNH/RG)

Em **Configurações** há o interruptor *“Exigir foto do documento (CNH/RG) do cliente
na saída”* — ele vira o padrão de toda locação. No passo 2 da locação, o quadro
**Foto do documento apresentado** oferece **Tirar foto** (câmera do aparelho) e
**Escolher arquivo** (upload de imagem, scan ou arquivo já existente), mais um
checkbox **“exigir nesta locação”** que sobe ou derruba a exigência daquela
locação só — para a atendente exigir na alta temporada ou diante de um cliente
suspeito. A foto fica na ficha do cliente e volta sozinha na locação seguinte.

---

## Identidade visual

**VeeLo Way · Mobilidade Urbana — amarelo e preto.**

- **Logo:** `assets/logo-veeloway.jpeg` (arquivo original da marca, versionado). Aparece
  como favicon, na barra do topo do sistema, na tela de acesso (e-mail + senha), na
  tela de assinatura do cliente (`assinar.html`) e no `<title>` da aba.
- **Cores:** `--brand` = amarelo (`#ffe500` no escuro, `#f2e200` no claro) e `--ink` =
  preto. Todo texto por cima do amarelo usa `--ink` — botão principal, aba ativa e
  cabeçalho de total. `--brand-fg` resolve o texto da marca quando o
  fundo é claro (amarelo sobre branco não se lê).
- **Para trocar a marca:** substitua o arquivo em `assets/` mantendo o nome (ou altere
  os quatro `src="assets/logo-veeloway.jpeg"` no `index.html` e no `assinar.html`) e
  ajuste `--brand` nos dois temas do `<style>`.
- **Nome da empresa:** o padrão (e o que uma loja já cadastrada com o nome de fábrica
  passa a mostrar) é **VeeLo Way**; em `Configurações → Empresa` dá para mudar para o
  nome jurídico, CNPJ e endereço da loja.

---

## Deploy

O repositório está vinculado ao projeto da Vercel: **qualquer push em `main` gera um
deploy de produção**. Não há build — a pasta `api/` vira função e o resto é estático.

Deploy manual (opcional):

```bash
npx vercel --prod --yes
```

Variáveis novas: `Settings → Environment Variables` no painel, ou
`vercel env add NOME production` (diga a variável no stdin).

### O que não vai para o deploy

`.vercelignore` mantém fora do site `ESPECIFICACAO-TECNICA.md`, `docs/` e `*.sql`.
O código continua público no repositório.

---

## Testes

```bash
npm test        # verificações locais (partes A a J)
npm run verificar   # 30 verificações contra o site publicado
```

- **A. Regras de dinheiro** — lê as funções do próprio `index.html` e confere os cenários
  da seção 9 da especificação (excedente por fração, tolerância, contrato multi-veículo).
- **B. Sessão, links e senha** — token adulterado/vencido é recusado, link de foto fora do
  escopo é recusado, e o hash de senha (PBKDF2 + salt) confere só com a senha certa —
  inclusive para conta bloqueada e e-mail em caixa alta.
- **C. Banco** — lock otimista, imutabilidade de `eventos`, fotos e assinaturas. Roda
  dentro de uma transação **descartada ao final**: nada do que o teste escreve sobrevive.
- **D. SQL embutido** — `lib/schema-sql.js` em sincronia com `schema.sql`
  (`npm run schema:sync` regenera).
- **E. Módulos de api/** — todos carregam. Um `require` com caminho errado só estoura
  no ar como `FUNCTION_INVOCATION_FAILED`; aqui ele reprova antes do deploy.
- **F. Níveis de acesso e foto do documento** — uma tela única de e-mail + senha (sem PIN),
  os dois níveis (Administrador/Atendente) com a migração dos papéis antigos, as três
  abas do administrador bloqueadas e escondidas para o atendente, a validação do
  formulário de usuário (e-mail único, senha mínima) e o quadro do documento com
  câmera + upload.
- **G. Fechamento e sincronização** — o fechamento lista e soma as entradas por forma
  de pagamento (soma calculada num dia de exemplo), o impresso traz o mesmo detalhe, e a
  nuvem: carga no acesso, sondagem de 5 s, confirmação ao voltar para a aba, conflito de
  versão recarregando o estado do servidor e repintura da aba aberta.
- **H. Identidade visual** — o logo está no repositório e é um JPEG válido; aparece no
  favicon, no topo, na tela de acesso e na assinatura; amarelo e preto nos dois
  temas, sem texto branco por cima do amarelo e sem resquício do azul antigo; e o nome
  padrão da empresa é a marca, não "Minha Locadora".
- **I. Relatórios** — a aba existe e é redesenhada ao entrar; e o fechamento do mês é
  calculado num mês de exemplo (viagens fora estorno, faturamento, ticket, cliente
  destaque, melhor dia, hora de pico) e devolve zero em tudo num mês vazio.
- **J. Paridade da senha** — o navegador (WebCrypto) e o servidor (crypto do Node)
  derivam exatamente a mesma chave a partir do mesmo salt: se divergirem, ninguém entra
  pelo usuário cadastrado.
- **`verificar-ar`** — roda a operação inteira no site publicado: login, estado com
  lock, histórico, foto com link assinado, contrato assinado no celular, limpeza, a
  identidade no ar (página, login por e-mail, aba Relatórios e o logo servido como
  imagem) e o usuário do sistema (criar conta, entrar pelo e-mail, recusar senha
  errada e conta bloqueada, e devolver o documento intacto).
  Usa `LOJA_EMAIL`/`LOJA_SENHA` do `.env.local` (ou `node scripts/verificar-ar.js URL EMAIL SENHA`)
  e apaga os artefatos de teste ao final.

---

## Rotas da API

| Rota | Método | Sessão | Função |
|---|---|---|---|
| `/api/status` | GET | — | Situação do banco e das credenciais. |
| `/api/login` | POST | — | Abre a sessão (e-mail + senha): conta da loja ou usuário cadastrado. |
| `/api/sessao` | GET | ✓ | Confirma se o token do aparelho ainda vale. |
| `/api/estado` | GET/POST | ✓ | Carrega / grava o documento com controle de versão. |
| `/api/eventos` | POST | ✓ | Histórico imutável (a tabela recusa UPDATE/DELETE). |
| `/api/fotos` | GET/POST | ✓ | Grava vistoria e emite link temporário assinado (6 h). |
| `/api/assinaturas` | POST | ✓ | Publica o contrato congelado para o celular do cliente. |
| `/api/assinaturas/{token}` | GET/POST | token | Contrato para leitura e gravação da assinatura. |
| `/api/admin/banco` | POST | ✓ | Manutenção: `aplicar` (schema), `conferir` (regras, transação descartada), `limpar` (só artefatos de teste). |

---

## Limitações conhecidas (detalhadas na especificação, seção 8)

- **8.1 — estado monolítico.** O documento inteiro é reescrito a cada alteração. Cerca de
  15 MB de `locacoes` ao fim do primeiro ano; requisições passam pelo limite de 4,5 MB de
  corpo da função antes disso. **Normalizar em tabelas antes de operar em escala.**
- **8.2 — identidade no documento.** E-mail, nível e hash da senha dos usuários vivem
  no `doc` versionado: não há segundo fator nem sessão por dispositivo gerenciada.
  Para controle antifraude forte, migrar para um provedor de identidade por pessoa,
  com RLS por usuário.
- **8.3 — retenção de fotos.** A tabela `fotos` cresce; executar
  `select limpar_fotos(180)` por rotina (a promessa de eliminação está no contrato).
- **Fotos em escala.** Acima de alguns milhares de imagens, mover para Vercel Blob —
  `api/fotos.js` é o único ponto de troca.
- **Vercel Hobby** não permite uso comercial. Em produção paga, usar plano Pro.
- Contrato jurídico redigido com base na legislação brasileira, **sem revisão de advogado**.
