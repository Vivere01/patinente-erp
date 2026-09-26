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
   │
   └── sincronização: a cada 5 s o cliente pergunta só a versão; muda, recarrega
```

- **`index.html`** — aplicação de produção (acesso da loja + PIN de atendente).
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

Ou cole o conteúdo de `schema.sql` no SQL Editor do Neon e clique em **Run**.

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

1. Abra o site → **Acesso da loja** (email + senha).
2. Criar o usuário **gerente** com PIN de 4 dígitos.
3. Criar a frota (wizard de boas-vindas) e preencher os dados da empresa em **Configurações**.
4. `urlBase` de assinatura fica em branco = usa o próprio domínio (`https://SEU-DOMINIO/assinar`).
5. Cadastrar atendentes (PIN) e registrar o lote de lacres aplicando-os na frota.

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
npm test
```

- **A. Regras de dinheiro** — lê as funções do próprio `index.html` e confere os cenários
  da seção 9 da especificação (excedente por fração, tolerância, contrato multi-veículo).
- **B. Sessão e links** — token adulterado/vencido é recusado, link de foto fora do
  escopo é recusado.
- **C. Banco** — lock otimista, imutabilidade de `eventos`, fotos e assinaturas. Roda
  dentro de uma transação **descartada ao final**: nada do que o teste escreve sobrevive.

---

## Rotas da API

| Rota | Método | Sessão | Função |
|---|---|---|---|
| `/api/status` | GET | — | Situação do banco e das credenciais. |
| `/api/login` | POST | — | Abre a sessão da loja (email + senha). |
| `/api/sessao` | GET | ✓ | Confirma se o token do aparelho ainda vale. |
| `/api/estado` | GET/POST | ✓ | Carrega / grava o documento com controle de versão. |
| `/api/eventos` | POST | ✓ | Histórico imutável (a tabela recusa UPDATE/DELETE). |
| `/api/fotos` | GET/POST | ✓ | Grava vistoria e emite link temporário assinado (6 h). |
| `/api/assinaturas` | POST | ✓ | Publica o contrato congelado para o celular do cliente. |
| `/api/assinaturas/{token}` | GET/POST | token | Contrato para leitura e gravação da assinatura. |

---

## Limitações conhecidas (detalhadas na especificação, seção 8)

- **8.1 — estado monolítico.** O documento inteiro é reescrito a cada alteração. Cerca de
  15 MB de `locacoes` ao fim do primeiro ano; requisições passam pelo limite de 4,5 MB de
  corpo da função antes disso. **Normalizar em tabelas antes de operar em escala.**
- **8.2 — PIN de operador simplificado.** A identidade do atendente vive na aplicação;
  para controle antifraude forte, migrar para usuário Auth por operador.
- **8.3 — retenção de fotos.** A tabela `fotos` cresce; executar
  `select limpar_fotos(180)` por rotina (a promessa de eliminação está no contrato).
- **Fotos em escala.** Acima de alguns milhares de imagens, mover para Vercel Blob —
  `api/fotos.js` é o único ponto de troca.
- **Vercel Hobby** não permite uso comercial. Em produção paga, usar plano Pro.
- Contrato jurídico redigido com base na legislação brasileira, **sem revisão de advogado**.
