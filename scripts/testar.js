/* Testes do sistema.

   A. Regras de dinheiro (seção 9 da especificação) — lidas do próprio
      index.html, então o teste valida o código que vai para produção.
   B. Sessão e links assinados (lib/auth).
   C. Banco de dados — lock otimista, imutabilidade do histórico, fotos e
      assinaturas. Roda dentro de uma transação que é DESCARTADA ao final:
      nada do que os testes escrevem sobrevive.
   D. schema.sql e lib/schema-sql.js em sincronia (fonte única).
   E. Todos os módulos de api/ carregam (require com caminho errado só
      aparece no ar, como FUNCTION_INVOCATION_FAILED).
   F. Níveis de acesso (administrador e atendente), login único com
      e-mail + senha e a foto do documento com câmera + upload.
   G. Fechamento do caixa (entradas somadas por forma de pagamento) e a
      sincronização entre aparelhos (carga no acesso, sondagem, conflito).
   H. Identidade visual VeeLo Way — logo no repositório, no topo, no
      login, no favicon e na assinatura; amarelo e preto nos dois temas.
   I. Relatórios — a aba e o fechamento do mês (viagens, faturamento,
      cliente destaque, melhor dia e horários de pico).
   J. Senha — o navegador e o servidor derivam exatamente a mesma chave.
   K. Vistoria — o balcão cobra e assina, o celular (link público) fotografa,
      libera o veículo e marca a chegada; a cobrança fecha no balcão.
   L. QR Codes — a etiqueta de cada patinete e a folha de etiquetas.
   M. Forma de pagamento — uma para a locação toda ou uma por veículo,
      somando cada forma separadamente no fechamento do caixa.
   N. Tipos de veículo — a loja cadastra marca/modelo novo a partir de um
       existente, troca o preço por modelo e só apaga tipo sem uso.
   O. Clientes — o operador edita e também exclui o cadastro, sem tocar nas
       locações do histórico e sem excluir com devolução em aberto.
   P. Operação enxuta — a aba Vistoria guarda só o link, a fila pode ser
       limpa pelo operador, o celular virou um quadro de três colunas e a
       manutenção tem aba, registro de peças e foto (no sistema e no app).

   Uso:  npm test
*/
require('./env')();

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let aprovados = 0, reprovados = 0;
function ok(condicao, nome, detalhe){
  if(condicao){ aprovados++; console.log('  ✓ ' + nome); }
  else { reprovados++; console.log('  ✗ ' + nome + (detalhe ? '  → ' + detalhe : '')); }
}
function igual(a, b, nome){ ok(Math.abs(Number(a) - Number(b)) < 0.005, nome, 'esperado ' + b + ', veio ' + a); }

/* ------------------------------------------------------------------ A */
function extrair(html, padrao){
  const m = padrao.exec(html);
  if(!m) throw new Error('não encontrei: ' + padrao);
  return m;
}
function extrairFuncao(html, nome){
  const i = html.indexOf('function ' + nome + '(');
  if(i < 0) throw new Error('função ausente: ' + nome);
  let profundidade = 0;
  for(let k = html.indexOf('{', i); k < html.length; k++){
    if(html[k] === '{') profundidade++;
    else if(html[k] === '}'){
      profundidade--;
      if(profundidade === 0) return html.slice(i, k + 1);
    }
  }
  throw new Error('chaves desbalanceadas em ' + nome);
}
function extrairVetor(html, nome){
  const i = html.indexOf('const ' + nome + ' =');
  if(i < 0) throw new Error('constante ausente: ' + nome);
  const ini = html.indexOf('[', i);
  let profundidade = 0;
  for(let k = ini; k < html.length; k++){
    if(html[k] === '[') profundidade++;
    else if(html[k] === ']'){
      profundidade--;
      if(profundidade === 0) return html.slice(i, k + 1) + ';';
    }
  }
  throw new Error('vetor desbalanceado: ' + nome);
}
function extrairLinha(html, nome){
  const m = new RegExp('const ' + nome + ' = .*;').exec(html);
  if(!m) throw new Error('constante ausente: ' + nome);
  return m[0];
}
/* extrairFuncao começa no "function", então o "async" à esquerda se perde. */
function extrairAssincrona(html, nome){
  const corpo = extrairFuncao(html, nome);
  const ini = html.indexOf(corpo);
  return (html.slice(ini - 6, ini) === 'async ' ? 'async ' : '') + corpo;
}

function testarRegrasDeDinheiro(){
  console.log('\nA. Regras de preço e excedente (extraídas do index.html)');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

  const ctx = vm.createContext({ console });
  vm.runInContext([
    extrairVetor(html, 'TIPOS_PADRAO'),
    extrairFuncao(html, 'getTipo'),
    extrairFuncao(html, 'getTarifa'),
    extrairFuncao(html, 'calcExcedente'),
    extrairLinha(html, 'brl'),
    'var DB = { config:{ toleranciaMin:5 }, tipos: JSON.parse(JSON.stringify(TIPOS_PADRAO)) };',
    'globalThis.T = { calcExcedente, getTipo, getTarifa, brl, TIPOS_PADRAO, DB };'
  ].join('\n'), ctx);

  const T = ctx.T;
  const agora = Date.now();

  /* 1. patinete 30 min devolvido em 47 min */
  T.DB.config.toleranciaMin = 5;
  let r = T.calcExcedente({ tipoId:'patinete', fimPrevisto: agora - 17*60000 }, agora);
  igual(r.minutos, 17, '1. patinete atrasado 17 min → 17 min cobrados');
  igual(r.valor, 17, '1. 17 × R$ 1,00 = R$ 17,00');

  /* 2. moto 15 min devolvida com 20 min de atraso */
  r = T.calcExcedente({ tipoId:'moto', fimPrevisto: agora - 20*60000 }, agora);
  igual(r.minutos, 20, '2. moto com 20 min de atraso → 20 min');
  igual(r.valor, 50, '2. 20 × R$ 2,50 = R$ 50,00');

  /* 3. moto 60 min com 3 min de atraso e tolerância 5 */
  r = T.calcExcedente({ tipoId:'moto', fimPrevisto: agora - 3*60000 }, agora);
  igual(r.minutos, 0, '3. atraso dentro da tolerância → 0 min');
  igual(r.valor, 0, '3. sem excedente');

  /* 4. contrato com vários veículos soma pelo tipo de cada um */
  const patinete = T.getTipo('patinete'), moto = T.getTipo('moto');
  const tarifa = (tipo, min) => tipo.tarifas.find(t => t.min === min).valor;
  igual(3*tarifa(patinete,60) + 2*tarifa(moto,60), 480, '4. 3 patinetes + 2 motos por 1 h = R$ 480,00');
  igual(3*tarifa(patinete,30) + 2*tarifa(moto,30), 240, '4. idem por 30 min = R$ 240,00');
  igual(3*tarifa(patinete,15) + 2*tarifa(moto,15), 160, '4. idem por 15 min = R$ 160,00');

  /* tolerância é cortesia: cobram-se todos os minutos desde o fim do período */
  T.DB.config.toleranciaMin = 0;
  r = T.calcExcedente({ tipoId:'patinete', fimPrevisto: agora - 17*60000 }, agora);
  igual(r.valor, 17, '5. tolerância 0 mantém a cobrança integral');
  T.DB.config.toleranciaMin = 5;
}

/* ------------------------------------------------------------------ B */
function testarSessao(){
  console.log('\nB. Sessão da loja e links assinados');
  process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'segredo-de-teste_local_1234567890';
  const auth = require('../lib/auth');

  ok(auth.criarToken('loja@x.com', 1) !== undefined, 'token gerado');
  const t = auth.criarToken('loja@x.com', 1);
  ok(auth.lerToken(t) && auth.lerToken(t).e === 'loja@x.com', 'token validado');
  ok(auth.lerToken(t.slice(0, -1) + (t.slice(-1) === 'a' ? 'b' : 'a')) === null, 'token adulterado é recusado');
  ok(auth.lerToken(auth.criarToken('loja@x.com', -1)) === null, 'token vencido é recusado');

  const { exp, sig } = auth.assinarUrl('2026-09-26/teste.jpg');
  ok(auth.conferirUrl('2026-09-26/teste.jpg', exp, sig), 'link de foto aceito');
  ok(!auth.conferirUrl('2026-09-26/outro.jpg', exp, sig), 'link de foto com outro caminho é recusado');
  ok(!auth.conferirUrl('2026-09-26/teste.jpg', Date.now() - 1000, sig), 'link de foto vencido é recusado');

  ok(auth.conferirCredenciais('a@b.c', 'x').codigo === 'credenciais_invalidas' ||
     auth.conferirCredenciais('a@b.c', 'x').codigo === 'loja_nao_configurada',
     'senha errada não abre sessão');

  /* --- senha dos usuários cadastrados no sistema --- */
  const salt = auth.novoSalt();
  const senha = 'senhaForte123';
  const hash = auth.hashSenha(senha, salt);
  ok(/^[0-9a-f]{64}$/.test(hash), 'hash sai em hex de 32 bytes');
  ok(hash === auth.hashSenha(senha, salt) && hash !== auth.hashSenha(senha, auth.novoSalt()),
     'mesma senha e mesmo salt dão o mesmo hash; salt novo muda tudo');
  ok(auth.conferirHash(senha, salt, hash), 'senha certa confere');
  ok(!auth.conferirHash('senhaErrada', salt, hash), 'senha errada não confere');
  ok(!auth.conferirHash(senha, '', hash) && !auth.conferirHash(senha, salt, ''),
     'sem salt ou sem hash não se confere nada');

  const doc = { usuarios: [
    { id:1, nome:'Ana', email:'ana@loja.com', papel:'administrador', ativo:true, salt, hash },
    { id:2, nome:'Beto', email:'beto@loja.com', papel:'atendente', ativo:false, salt, hash }
  ]};
  const ana = auth.conferirUsuario(doc, 'ANA@Loja.com', senha);
  ok(ana.ok === true && ana.papel === 'administrador',
     'usuário do sistema entra pelo e-mail (sem diferenciar maiúsculas)', JSON.stringify(ana));
  ok(auth.conferirUsuario(doc, 'ana@loja.com', 'outraSenha').ok === false,
     'senha errada recusa o usuário do sistema');
  ok(auth.conferirUsuario(doc, 'ninguem@loja.com', senha).ok === false,
     'e-mail sem cadastro não entra');
  ok(auth.conferirUsuario(doc, 'beto@loja.com', senha).ok === false,
     'conta bloqueada não entra, mesmo com a senha certa');
  ok(auth.usuarioNoDoc(doc, 'beto@loja.com').ativo === false,
     'a conta bloqueada é achada pelo e-mail (o login avisa em vez de deixar passar)');
  ok(auth.papelSeguro('gerente') === 'administrador' && auth.papelSeguro('operador') === 'atendente',
     'o servidor também converte os papéis antigos');
}

/* ------------------------------------------------------------------ D */
function testarSchemaEmbutido(){
  console.log('\nD. SQL embutido em lib/schema-sql.js (fonte única)');
  const origem = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  const embutido = require('../lib/schema-sql');
  ok(embutido === origem, 'lib/schema-sql.js está em dia com schema.sql',
     'rode `npm run schema:sync`');
  ok(embutido.indexOf('create or replace function public.salvar_estado(') >= 0,
     'função salvar_estado presente no SQL embutido');
}

/* ------------------------------------------------------------------ E */
/* Um require com caminho errado derruba a função só no ar (FUNCTION_INVOCATION_FAILED).
   Carregar todo módulo de api/ aqui pega o erro antes do deploy. */
function testarModulosApi(){
  console.log('\nE. Módulos de api/');
  const dir = path.join(__dirname, '..', 'api');
  const arquivos = [];
  (function varrer(d){
    for(const nome of fs.readdirSync(d)){
      const cheio = path.join(d, nome);
      if(fs.statSync(cheio).isDirectory()) varrer(cheio);
      else if(nome.endsWith('.js')) arquivos.push(cheio);
    }
  })(dir);

  ok(arquivos.length >= 9, 'api/ tem as rotas esperadas', 'achei só ' + arquivos.length);
  for(const f of arquivos){
    const nome = 'carrega api/' + path.relative(dir, f).split(path.sep).join('/');
    try{
      const m = require(f);
      ok(typeof m === 'function', nome, 'não exporta função');
    }catch(e){
      ok(false, nome, e.message);
    }
  }
}

/* ------------------------------------------------------------------ F */
/* Os dois níveis de acesso (administrador e atendente), a tela única de
   e-mail + senha e a foto do documento — lidos do próprio index.html. */
function testarPapelEDocumento(){
  console.log('\nF. Níveis de acesso, login e foto do documento');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const corpo = f => extrairFuncao(html, f);

  /* --- uma tela de login só: e-mail + senha --- */
  ok((html.match(/class="loginmarca"/g) || []).length === 1,
     'existe uma única tela de acesso (não mais loja + PIN)');
  ok(/id="loEmail"/.test(html) && /id="loSenha"/.test(html), 'o login pede e-mail e senha');
  ok(!/pinpad|pindots|lgPin|usPin|puPin|telaPrimeiroUsuario|telaLoja/.test(html),
     'o PIN de 4 dígitos e a tela de escolher usuário saíram do sistema');
  ok(corpo('telaLogin').indexOf('Nuvem.entrar(') >= 0,
     'quem entra abre sessão pela API com e-mail e senha');
  ok(html.indexOf('function resolverSessao(') >= 0 &&
     corpo('arrancar').indexOf('resolverSessao()') >= 0,
     'com sessão válida o aparelho entra direto, sem pedir senha de novo');
  ok(/ITERACOES_PBKDF2 = 120000/.test(html) && /iterations: ITERACOES_PBKDF2/.test(html),
     'a senha é derivada com PBKDF2-SHA256, 120 mil iterações');

  /* --- papéis: só administrador e atendente --- */
  ok(!/value="operador"/.test(html) && !/value="gerente"/.test(html),
     'o cadastro não oferece mais operador nem gerente');
  ok(/value="administrador"/.test(html) && /value="atendente"/.test(html),
     'o cadastro oferece os dois níveis: Administrador e Atendente');
  const ctx = vm.createContext({ console });
  vm.runInContext([
    'var SESSAO = null;',
    extrairLinha(html, 'PAPEIS'),
    corpo('papelDe'),
    corpo('rotuloPapel'),
    corpo('ehAdministrador')
  ].join('\n'), ctx);

  ok(ctx.rotuloPapel('administrador') === 'Administrador', 'rotuloPapel devolve "Administrador"',
     ctx.rotuloPapel('administrador'));
  ok(ctx.rotuloPapel('atendente') === 'Atendente', 'rotuloPapel devolve "Atendente"',
     ctx.rotuloPapel('atendente'));
  ok(ctx.papelDe('gerente') === 'administrador' && ctx.papelDe('operador') === 'atendente',
     'os papéis antigos migram sozinhos para os dois níveis');
  ctx.SESSAO = { papel:'administrador' };
  ok(ctx.ehAdministrador() === true, 'ehAdministrador reconhece o administrador');
  ctx.SESSAO = { papel:'atendente' };
  ok(ctx.ehAdministrador() === false, 'atendente não é administrador');
  ctx.SESSAO = null;
  ok(!ctx.ehAdministrador(), 'sem sessão não há administrador');

  ok(corpo('aplicarMigracoes').indexOf('u.papel = papelDe(u.papel)') >= 0 &&
     corpo('aplicarMigracoes').indexOf('delete u.pin') >= 0 &&
     corpo('aplicarMigracoes').indexOf("u.email = String(") >= 0,
     'a migração converte o papel antigo, apaga o PIN e completa o e-mail');

  /* --- o atendente só enxerga as quatro abas dele --- */
  const irPara = corpo('irPara');
  ok(irPara.indexOf('ABAS_SOMENTE_ADMIN.indexOf(tab) >= 0') >= 0,
     'irPara bloqueia as abas do administrador para quem não é administrador');
  const perm = corpo('aplicarPermissoes');
  ok(perm.indexOf('ABAS_SOMENTE_ADMIN.forEach(soAdmin)') >= 0 &&
     html.indexOf("const ABAS_SOMENTE_ADMIN = ['manutencao','historico','config','financeiro','usuarios']") >= 0,
     'o atendente não vê Manutenção, Histórico, Configurações, Financeiro nem Usuários');
  ok(['painel','frota','vistoria','clientes'].every(t=>
        new RegExp('data-tab="'+t+'"').test(html)),
     'o atendente continua com Painel, Frota, Vistoria e Clientes');
  ok(perm.indexOf("soAdmin('relatorios')") < 0 && html.indexOf('data-tab="relatorios"') < 0,
     'sem aba de relatórios: ela é seção do painel');
  ok(perm.indexOf("irPara('painel')") >= 0,
     'quem está numa aba proibida volta para o painel');
  ok(/<button data-tab="usuarios">/.test(html) && /id="page-usuarios"/.test(html),
     'a aba Usuários existe com a página própria');
  ok(!/data-tab="caixa"/.test(html) && !/id="page-caixa"/.test(html),
     'a aba Caixa do dia saiu da navegação');
  ok(/id="secCaixa"/.test(html) && /id="kpisCaixa"/.test(html) && /id="tbCaixaEnt"/.test(html) &&
     /id="tbCaixaSai"/.test(html),
     'o caixa do dia é uma seção do painel, com abertura, entradas e saídas');
  ok(!/data-tab="relatorios"/.test(html) && !/id="page-relatorios"/.test(html),
     'a aba Relatórios saiu da navegação');
  ok(/id="secRel"/.test(html) && /id="kpisRel"/.test(html) && /id="tbRelResumo"/.test(html),
     'os relatórios do mês são uma seção do painel');
  ok(/id="secRel" style="display:none"/.test(html),
     'a seção de relatórios nasce escondida e só o administrador a revela');

  ok((html.match(/id="cardUsuarios"/g) || []).length === 1 &&
     /<section class="page" id="page-usuarios"[\s\S]{0,1200}id="cardUsuarios"/.test(html),
     'o card de usuários mora na aba dele');
  ok(/<section class="page" id="page-usuarios"[\s\S]{0,1600}id="btnNovoUsuario"/.test(html),
     'a aba de usuários tem o botão de cadastrar');
  ok(irPara.indexOf("if(tab==='usuarios') renderUsuarios()") >= 0 &&
     corpo('renderPainel').indexOf('renderCaixa()') >= 0 &&
     corpo('renderPainel').indexOf('renderRelatorios()') >= 0,
     'entrar numa área redesenha a página dela');
  ok(corpo('renderFinanceiro').indexOf('if(!ehAdministrador()) return;') >= 0,
     'renderFinanceiro tem trava própria para o atendente');
  ok(corpo('renderRelatorios').indexOf('if(!ehAdministrador()) return;') >= 0,
     'renderRelatorios tem trava própria para o atendente');
  ok(corpo('renderHistorico').indexOf('if(!ehAdministrador()) return;') >= 0 &&
     corpo('renderConfig').indexOf('if(!ehAdministrador()) return;') >= 0,
     'Histórico e Configurações também têm trava própria para o atendente');
  ok(corpo('renderPainel').indexOf('!ehAdministrador()) kpis.splice') >= 0,
     'KPI de faturamento fica de fora do painel do atendente');
  ok(/#btnNovoUsuario'\)\.onclick[\s\S]{0,200}exigirAdministrador\('cadastrar usuários'\)/.test(html),
     'cadastrar usuário exige administrador');
  ok(/function conferirDadosUsuario\(/.test(html) &&
     corpo('conferirDadosUsuario').indexOf('A senha precisa de pelo menos 6 caracteres') >= 0 &&
     corpo('conferirDadosUsuario').indexOf('Já existe um usuário com este e-mail') >= 0,
     'o formulário valida e-mail único e senha de pelo menos 6 caracteres');
  ok(/id="usEmail"/.test(html) && /id="usSenha"/.test(html) && /id="usPin"/.test(html) === false,
     'o formulário de usuário tem e-mail e senha, sem PIN');

  /* --- foto do documento --- */
  ok(/id="cfgDocFoto"/.test(html) && html.indexOf('DB.config.exigirDocFoto') >= 0,
     'Configurações tem o interruptor global de exigir a foto do documento');
  ok(html.indexOf('W.exigirDocFoto && !W.docFoto') >= 0,
     'o avanço do passo 2 recusa locação exigindo foto sem foto');
  ok(/grupo\.exigiuDocFoto|exigiuDocFoto:/.test(html), 'a locação guarda se a foto foi exigida');

  vm.runInContext([corpo('blocoFotoDoc'), 'globalThis.B = { blocoFotoDoc };'].join('\n'), ctx);

  ctx.W = { exigirDocFoto:true, docFoto:null };
  const exigente = ctx.B.blocoFotoDoc();
  ok(/id="wDocExigir"\s+checked/.test(exigente), 'quadro começa com "exigir" marcado quando configurado');
  ctx.W = { exigirDocFoto:false, docFoto:null };
  const opcional = ctx.B.blocoFotoDoc();
  ok(!/id="wDocExigir"\s+checked/.test(opcional), 'quadro começa desmarcado quando é opcional');
  ok(/Opcional nesta locação/.test(opcional), 'avisa que é opcional');
  ok(/id="wDocTirar"/.test(opcional), 'tem botão de tirar foto (câmera)');
  ok(/id="wDocArquivo"/.test(opcional), 'tem botão de escolher arquivo (upload)');
  ok(/accept="image\/\*"/.test(opcional) && /id="wDocArq"/.test(opcional),
     'o input de arquivo aceita imagem');
  ok(!/capture=/.test(opcional), 'o upload não força a câmera (permite galeria e arquivo do PC)');
}

/* ------------------------------------------------------------------ G */
function testarFechamentoESync(){
  console.log('\nG. Fechamento do caixa e sincronização entre aparelhos');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const corpo = f => extrairFuncao(html, f);

  /* --- entradas somadas por forma de pagamento --- */
  const fechar = corpo('fecharCaixaModal');
  ok(fechar.indexOf('Entradas por forma de pagamento') >= 0,
     'a janela de fechamento mostra as entradas por forma de pagamento');
  ok(/formas\.map\(f=>'<div class="l">/.test(fechar) && fechar.indexOf('Total de entradas') >= 0,
     'a janela de fechamento lista cada forma e soma o total');
  ok(fechar.indexOf("porForma['Dinheiro']") >= 0,
     'a janela de fechamento mantém a conferência do dinheiro em gaveta');
  ok(/Object\.keys\(ent\.porForma\)\.sort\(\)\.map\(f=>'<tr>/.test(html),
     'o impresso continua listando cada forma de pagamento');
  ok(/id="tbCaixaEnt"/.test(html) && /porForma\[f\]/.test(html),
     'a tela do caixa também mostra a tabela de entradas por forma');

  /* soma de verdade, com um dia de exemplo */
  const ctx = vm.createContext({ console });
  vm.runInContext([
    extrairFuncao(html, 'diaKey'),
    extrairFuncao(html, 'estornada'),
    extrairFuncao(html, 'tsCobranca'),
    extrairFuncao(html, 'entradasDoDia'),
    'globalThis.DB = { locacoes: [] };',
    'globalThis.C = { entradasDoDia, diaKey };'
  ].join('\n'), ctx);
  const agora = Date.now(), dia = ctx.C.diaKey(agora);
  ctx.DB = { locacoes: [
    { status:'ativa', inicio:agora, valorBase:100, pagamento:'Pix', veiculoCodigo:'P1', tarifaLabel:'30 min' },
    { status:'ativa', inicio:agora, valorBase:50,  pagamento:'Dinheiro', veiculoCodigo:'P2', tarifaLabel:'1 h' },
    { status:'ativa', inicio:agora - 4*86400000, valorBase:999, pagamento:'Pix', veiculoCodigo:'P3', tarifaLabel:'1 h' },
    { status:'estornada', inicio:agora, valorBase:777, pagamento:'Pix', veiculoCodigo:'P4', tarifaLabel:'1 h' },
    { status:'ativa', inicio:agora, fimReal:agora, valorExcedente:20, pagamentoExcedente:'Cartão de crédito',
      veiculoCodigo:'P1', tarifaLabel:'30 min', minutosExcedente:12 }
  ]};
  const e = ctx.C.entradasDoDia(dia);
  igual(e.porForma['Pix'], 100, 'Pix soma só as locações daquele dia');
  igual(e.porForma['Dinheiro'], 50, 'Dinheiro soma à parte');
  igual(e.porForma['Cartão de crédito'], 20, 'o excedente entra pela forma em que foi pago');
  ok(Object.keys(e.porForma).length === 3, 'três formas de pagamento somadas separadamente');
  igual(e.total, 170, 'o total é a soma das formas (locação de outro dia e estorno ficam de fora)');

  /* --- sincronização entre aparelhos --- */
  ok(/const doc = await Nuvem\.carregar\(\)/.test(html) && /Nuvem\.escutar\(\)/.test(html),
     'no acesso o aparelho baixa o documento da nuvem e passa a observá-lo');
  ok(/e\.codigo === 409 && e\.det/.test(html),
     'o conflito de versão (409) é reconhecido como conflito, não como erro de rede');
  ok(/assumir\(r\)\{/.test(html) && /Outro aparelho salvou antes/.test(html),
     'diante de conflito a aplicação recarrega a versão da nuvem em vez de sobrescrever');
  const gravar = html.slice(html.indexOf('async gravar(){'), html.indexOf('assumir(r){'));
  const i409 = gravar.indexOf('codigo === 409'), irasc = gravar.indexOf('guardarRascunho()');
  ok(i409 >= 0 && irasc > i409 && gravar.slice(i409, irasc).indexOf('}else{') >= 0,
     'só a falha de rede guarda rascunho — o conflito não vira "sem conexão"');
  ok(/async sondar\(\)/.test(html) && /setInterval\(\(\)=> this\.sondar\(\)/.test(html),
     'a sondagem de 5 s usa a mesma rotina que confere a nuvem');
  ok(/visibilitychange/.test(html) && /document\.hidden\) this\.sondar\(\)/.test(html),
     'voltar para a aba confere a nuvem na hora, sem esperar os 5 s');
  const repintar = corpo('repintarTela');
  ['renderFrota','renderClientes','renderHistorico','renderFinanceiro','renderUsuarios','renderConfig']
    .forEach(fn=> ok(repintar.indexOf(fn) >= 0, 'repintarTela atualiza a aba de ' + fn));
  ok(repintar.indexOf('renderPainel') >= 0 &&
     corpo('renderPainel').indexOf('renderCaixa()') >= 0 &&
     corpo('renderPainel').indexOf('renderRelatorios()') >= 0,
     'repintarTela repinta o painel e com ele o caixa do dia e os relatórios');
}

/* ------------------------------------------------------------------ H */
function testarIdentidadeVisual(){
  console.log('\nH. Identidade visual — VeeLo Way (amarelo e preto)');
  const raiz = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(raiz, 'index.html'), 'utf8');
  const assinar = fs.readFileSync(path.join(raiz, 'assinar.html'), 'utf8');
  const vistoria = fs.readFileSync(path.join(raiz, 'vistoria.html'), 'utf8');
  const logo = path.join(raiz, 'assets', 'logo-veeloway.jpeg');

  /* o arquivo da marca existe mesmo e é imagem */
  const okArq = fs.existsSync(logo);
  ok(okArq, 'assets/logo-veeloway.jpeg está no repositório');
  if(okArq){
    const b = fs.readFileSync(logo);
    ok(b[0] === 0xFF && b[1] === 0xD8 && b.length > 10000, 'o logo é um JPEG válido (' + b.length + ' bytes)');
  }
  ok(!/^assets\//m.test(fs.readFileSync(path.join(raiz, '.vercelignore'), 'utf8')),
     'o .vercelignore não bloqueia a pasta assets');

  /* a marca aparece no topo, no login e no favicon */
  ok(/<link rel="icon" href="assets\/logo-veeloway\.jpeg">/.test(html),
     'index.html usa o logo como favicon');
  ok(/class="logomarca" src="assets\/logo-veeloway\.jpeg"/.test(html),
     'a barra do topo mostra o logo');
  ok((html.match(/class="loginmarca"/g) || []).length === 1,
     'a tela de acesso (e-mail + senha) mostra o logo');
  ok(/<img src="\/assets\/logo-veeloway\.jpeg"[^>]*><span id="empresa">/.test(assinar),
     'a tela de assinatura do cliente também leva o logo');
  ok(/<img src="\/assets\/logo-veeloway\.jpeg"[^>]*><span id="empresa">/.test(vistoria) &&
     /<link rel="icon" href="\/assets\/logo-veeloway\.jpeg">/.test(vistoria),
     'a página da vistoria usa a logo em caminho absoluto (ela abre em /vistoria/{token})');
  ok(assinar.indexOf('href="/assets/logo-veeloway.jpeg"') >= 0,
     'a página de assinatura também é absoluta (ela abre em /assinar/{token})');
  ok(vistoria.indexOf('src="assets/') < 0 && assinar.indexOf('src="assets/') < 0,
     'nenhuma das duas telas sob caminho relativo (daria 404)');
  ok(/<title>VeeLo Way/.test(html), 'o título da aba é a marca');

  /* amarelo e preto nos dois temas */
  ok(/--brand:#ffe500/.test(html) && /--ink:#0a0a0a/.test(html),
     'tema escuro: amarelo de marca sobre fundo preto');
  ok(/--brand:#f2e200/.test(html) && /--brand-fg:#0a0a0a/.test(html),
     'tema claro: amarelo de marca com texto preto legível');
  ok(/--brand-fg/.test(html) && !/--brand:#4d8dff|--brand:#2d6ff5/.test(html + assinar),
     'o azul antigo saiu das duas telas');

  /* preto por cima do amarelo — branco aqui não se lê */
  ok(/\.btn\{background:linear-gradient\(135deg,var\(--brand\),var\(--brand-2\)\);color:var\(--ink\)/.test(html),
     'botão principal: fundo amarelo com texto preto');
  ok(/nav\.tabs button\.active\{background:var\(--brand\);color:var\(--ink\)/.test(html),
     'aba ativa em amarelo com texto preto');
  ok(!/linear-gradient\(135deg,var\(--brand\),var\(--brand-2\)\);color:#fff/.test(html),
     'nenhum bloco amarelo ficou com texto branco');
  ok(/header\.top\{[^}]*border-bottom:2px solid var\(--brand\)/.test(html),
     'a barra do topo é marcada com o amarelo da marca');
  ok(/--brand:#f2e200; --brand-2:#dccb00/.test(assinar),
     'a tela de assinatura usa o mesmo amarelo');

  /* a empresa já cadastrada passa a se chamar pela marca */
  ok((html.match(/Minha Locadora/g) || []).length === 1,
     'o nome de fábrica só resta para ser renomeado, nunca exibido');
  ok(html.indexOf("DB.empresa.nome === 'Minha Locadora') DB.empresa.nome = 'VeeLo Way'") >= 0,
     'a loja existente é renomeada de "Minha Locadora" para a marca');
}

/* ------------------------------------------------------------------ I */
/* Os relatórios do mês são uma seção recolhível do painel: quantas
   viagens, quanto faturou, quem mais viajou, qual foi o melhor dia e
   quais horas são cheias. Só o administrador a enxerga. */
function testarRelatorios(){
  console.log('\nI. Relatórios — o mês dentro do painel');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const corpo = f => extrairFuncao(html, f);

  ok(!/data-tab="relatorios"/.test(html) && !/id="page-relatorios"/.test(html),
     'a navegação não tem mais a aba Relatórios');
  ok(/<section class="page active" id="page-painel">/.test(html) &&
     html.indexOf('id="secRel"') > html.indexOf('id="page-painel"') &&
     html.indexOf('id="secRel"') < html.indexOf('id="page-usuarios"'),
     'os relatórios moram dentro da página do painel');
  ok(/id="rMes"/.test(html) && /id="kpisRel"/.test(html) && /id="tbRelClientes"/.test(html) &&
     /id="tbRelDias"/.test(html) && /id="tbRelHoras"/.test(html) && /id="tbRelResumo"/.test(html),
     'a seção tem o seletor de mês, os KPIs e as quatro tabelas');
  ok(corpo('renderPainel').indexOf('if(ehAdministrador()) renderRelatorios()') >= 0 &&
     corpo('renderPainel').indexOf("secRel.style.display = ehAdministrador()") >= 0,
     'a seção só é pintada e revelada para o administrador');
  ok(corpo('renderRelatorios').indexOf('if(!ehAdministrador()) return;') >= 0,
     'renderRelatorios tem trava própria para o atendente');
  ok(/id="tglRel"/.test(html) && /secRel'\)\.classList\.toggle\('aberto'\)/.test(html),
     'a seção abre e fecha com um clique, sem virar aba');
  ok(/<input[^>]*id="rMes"[^>]*type="month"|type="month"[^>]*id="rMes"/.test(html),
     'o mês é escolhido num seletor de calendário');

  /* --- o fechamento do mês, com um mês de exemplo --- */
  const ctx = vm.createContext({ console });
  vm.runInContext([
    extrairFuncao(html, 'diaKey'),
    extrairFuncao(html, 'mesKey'),
    extrairFuncao(html, 'estornada'),
    extrairFuncao(html, 'tsCobranca'),
    extrairFuncao(html, 'totalLoc'),
    corpo('relatorioDoMes'),
    'globalThis.DB = { locacoes: [] };',
    'globalThis.R = { relatorioDoMes };'
  ].join('\n'), ctx);

  const t = s => Date.parse(s);
  ctx.DB = { locacoes: [
    { status:'ativa', inicio:t('2026-10-01T10:00:00'), clienteNome:'Ana',   valorBase:30 },
    { status:'ativa', inicio:t('2026-10-01T10:30:00'), clienteNome:'Ana',   valorBase:20 },
    { status:'ativa', inicio:t('2026-10-02T18:00:00'), clienteNome:'Beto',  valorBase:50 },
    { status:'ativa', inicio:t('2026-10-05T18:00:00'), clienteNome:'Cleo',  valorBase:10, valorExcedente:5 },
    { status:'ativa', inicio:t('2026-09-30T20:00:00'), clienteNome:'Zeca',  valorBase:999 },
    { status:'estornada', inicio:t('2026-10-03T12:00:00'), clienteNome:'Ana', valorBase:700 }
  ]};
  const r = ctx.R.relatorioDoMes('2026-10');
  ok(r.n === 4, 'só as viagens do mês, fora o estorno e a do mês passado', 'vieram ' + r.n);
  igual(r.fat, 115, 'faturamento do mês soma base + excedente, sem estorno');
  igual(r.ticket, 115/4, 'ticket médio é o faturamento pelas viagens');
  ok(r.clientes.length === 3 && r.clientes[0].nome === 'Ana' && r.clientes[0].n === 2,
     'a Ana aparece em primeiro por ter feito duas viagens');
  ok(r.dias.length === 3 && r.dias[0].dia === '2026-10-01' && r.dias[0].n === 2,
     'o melhor dia é o que concentra mais viagens/faturamento');
  ok(r.diasComMovimento === 3, 'dias com movimento conta os dias com viagem');
  ok(r.pico === 10 && r.horasPico[0].n === 2,
     'a hora de pico é a em que mais se saiu (10h com duas saídas)');
  ok(r.horas[18].n === 2 && r.horas[3].n === 0,
     'as 24 faixas de hora ficam preenchidas (18h com duas, 3h vazia)');
  ok(r.melhorDia === '2026-10-01', 'o melhor dia fica registrado no resumo');
  const vazio = ctx.R.relatorioDoMes('2026-08');
  ok(vazio.n === 0 && vazio.fat === 0 && vazio.ticket === 0 &&
     vazio.clientes.length === 0 && vazio.dias.length === 0 && vazio.pico === null,
     'mês sem viagens devolve zero em tudo, sem quebrar');
}

/* ------------------------------------------------------------------ J */
/* A senha é derivada no navegador (WebCrypto) e no servidor (crypto do
   Node). Se os dois não calcularem exatamente a mesma chave, ninguém
   entra pelo usuário cadastrado na aba Usuários. */
async function testarParidadeDaSenha(){
  console.log('\nJ. Senha — navegador e servidor derivam a mesma chave');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const auth = require('../lib/auth');

  const ctx = vm.createContext({ console, crypto, TextEncoder });
  vm.runInContext([
    extrairLinha(html, 'ITERACOES_PBKDF2'),
    extrairFuncao(html, 'hexDe'),
    extrairFuncao(html, 'bytesDeHex'),
    extrairAssincrona(html, 'hashSenha'),
    'globalThis.H = { hashSenha };'
  ].join('\n'), ctx);

  const salt = auth.novoSalt();
  const senha = 'outraSenha456';
  const noNavegador = await ctx.H.hashSenha(senha, salt);
  const noServidor = auth.hashSenha(senha, salt);
  ok(noNavegador === noServidor,
     'o navegador e o servidor derivam a mesma chave',
     noNavegador + ' x ' + noServidor);
  ok(await ctx.H.hashSenha(senha + 'x', salt) !== noServidor,
     'uma letra de diferença muda a chave');
  ok(await ctx.H.hashSenha(senha, auth.novoSalt()) !== noServidor,
     'outro salt muda a chave');
}

/* ------------------------------------------------------------------ C */
async function testarBanco(){
  console.log('\nC. Banco de dados (transação descartada ao final)');
  const url = process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL ||
              process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL;
  if(!url){
    console.log('  – POSTGRES_URL ausente: teste de banco pulado.');
    console.log('    Rode `vercel env pull .env.local` e `npm run schema` antes do `npm test`.');
    return;
  }

  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, ssl: /@(localhost|127\.0\.0\.1)/.test(url) ? false : { rejectUnauthorized:false } });
  const c = await pool.connect();
  try{
    await c.query('begin');

    /* 18. lock otimista */
    const ini = await c.query('select versao from public.estado where id = 1');
    const v0 = Number(ini.rows[0].versao);
    const docA = { teste: 'A', veiculos: [] };

    const ok1 = await c.query('select ok, versao from public.salvar_estado($1,$2,$3)',
      [JSON.stringify(docA), v0, 'teste']);
    ok(ok1.rows[0].ok === true || Number(ok1.rows[0].ok) === 1, 'gravação com versão correta é aceita (v ' + v0 + '→' + ok1.rows[0].versao + ')');

    const docB = { teste: 'B', veiculos: [] };
    const ok2 = await c.query('select ok, versao, doc from public.salvar_estado($1,$2,$3)',
      [JSON.stringify(docB), v0, 'teste']);
    const recusado = ok2.rows[0].ok === false || Number(ok2.rows[0].ok) === 0;
    ok(recusado, 'gravação com versão defasada é recusada');
    ok(ok2.rows[0].doc && ok2.rows[0].doc.teste === 'A', 'estado antigo preservado — nada foi sobrescrito');

    const ve = await c.query('select doc from public.estado where id = 1');
    ok(ve.rows[0].doc.teste === 'A', 'banco continua com o documento A');

    /* histórico imutável */
    const ev = await c.query("insert into public.eventos (usuario, acao, detalhe) values ('teste','npm_test','...') returning id");
    ok(!!ev.rows[0].id, 'evento registrado');
    let bloqueado = false;
    try{ await c.query('update public.eventos set acao = $1 where id = $2', ['hack', ev.rows[0].id]); }
    catch(e){ bloqueado = true; }
    ok(bloqueado, 'UPDATE em eventos é recusado pelo banco');
    bloqueado = false;
    try{ await c.query('delete from public.eventos where id = $1', [ev.rows[0].id]); }
    catch(e){ bloqueado = true; }
    ok(bloqueado, 'DELETE em eventos é recusado pelo banco');

    /* fotos */
    const caminho = 'teste/' + Date.now() + '.jpg';
    const bytes = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==', 'base64');
    await c.query('insert into public.fotos (caminho, mime, bytes, tamanho) values ($1,$2,$3,$4)',
      [caminho, 'image/jpeg', bytes, bytes.length]);
    const fl = await c.query('select octet_length(bytes) as n from public.fotos where caminho = $1', [caminho]);
    ok(Number(fl.rows[0].n) === bytes.length, 'foto gravada e lida com o mesmo tamanho');

    /* assinatura */
    const token = 'T' + Date.now().toString(36).toUpperCase();
    await c.query(`insert into public.assinaturas (token, cliente_nome, contrato, resumo)
                   values ($1,$2,$3,$4)`,
      [token, 'Cliente de teste', 'Contrato de teste com texto longo o bastante para ser aceito pelo sistema.',
       JSON.stringify({ total: 60 })]);
    await c.query(`update public.assinaturas set status='assinada', assinatura=$2, assinado_em=now() where token=$1`, [token, 'data:image/png;base64,AAAA']);
    const as = await c.query('select status, assinatura from public.assinaturas where token = $1', [token]);
    ok(as.rows[0].status === 'assinada' && as.rows[0].assinatura === 'data:image/png;base64,AAAA', 'assinatura gravada');

    /* snapshot diário */
    const snap = await c.query('select count(*) as n from public.snapshots');
    ok(Number(snap.rows[0].n) >= 0, 'snapshots acessíveis');

    await c.query('rollback');
    console.log('  – transação revertida: os testes não deixaram dado para trás.');
  }catch(e){
    try{ await c.query('rollback'); }catch(_){}
    reprovados++;
    console.log('  ✗ erro no banco: ' + e.message);
  }finally{
    c.release();
    await pool.end();
  }
}

/* ------------------------------------------------------------------ K */
function testarVistoria(){
  console.log('\nK. Vistoria — o balcão paga, o celular libera');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const corpo = f => extrairFuncao(html, f);
  const pagina = fs.readFileSync(path.join(__dirname, '..', 'vistoria.html'), 'utf8');
  const api = fs.readFileSync(path.join(__dirname, '..', 'api', 'vistoria.js'), 'utf8');
  const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));

  /* --- a fila mora no sistema, com aba própria --- */
  ok(/<button data-tab="vistoria">Vistoria<\/button>/.test(html), 'a navegação tem a aba Vistoria');
  ok(/<section class="page" id="page-vistoria">/.test(html), 'a aba tem a página própria');
  ok(html.indexOf("vistoria:'renderVistoria'") >= 0 && /if\(tab==='vistoria'\) renderVistoria\(\)/.test(html),
     'a aba é redesenhada ao entrar e quando os dados mudam');
  ok(corpo('renderVistoria').indexOf('linkVistoria()') >= 0, 'a aba mostra o link público da vistoria');
  ok(html.indexOf('function pintarQr(') >= 0 && pagina.indexOf('QRCode') < 0,
     'o QR Code fica no balcão; o celular só lê o link');

  /* --- três passos no balcão --- */
  const pw = corpo('pintaWizard');
  ok(/\[1,2,3\]\.map/.test(pw), 'o wizard tem exatamente três passos');
  ok(pw.indexOf("W.passo===3 ? 'Pagar e enviar para vistoria'") >= 0,
     'o último botão é "Pagar e enviar para vistoria"');
  ok(pw.indexOf('passoTarifa()') >= 0 && pw.indexOf('passoContrato()') >= 0,
     'pagamento e contrato juntos no passo 3');
  ok(html.indexOf('function passoVistoria(') < 0 && html.indexOf('W.fotos') < 0,
     'a vistoria de saída saiu do balcão (sem passo 4 e sem fotos no wizard)');
  ok(html.indexOf('function perguntarImprimir(') < 0, 'o fim do pagamento é o link da vistoria, não só a impressão');

  /* --- o que o balcão grava --- */
  const cl = corpo('concluirLocacao');
  ok(cl.indexOf("status: 'pendente'") >= 0, 'a locação fica pendente até a vistoria');
  ok(cl.indexOf('pagoEm: pagoAgora') >= 0, 'a hora do pagamento fica guardada para o dinheiro do dia');
  ok(cl.indexOf("status:'aguardando_vistoria'") >= 0, 'o contrato criado fica aguardando vistoria');
  ok(cl.indexOf("getVeiculo(i.veiculoId).status = 'rua'") < 0,
     'o veículo não sai da loja antes de alguém confirmar a liberação');
  ok(cl.indexOf('mostrarLinkVistoria(grupo)') >= 0, 'o fim do pagamento entrega o link da vistoria');
  const ml = corpo('mostrarLinkVistoria');
  ok(ml.indexOf('window.QRCode') >= 0 && ml.indexOf('linkVistoria()') >= 0,
     'a tela final mostra o QR Code e o link para passar adiante');

  /* --- travas --- */
  ok(/filter\(v=>v\.status==='loja' && !veiculoTravado\(v\.id\)\)/.test(html),
     'veículo pago não aparece na lista do passo 1');
  ok(corpo('locPendenteDoVeiculo').indexOf("status==='pendente'") >= 0 &&
     corpo('veiculoTravado').indexOf('locPendenteDoVeiculo') >= 0,
     'a trava é a locação pendente do veículo');
  ok(html.indexOf('pill pendente') >= 0 && html.indexOf('aguardando vistoria') >= 0,
     'a Frota mostra o veículo travado como aguardando vistoria');
  ok(/kpi\('Locações hoje'/.test(html) && /filaVistoria/.test(html),
     'o Painel avisa que tem veículo pago esperando liberação');

  /* --- chegada e fechamento no balcão --- */
  ok(/loc\.status!=='ativa' && loc\.status!=='devolvida'/.test(html),
     'a tela de entrada aceita a chegada já registrada no celular');
  ok(html.indexOf('loc.fimReal || agora') >= 0 && html.indexOf('loc.fimReal || Date.now()') >= 0,
     'o tempo de uso usa a hora real da chegada');
  ok(html.indexOf('const chegada = loc.status===\'devolvida\';') >= 0,
     'a tela avisa que a chegada veio da vistoria');
  ok(/Fotos\.obter\(f\.id, f\.caminho\)/.test(html), 'as fotos da vistoria aparecem na tela do balcão');

  /* --- link e token --- */
  ok(corpo('aplicarMigracoes').indexOf('vistoriaToken') >= 0, 'a migração gera o token do link');
  ok(html.indexOf("'/vistoria/'") >= 0, 'linkVistoria aponta para /vistoria/{token}');
  ok(html.indexOf('function tokenPublico(') >= 0, 'o token é gerado no próprio aparelho');

  /* --- o dinheiro continua no dia em que entrou --- */
  ['entradasDoDia','entradasDoMes','relatorioDoMes'].forEach(f=>
    ok(corpo(f).indexOf('tsCobranca(') >= 0, f + ' conta pelo dia em que foi pago'));
  const ctx = vm.createContext({ console });
  vm.runInContext([corpo('tsCobranca'), 'globalThis.T = { tsCobranca };'].join('\n'), ctx);
  igual(ctx.T.tsCobranca({ pagoEm: 1000, inicio: 500 }), 1000, 'pago agora vale a hora do pagamento');
  igual(ctx.T.tsCobranca({ inicio: 500 }), 500, 'registro antigo continua usando a hora da saída');

  /* --- a API pública --- */
  ok(api.indexOf('tokenValido') >= 0 && api.indexOf("acao !== 'liberar' && acao !== 'chegada'") >= 0,
     'a API só aceita liberar e registrar chegada');
  ok(api.indexOf("loc.status = 'ativa'") >= 0 && api.indexOf("loc.status = 'devolvida'") >= 0,
     'liberar torna a locação ativa; a chegada marca como devolvida');
  ok(api.indexOf('salvar_estado') >= 0, 'a gravação passa pelo lock otimista do documento');
  const pub = extrairFuncao(api, 'payload');
  ok(pub.indexOf('clienteCpf') < 0 && pub.indexOf('contrato') < 0 && pub.indexOf('assinatura') < 0,
     'o payload público não leva CPF nem o contrato');
  ok(api.indexOf('foto_obrigatoria') >= 0 && !/lacre/i.test(api),
     'a foto segue exigida e a API não fala mais de lacre em nenhum ponto');
  ok(!/lacre/i.test(pagina),
     'o cartão da vistoria não tem campo de lacre: o QR identifica o patinete');
  ok(api.indexOf('codigoLido') >= 0 && api.indexOf('veiculo_nao_escaneado') >= 0 &&
     api.indexOf('veiculo_incorreto') >= 0,
     'a API exige o código escaneado da etiqueta e confere com o cartão');
  ok(!/lacreSaida|lacreEntrada|lacreEsperado/.test(api),
     'liberação e chegada não gravam mais nenhum campo de lacre');
  ok(api.indexOf('String(l.id) === String(locId)') >= 0 && api.indexOf('mesmaLoc') >= 0,
     'a API acha a locação mesmo com o id chegando como texto do cartão');
  ok(pagina.indexOf('locacaoId: String(locId)') >= 0,
     'a página manda o id do cartão como ele é (texto)');

  /* --- a página do celular --- */
  ok(pagina.indexOf("qs.get('token')") >= 0, 'a página lê o token do link');
  ok(pagina.indexOf('capture="environment"') >= 0, 'a câmera do celular abre direto na foto');
  ok(pagina.indexOf('Vistoriado e liberar') >= 0 && pagina.indexOf('Registrar chegada') >= 0,
     'a página faz a liberação e a chegada');
  ok(pagina.indexOf('/api/vistoria') >= 0 && pagina.indexOf('noindex') >= 0,
     'a página fala só com a API e não é indexada');
  ok(pagina.indexOf('senha') < 0 && pagina.indexOf('type="password"') < 0,
     'a página pública não tem tela de login');

  /* --- a etiqueta identifica o patinete --- */
  ok(pagina.indexOf('decodeFromVideoDevice') >= 0 && pagina.indexOf('ZXing') >= 0,
     'o celular lê a etiqueta pela câmera (QR ou tarja de código)');
  ok(pagina.indexOf('data-escanear') >= 0 && pagina.indexOf('btnScanTopo') >= 0,
     'tem botão de escanear dentro do cartão e no topo da tela');
  ok(pagina.indexOf('Digitar o código') >= 0,
     'sem câmera dá para digitar o código da etiqueta');
  ok(pagina.indexOf('veiculo: c.veiculo') >= 0 && !/lacre/i.test(pagina),
     'a saída não tem campo de lacre: manda o código escaneado');
  ok((pagina.match(/blocoScan\(l\.locacaoId, l\.codigo\)/g) || []).length === 2,
     'os dois cartões (saída e chegada) identificam o patinete pelo QR');
  ok(vercel.rewrites.some(r => r.source === '/vistoria/:token'), 'o link /vistoria/{token} chega na página');
}

/* ------------------------------------------------------------------ L */
/* A seção QR Codes (dentro de Configurações) gera a etiqueta de cada
   patinete: o QR carrega só o código (PAT-001) e é o que o celular lê. */
function testarEtiquetas(){
  console.log('\nL. QR Codes — a etiqueta de cada patinete');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const corpo = f => extrairFuncao(html, f);

  ok(!/data-tab="etiquetas"/.test(html) && !/id="page-etiquetas"/.test(html),
     'a navegação não tem mais a aba QR Codes');
  ok(/<div class="secaoPainel" id="secEtiquetas">/.test(html) &&
     /id="page-config"[\s\S]*id="secEtiquetas"/.test(html),
     'os QR Codes são uma seção recolhível dentro de Configurações');
  ok(corpo('renderConfig').indexOf('renderEtiquetas()') >= 0 &&
     html.indexOf("$('#tglEtiquetas').onclick") >= 0,
     'a seção é redesenhada ao abrir, e o botão expande e desenha a grade');
  ok(corpo('abrirSecaoEtiquetas').indexOf("irPara('config')") >= 0 &&
     corpo('oferecerEtiquetas').indexOf('abrirSecaoEtiquetas()') >= 0,
     'cadastrar em lote já oferece as etiquetas e leva até a seção');
  ok(/jspdf\/2\.5\.1\/jspdf\.umd\.min\.js/.test(html), 'o PDF da folha sai pelo jsPDF, ao lado do gerador de QR');

  const qf = corpo('qrFonte');
  ok(qf.indexOf('_oQRCode') >= 0 && qf.indexOf('getModuleCount') >= 0 && qf.indexOf('isDark') >= 0,
     'a matriz do QR vem do próprio gerador (linha nítida, sem borrado)');
  ok(qf.indexOf("d.querySelector('canvas')") >= 0 && html.indexOf('f.cv.toDataURL') >= 0,
     'quando a matriz não der, a etiqueta usa a imagem gerada');
  ok(html.indexOf('function qrSvg(') >= 0 && html.indexOf('function folhaSvg(') >= 0,
     'o SVG é montado a partir da matriz (vetor de verdade)');
  ok(/unit:'mm', format:'a4'/.test(html) && html.indexOf('ETQ_COL = 3, ETQ_LIN = 6') >= 0,
     'o PDF é A4 com 3 x 6 etiquetas por folha');
  ok(corpo('folhaImpressao').indexOf('window.print()') >= 0 && html.indexOf('#printarea .etq') >= 0,
     'a folha de impressão sai pelo #printarea do sistema');
  ok(html.indexOf('onclick="baixarEtiqueta(') >= 0 && corpo('baixarEtiqueta').indexOf('.png') >= 0,
     'cada linha da Frota baixa a etiqueta daquele patinete em PNG');
  ok(html.indexOf('oferecerEtiquetas(criados)') >= 0,
     'cadastrar em lote continua oferecendo as etiquetas da frota nova');
  ok(corpo('etiquetasLista').indexOf('etqFoco') >= 0 && corpo('renderEtiquetas').indexOf('etiquetasLista') >= 0,
     'a grade mostra a frota filtrada (ou só a que acabou de sair do lote)');
  ok(html.indexOf('QR indisponível') >= 0 && html.indexOf('new QRCode(') >= 0,
     'sem internet avisa em vez de quebrar a tela');
}

/* ------------------------------------------------------------------ M */
/* Um cliente pode levar 3 patinetes e 2 motos e pagar cada um de um jeito
   (Pix no patinete, dinheiro numa moto, crédito na outra) — ou pagar tudo
   da mesma forma, como sempre. A forma mora em cada locação, e é isso que
   o caixa separa por forma no fim do dia. */
function testarPagamentoPorVeiculo(){
  console.log('\nM. Forma de pagamento — uma para a locação ou uma por veículo');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const corpo = f => extrairFuncao(html, f);

  /* --- o interruptor do passo 3 --- */
  const pt = corpo('passoTarifa');
  ok(pt.indexOf('data-pgmodo="unica"') >= 0 && pt.indexOf('data-pgmodo="porVeiculo"') >= 0,
     'o passo 3 escolhe entre uma forma só e uma por veículo');
  ok(pt.indexOf('id="wPgTabela"') >= 0 && pt.indexOf('Uma forma para toda a locação') >= 0,
     'a tabela por veículo existe e começa escondida');
  const lg = corpo('ligaPassoTarifa');
  ok(lg.indexOf('W.pagamentos[') >= 0 && lg.indexOf('[data-pg]') >= 0,
     'cada select da tabela grava a forma daquele veículo');
  ok(lg.indexOf('id="wPgTodos"') >= 0 && lg.indexOf("$('#wPgto').value") >= 0,
     'um botão aplica a forma padrão a todas as linhas');
  ok(lg.indexOf('pintaSoma') >= 0, 'a soma por forma aparece na hora em que muda alguma linha');
  ok(corpo('concluirLocacao').indexOf('pagamento: i.pagamento || W.pagamento') >= 0,
     'cada locação grava a forma do próprio veículo');

  /* --- os helpers rodando de verdade --- */
  const ctx = vm.createContext({ console });
  vm.runInContext([
    extrairVetor(html, 'PAGAMENTOS'),
    extrairLinha(html, 'brl'),
    'globalThis.esc = s => String(s==null?\'\':s);',
    extrairFuncao(html, 'pagamentoDe'),
    extrairFuncao(html, 'pagamentosAgrupados'),
    extrairFuncao(html, 'textoPagamento'),
    extrairFuncao(html, 'linhasPagamento'),
    'globalThis.W = { pagamento:"Pix", pagamentos:{} };',
    'globalThis.T = { pagamentoDe, pagamentosAgrupados, textoPagamento, linhasPagamento };'
  ].join('\n'), ctx);
  const T = ctx.T;
  const itens = [
    { codigo:'PAT-001', valor:80,  pagamento:'Pix' },
    { codigo:'PAT-002', valor:80,  pagamento:'Pix' },
    { codigo:'PAT-003', valor:80,  pagamento:'Pix' },
    { codigo:'MOTO-01', valor:100, pagamento:'Dinheiro' },
    { codigo:'MOTO-02', valor:100, pagamento:'Cartão de crédito' }
  ];
  const g = T.pagamentosAgrupados(itens);
  igual(g.length, 3, 'cinco veículos pagos de três jeitos → três formas');
  const pix = g.find(x=>x.forma==='Pix');
  igual(pix.total, 240, 'os três patinetes somam R$ 240,00 no Pix');
  igual(pix.codigos.length, 3, 'o Pix guarda os códigos dos veículos pagos com ele');
  const detalhe = T.textoPagamento(itens, true);
  ok(detalhe === 'Cartão de crédito (MOTO-02), Dinheiro (MOTO-01), Pix (PAT-001, PAT-002, PAT-003)',
     'o contrato detalha a forma de cada equipamento', detalhe);
  ok(T.textoPagamento([{codigo:'PAT-001', valor:60, pagamento:'Pix'}]) === 'Pix',
     'com uma forma só o texto continua sendo o nome dela');
  const lh = T.linhasPagamento(itens);
  ok(lh.indexOf('Pago em 3 formas') >= 0 && (lh.match(/class="l"/g)||[]).length === 3,
     'o resumo lista uma linha por forma com o total de cada uma');
  const unica = T.linhasPagamento([{codigo:'PAT-001', valor:60, pagamento:'Pix'}]);
  ok(unica.indexOf('Pago via Pix') >= 0 && unica.indexOf('Pago em') < 0,
     'com uma forma só o resumo continua igual ao de antes');

  /* --- itensDaLocacao: um select por veículo --- */
  vm.runInContext([
    'globalThis.COD = { 1:"PAT-001", 2:"PAT-002", 3:"PAT-003", 4:"MOTO-01", 5:"MOTO-02" };',
    'globalThis.getVeiculo = id => ({ id:id, codigo:COD[id], tipoId: id<=3 ? "patinete" : "moto" });',
    'globalThis.getTipo = id => ({ id:id, nome:id, tarifas:[{ id:"t", label:"1 h", min:60, valor: id==="patinete" ? 80 : 100 }] });',
    'globalThis.tarifaPorMin = (tipo,min) => tipo.tarifas.find(t=>t.min===min);',
    extrairFuncao(html, 'itensDaLocacao')
  ].join('\n'), ctx);
  ctx.W = { veiculos:[1,2,3,4,5], pagamento:'Pix', pagamentos:{ '4':'Dinheiro', '5':'Cartão de crédito' } };
  vm.runInContext('globalThis.its = itensDaLocacao(60);', ctx);
  const its = ctx.its;
  igual(its.length, 5, 'o passo 3 monta um item por veículo do grupo');
  igual(its.filter(i=>i.pagamento==='Pix').length, 3, 'os três patinetes herdam a forma da locação');
  ok(its.find(i=>i.codigo==='MOTO-01').pagamento === 'Dinheiro', 'a moto 1 é paga em dinheiro');
  ok(its.find(i=>i.codigo==='MOTO-02').pagamento === 'Cartão de crédito', 'a moto 2 é paga no crédito');

  /* --- o caixa do dia separa cada forma, que é o que a loja confere --- */
  const ctx2 = vm.createContext({ console });
  vm.runInContext([
    extrairFuncao(html, 'diaKey'),
    extrairFuncao(html, 'estornada'),
    extrairFuncao(html, 'tsCobranca'),
    extrairFuncao(html, 'entradasDoDia'),
    'globalThis.DB = { locacoes: [] };',
    'globalThis.C = { entradasDoDia, diaKey };'
  ].join('\n'), ctx2);
  const agora = Date.now(), dia = ctx2.C.diaKey(agora);
  ctx2.DB = { locacoes: itens.map(i=>({ status:'pendente', pagoEm:agora, valorBase:i.valor,
                                        pagamento:i.pagamento, veiculoCodigo:i.codigo })) };
  const e = ctx2.C.entradasDoDia(dia);
  igual(e.porForma['Pix'], 240, 'no fechamento, o Pix dos patinetes é uma linha');
  igual(e.porForma['Dinheiro'], 100, 'o dinheiro da moto é outra linha');
  igual(e.porForma['Cartão de crédito'], 100, 'e o crédito da outra moto, outra ainda');
  igual(e.total, 440, 'o total do dia é a soma dos cinco veículos');

  /* --- contrato, assinatura e link --- */
  const mc = corpo('montarContrato');
  ok(mc.indexOf('dividido') >= 0 && mc.indexOf('pago em') >= 0,
     'no contrato dividido, cada equipamento entra com a forma com que foi pago');
  ok(html.indexOf('{{pagamento}}') >= 0, 'o contrato continua com o campo {{pagamento}}');
  ok(corpo('publicarContrato').indexOf('textoPagamento(d.itens)') >= 0,
     'a assinatura no celular recebe a lista de formas');
  ok(corpo('passoContrato').indexOf('linhasPagamento(d.itens)') >= 0,
     'o resumo antes de assinar também');
  ok(corpo('mostrarLinkVistoria').indexOf('linhasPagamento(') >= 0,
     'o fim do pagamento mostra uma linha por forma quando é dividido');
  ok((html.match(/id="gPgto"/g)||[]).length === 1,
     'o excedente da devolução continua sendo cobrado com uma forma só');
}

function testarTiposDeVeiculo(){
  console.log('\nN. Tipos de veículo — marca/modelo novo com preço próprio');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const corpo = f => extrairFuncao(html, f);

  /* --- o formulário da frota --- */
  const fv = corpo('formVeiculo');
  ok(fv.indexOf('__novo') >= 0 && fv.indexOf('blocoNovoTipo(') >= 0,
     'o campo Tipo do veículo oferece criar um tipo novo');
  ok(fv.indexOf('Tipo (marca e modelo)') >= 0, 'o rótulo já diz marca e modelo');
  const bn = corpo('blocoNovoTipo');
  ok(bn.indexOf('NtPreco') >= 0 && bn.indexOf('NtBase') >= 0 &&
     bn.indexOf('NtExc') >= 0 && bn.indexOf('NtPecas') >= 0 &&
     corpo('linhasNovoTipo').indexOf('data-ntmin') >= 0,
     'o bloco pede nome, tipo de origem, preço por duração, excedente e cópia das peças');
  ok((html.match(/value="__novo"/g)||[]).length === 2,
     'a opção existe no cadastro avulso e no cadastro em lote');
  ok(html.indexOf("ligaNovoTipo(ov, 'v')") > 0 && html.indexOf("ligaNovoTipo(ov, 'l')") > 0,
     'nos dois formulários o bloco abre quando escolhe “+ Novo tipo”');
  ok((html.match(/= lerNovoTipo\(ov, /g)||[]).length === 3,
     'novo, editar e em lote passam pelo mesmo caminho');
  ok(corpo('lerNovoTipo').indexOf('criarTipo(') >= 0 &&
     corpo('lerNovoTipo').indexOf('Já existe um tipo com esse nome') >= 0,
     'o balcão não deixa criar dois tipos com o mesmo nome');

  /* --- criarTipo rodando de verdade --- */
  const ctx = vm.createContext({ console });
  vm.runInContext([
    extrairVetor(html, 'TIPOS_PADRAO'),
    extrairVetor(html, 'PECAS_PADRAO'),
    extrairLinha(html, 'uid'),
    extrairFuncao(html, 'getTipo'),
    extrairFuncao(html, 'rotuloMin'),
    extrairFuncao(html, 'criarTipo'),
    extrairFuncao(html, 'excluirTipo'),
    'globalThis.DB = { tipos: JSON.parse(JSON.stringify(TIPOS_PADRAO)),' +
      ' pecas: JSON.parse(JSON.stringify(PECAS_PADRAO)), veiculos: [], locacoes: [], seq:{ peca:100 } };',
    'globalThis.T = { criarTipo, getTipo, rotuloMin, excluirTipo, DB };'
  ].join('\n'), ctx);
  const T = ctx.T;
  const t = T.criarTipo({ nome:'Niu NQi GT', base:'patinete', excedenteMin:1.8,
    precos:[{min:15, valor:25}, {min:30, valor:45}, {min:60, valor:80}], copiarPecas:true });
  ok(typeof t.id === 'string' && t.id.charAt(0) === 't',
     'o tipo novo nasce com id de texto, que é o que o select devolve');
  ok(T.getTipo(t.id) === t, 'getTipo encontra o tipo novo');
  ok(t.nome === 'Niu NQi GT' && t.tarifas.map(x=>x.min).join() === '15,30,60',
     'guarda o nome e as mesmas durações do tipo de origem');
  igual(t.tarifas[0].valor, 25, '15 minutos do modelo novo custa R$ 25,00');
  igual(t.tarifas[2].valor, 80, '1 hora do modelo novo custa R$ 80,00 — preço por modelo');
  ok(t.tarifas[0].label === '15 minutos' && t.tarifas[2].label === '1 hora',
     'os rótulos seguem o padrão do sistema');
  igual(t.excedenteMin, 1.8, 'o excedente do modelo novo também é segmentado');
  const nascidas = T.DB.pecas.filter(p=>String(p.tipoId) === String(t.id)).length;
  const origem = T.DB.pecas.filter(p=>String(p.tipoId) === 'patinete').length;
  igual(nascidas, origem, 'a tabela de peças do tipo de origem veio junto');
  ok(T.DB.pecas.filter(p=>String(p.tipoId)===String(t.id)).every(p=>p.id >= 100),
     'as peças copiadas ganham id novo, fora do range das de fábrica');
  const sem = T.criarTipo({ nome:'Zico Bike', base:'moto', excedenteMin:2,
    precos:[{min:15, valor:12}], copiarPecas:false });
  igual(T.DB.pecas.filter(p=>String(p.tipoId)===String(sem.id)).length, 0,
     'dá para criar sem copiar as peças');
  igual(T.DB.tipos.length, 4, 'os dois tipos de fábrica continuam intactos');
  ok(new Set(T.DB.tipos.map(x=>x.id)).size === T.DB.tipos.length, 'nenhum id repetido');
  ok(T.rotuloMin(60) === '1 hora' && T.rotuloMin(120) === '2 horas' &&
     T.rotuloMin(45) === '45 minutos', 'o rótulo da duração sai no formato certo');

  /* --- exclusão: só tipo sem veículo e sem histórico --- */
  const bt = corpo('excluirTipo');
  ok(bt.indexOf('DB.veiculos.some') >= 0 && bt.indexOf('DB.locacoes.some') >= 0,
     'a exclusão recusa tipo com veículo ou com locação no histórico');
  T.DB.veiculos.push({ id:1, codigo:'NOVO-01', tipoId:t.id });
  ok(T.excluirTipo(t.id).erro === 'veiculos', 'com veículo no tipo, é recusado');
  ok(T.DB.tipos.some(x=>x.id===t.id), 'e nada foi apagado');
  ok(typeof T.excluirTipo(sem.id, ()=>false) === 'object' && T.DB.tipos.some(x=>x.id===sem.id),
     'sem veículo, mas com o balcão cancelando, o tipo continua lá');
  const livre = T.criarTipo({ nome:'Teste Excluir', base:'patinete', excedenteMin:1,
    precos:[{min:15, valor:20}], copiarPecas:false });
  const rem = T.excluirTipo(livre.id, ()=>true);
  ok(rem.ok && rem.ok.nome === 'Teste Excluir', 'sem uso e com confirmação, é excluído');
  ok(!T.DB.tipos.some(x=>x.id===livre.id) && !T.DB.pecas.some(p=>String(p.tipoId)===String(livre.id)),
     'o tipo e as peças dele saíram da base');

  /* --- o wizard com patinete e modelo novo misturados --- */
  const ctx2 = vm.createContext({ console });
  vm.runInContext([
    extrairVetor(html, 'TIPOS_PADRAO'),
    extrairFuncao(html, 'getTipo'),
    extrairFuncao(html, 'getVeiculo'),
    extrairFuncao(html, 'tiposSelecionados'),
    extrairFuncao(html, 'tarifaPorMin'),
    extrairFuncao(html, 'duracoesDisponiveis'),
    'globalThis.DB = { tipos: JSON.parse(JSON.stringify(TIPOS_PADRAO)),' +
      ' veiculos: [ {id:1, codigo:"PAT-001", tipoId:"patinete"}, {id:2, codigo:"NOVO-01", tipoId:"t1"} ] };',
    'globalThis.W = { veiculos:[1,2] };',
    'globalThis.T = { duracoesDisponiveis, tarifaPorMin };'
  ].join('\n'), ctx2);
  ctx2.DB.tipos.push({ id:'t1', nome:'Niu NQi GT', excedenteMin:1.8, tarifas:[
    { id:'x1', label:'15 minutos', min:15, valor:25 },
    { id:'x2', label:'30 minutos', min:30, valor:45 },
    { id:'x3', label:'1 hora',     min:60, valor:80 } ] });
  ok(ctx2.T.duracoesDisponiveis().join() === '15,30,60',
     'patinete e modelo novo nas mesmas durações → as três ficam à escolha');
  ok(ctx2.T.tarifaPorMin(ctx2.DB.tipos.find(x=>x.id==='t1'), 15).valor === 25,
     'o preço mostrado no passo 3 é o do modelo escolhido');
  ctx2.DB.tipos.push({ id:'t2', nome:'Scooter 45', excedenteMin:2, tarifas:[
    { id:'y1', label:'30 minutos', min:30, valor:60 },
    { id:'y2', label:'1 hora',     min:60, valor:110 } ] });
  ctx2.DB.veiculos.push({ id:3, codigo:'SCOOT-01', tipoId:'t2' });
  ctx2.W.veiculos = [1,3];
  ok(ctx2.T.duracoesDisponiveis().join() === '30,60',
     'tabela diferente: só as durações comuns entre os modelos seguem em frente');
  ok(corpo('passoTarifa').indexOf('durs.indexOf(W.duracao)') >= 0,
     'se a lista de veículos mudar, um período que saiu da lista é descartado');

  /* --- o que a loja enxerga depois --- */
  ok(corpo('renderFrota').indexOf('DB.tipos.length + 1') >= 0,
     'o filtro de tipos da frota se repinta quando nasce um tipo novo');
  ok(corpo('renderEtiquetas').indexOf('DB.tipos.length + 1') >= 0,
     'o filtro de tipos das etiquetas QR também');
  ok(html.indexOf("log('tipo_novo'") > 0 && html.indexOf("log('tipo_excluido'") > 0 &&
     html.indexOf("tipo_novo:'Criou tipo de veículo'") > 0,
     'criar e excluir tipo ficam na auditoria, em português');
  ok(html.indexOf('if(!DB.tipos || !DB.tipos.length) DB.tipos') > 0,
     'base sem tipo nenhum recebe os dois de fábrica no arranque');
}

/* ------------------------------------------------------------------ O */
/* O operador cadastra, edita e agora também exclui o cliente. Excluir é
   apagar só a ficha: cada locação já guarda nome e CPF, então histórico,
   caixa e relatórios ficam intactos. Com devolução em aberto não dá. */
function testarClientes(){
  console.log('\nO. Clientes — editar e excluir cadastro');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
  const corpo = f => extrairFuncao(html, f);

  ok(/onclick="editarCliente\(/.test(html) && /onclick="excluirCliente\(/.test(html),
     'a linha do cliente traz Editar e Excluir');
  ok(/onclick="excluirCliente\(/.test(app),
     'o app.html (demonstração offline) acompanha o mesmo botão');
  ok(html.indexOf('W.clienteId && getCliente(W.clienteId)') >= 0,
     'a etapa do cliente só grava no cadastro se ele ainda existir (repasse entre aparelhos)');

  const rodar = (clientes, locacoes, confirmar) => {
    const r = { toast:null, msg:null, confirmou:0, log:null, persistiu:0 };
    const ctx = vm.createContext({
      console,
      DB: { clientes: clientes.map(c=>Object.assign({},c)), locacoes: locacoes.map(l=>Object.assign({},l)) },
      confirm: m => { r.confirmou++; r.msg = m; return confirmar; },
      toast: m => { r.toast = m; },
      log: (a,d) => { r.log = a + ' — ' + d; },
      persist: () => { r.persistiu++; },
      renderClientes: () => {}
    });
    ctx.getCliente = id => ctx.DB.clientes.find(c=>c.id===id);
    vm.runInContext(corpo('excluirCliente') + '; this.chamar = excluirCliente;', ctx);
    r.chamar = id => ctx.chamar(id);
    r.ctx = ctx;
    return r;
  };

  const r1 = rodar([{id:1, nome:'Ana'}, {id:2, nome:'Beto'}],
                   [{id:10, clienteId:1, status:'ativa'}], true);
  r1.chamar(1);
  ok(r1.confirmou === 0 && /em aberto/.test(r1.toast||'') && r1.ctx.DB.clientes.length === 2,
     'com locação em aberto a exclusão é recusada e diz o motivo',
     r1.toast || 'sem aviso');

  const r2 = rodar([{id:1, nome:'Ana'}], [{id:11, clienteId:1, status:'devolvida'}], false);
  r2.chamar(1);
  ok(r2.confirmou === 1 && /histórico/.test(r2.msg||'') && r2.ctx.DB.clientes.length === 1,
     'sem histórico o aviso é curto; com histórico avisa que o nome segue nas locações',
     r2.msg || 'sem confirmação');

  const r3 = rodar([{id:1, nome:'Ana'}, {id:2, nome:'Beto'}],
                   [{id:12, clienteId:1, status:'devolvida'}], true);
  r3.chamar(1);
  ok(r3.ctx.DB.clientes.length === 1 && r3.ctx.DB.clientes[0].nome === 'Beto' &&
     r3.ctx.DB.locacoes.length === 1 && r3.persistiu === 1 && /^cliente_excluido/.test(r3.log||''),
     'confirmado: a ficha sai, a locação continua no histórico e vai para a auditoria',
     r3.log || 'sem auditoria');

  const r4 = rodar([{id:9, nome:'Zeca'}], [], true);
  r4.chamar(9);
  ok(r4.confirmou === 1 && r4.ctx.DB.clientes.length === 0 && /Zeca/.test(r4.msg||''),
     'sem locação nenhuma, a confirmação é só o nome do cadastro');
}

/* ------------------------------------------------------------------ P */
/* A operação enxuta do balcão: a aba Vistoria guarda só o link, a fila
   pode ser limpa pelo próprio operador, o celular virou um quadro de três
   colunas e a manutenção tem aba, registro de peças e foto. */
function testarOperacaoEnxuta(){
  console.log('\nP. Operação enxuta — fila da vistoria, Kanban e manutenção');
  const raiz = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(raiz,'index.html'),'utf8');
  const app = fs.readFileSync(path.join(raiz,'app.html'),'utf8');
  const pagina = fs.readFileSync(path.join(raiz,'vistoria.html'),'utf8');
  const api = fs.readFileSync(path.join(raiz,'api','vistoria.js'),'utf8');
  const corpo = f => extrairFuncao(html, f);
  /* funções publicadas em window.X = function(){...} */
  const deJanela = nome=>{
    const i = html.indexOf('window.'+nome+' = function'); if(i < 0) return '';
    let prof = 0;
    for(let k = html.indexOf('{', i); k >= 0 && k < html.length; k++){
      if(html[k] === '{') prof++;
      else if(html[k] === '}'){ prof--; if(prof === 0) return html.slice(i, k+1); }
    }
    return '';
  };

  /* --- a aba Vistoria virou só o link --- */
  ok(/id="btnCopiarLinkVist"/.test(html) && !/id="vistQr"/.test(html) &&
     html.indexOf('vistWhats') < 0,
     'a aba Vistoria guarda só o link público: sem QR e sem botão de WhatsApp');
  ok(html.indexOf('function pintarQr(') >= 0 && html.indexOf('cfgVistQr') >= 0,
     'o QR continua sendo gerado em Configurações, que gera um link novo');
  ok(/id="vistLink"/.test(html) && /id="vistQtdPend"/.test(html),
     'o link público e a fila continuam visíveis na aba');

  /* --- excluir a pendência da fila --- */
  ok(/window\.excluirDaFila = function\(locId\)\{ estornarLocacao\(locId, \{ fila:true \}\); \}/.test(html),
     'a fila tem o atalho excluirDaFila, que chama o estorno em modo fila');
  ok(html.indexOf("if(fila && loc.status !== 'pendente') return;") >= 0 &&
     html.indexOf("if(!fila && !exigirAdministrador('estornar uma locação')) return;") >= 0,
     'modo fila serve só para locação pendente e dispensa o administrador');
  ok(html.indexOf("(fila?'Excluir da fila':'Confirmar estorno')") >= 0 &&
     html.indexOf("log(fila?'fila_excluida':'estorno'") >= 0,
     'o modal muda o texto e a auditoria registra a exclusão da fila');
  ok(/onclick="excluirDaFila\(/.test(html) && /colspan="7"/.test(html),
     'a tabela da fila tem a coluna de ação com o botão Excluir');

  /* --- a chegada só existe com o caixa aberto --- */
  const rv = corpo('renderVistoria');
  ok(rv.indexOf('const comCaixa = caixaAberto();') >= 0 &&
     rv.indexOf("cardFecha.style.display = comCaixa ? '' : 'none'") >= 0,
     'o bloco da chegada registrada aparece só com o caixa do dia aberto');
  const fc = corpo('fecharCaixaModal');
  ok(fc.indexOf("l.status = 'finalizada'") >= 0 && fc.indexOf('chegadas_encerradas') >= 0,
     'fechar o caixa encerra as chegadas do dia e manda para o histórico');
  ok(fc.indexOf('calcExcedente') < 0 && fc.indexOf('sem lançar cobrança nova') >= 0,
     'o fechamento não lança cobrança nova: o que era devido saiu antes da saída');

  /* --- o celular virou um quadro de três colunas --- */
  ok(/class="kanban"/.test(pagina) && /id="colVistoriar"/.test(pagina) &&
     /id="colRua"/.test(pagina) && /id="colEntregues"/.test(pagina),
     'a página do celular é um quadro com três colunas');
  ok(/id="fila"/.test(pagina) && /id="rua"/.test(pagina) && /id="hoje"/.test(pagina),
     'as colunas continuam sendo alimentadas pelos mesmos ids');
  ok(pagina.indexOf('dados.caixaAberto !== false') >= 0 && /Entregues/.test(pagina),
     'a coluna Entregues some quando o caixa do dia está fechado');
  ok(pagina.indexOf('@media (min-width:900px)') >= 0 && pagina.indexOf('scroll-snap-type') >= 0,
     'no celular as colunas correm na horizontal; no desktop as três abrem juntas');

  /* --- a API entrega o estado do caixa --- */
  ok(extrairFuncao(api,'payload').indexOf('caixaAberto') >= 0 &&
     api.indexOf('function caixaAberto(') >= 0,
     'a API diz se o caixa do dia está aberto para a página esconder a coluna');

  /* --- aba Manutenção --- */
  ok(/<button data-tab="manutencao">/.test(html) && /id="page-manutencao"/.test(html),
     'a navegação tem a aba Manutenção com página própria');
  ok(html.indexOf("if(!DB.manutencoes) DB.manutencoes = [];") >= 0 &&
     html.indexOf('if(!DB.seq.manutencao)') >= 0,
     'o banco migra bancos antigos com a lista de manutenções');
  const rm = corpo('renderManutencao');
  ok(rm.indexOf('if(!ehAdministrador()) return;') >= 0,
     'a aba de manutenção é do administrador (defesa dupla)');
  ok(rm.indexOf("v.status==='manutencao'") >= 0 && rm.indexOf('#tbManAbertas') >= 0 &&
     rm.indexOf('#tbManFechadas') >= 0,
     'a aba lista o que está em manutenção e o que foi concluído');
  ok(rm.indexOf('manutencaoAbertaDe') >= 0 && rm.indexOf('miniFotosHTML') >= 0 &&
     rm.indexOf('abrirManutencao(') >= 0 && rm.indexOf('concluirManutencao(') >= 0,
     'cada linha mostra as peças e as fotos e tem os dois botões de ação');
  ok(html.indexOf('window.abrirManutencao = function(veiculoId)') >= 0 &&
     html.indexOf('class="manPeca"') >= 0 && html.indexOf('id="manOutraTexto"') >= 0,
     'o registro marca as peças da tabela do tipo e aceita uma linha livre');
  ok(html.indexOf("fotos: fotos.filter(Boolean)") >= 0,
     'o registro guarda as fotos do veículo junto com as peças');
  const cm = deJanela('concluirManutencao');
  ok(cm.indexOf("obs.length < 3") >= 0 && cm.indexOf("v.status = 'loja'") >= 0,
     'concluir exige dizer o que foi feito e devolve o veículo para a loja');
  ok(html.indexOf('if(virouManut){ abrirManutencao(v.id); return; }') >= 0 &&
     html.indexOf('if(novo.status===\'manutencao\') abrirManutencao(novo.id);') >= 0,
     'escolher Manutenção no cadastro abre o registro na hora');

  /* --- o app offline espelha a manutenção --- */
  ok(/<button data-tab="manutencao">/.test(app) && /id="page-manutencao"/.test(app),
     'o app offline tem a aba Manutenção com página própria');
  ok(app.indexOf('function renderManutencao(') >= 0 &&
     app.indexOf('window.abrirManutencao = function(veiculoId)') >= 0 &&
     app.indexOf('window.concluirManutencao = function(veiculoId)') >= 0,
     'o app tem as mesmas telas de manutenção');
  ok(app.indexOf("if(!DB.manutencoes) DB.manutencoes = [];") >= 0 &&
     app.indexOf("if(tab==='manutencao') renderManutencao();") >= 0,
     'o app migra o banco local e abre a aba na navegação');
  ok(app.indexOf('if(virouManut){ abrirManutencao(v.id); return; }') >= 0,
     'no app o cadastro também abre o registro ao virar manutenção');

  /* --- a assinatura sai na primeira impressão --- */
  [ ['index', html], ['app', app] ].forEach(([nome, fonte])=>{
    const chamada = "imprimirQuandoPronto($('#printarea'));";
    const ajuda = fonte.indexOf('function imprimirQuandoPronto(');
    const corpoAjuda = ajuda >= 0 ? fonte.slice(ajuda, ajuda + 700) : '';
    ok(fonte.indexOf(chamada) >= 0 && /Promise\.all\(imgs\.map\(esperar\)\)/.test(corpoAjuda) &&
       corpoAjuda.indexOf('window.print()') >= 0,
       nome + ': o contrato espera a assinatura carregar antes de imprimir');
  });
}

(async () => {
  try{ testarRegrasDeDinheiro(); }
  catch(e){ reprovados++; console.log('  ✗ não consegui ler as regras do index.html: ' + e.message); }
  try{ testarSessao(); }
  catch(e){ reprovados++; console.log('  ✗ sessão: ' + e.message); }
  try{ testarSchemaEmbutido(); }
  catch(e){ reprovados++; console.log('  ✗ schema embutido: ' + e.message); }
  try{ testarModulosApi(); }
  catch(e){ reprovados++; console.log('  ✗ api: ' + e.message); }
  try{ testarPapelEDocumento(); }
  catch(e){ reprovados++; console.log('  ✗ papel/documento: ' + e.message); }
  try{ testarFechamentoESync(); }
  catch(e){ reprovados++; console.log('  ✗ fechamento/sync: ' + e.message); }
  try{ testarIdentidadeVisual(); }
  catch(e){ reprovados++; console.log('  ✗ identidade visual: ' + e.message); }
  try{ testarRelatorios(); }
  catch(e){ reprovados++; console.log('  ✗ relatórios: ' + e.message); }
  try{ await testarParidadeDaSenha(); }
  catch(e){ reprovados++; console.log('  ✗ paridade de senha: ' + e.message); }
  try{ testarVistoria(); }
  catch(e){ reprovados++; console.log('  ✗ vistoria: ' + e.message); }
  try{ testarEtiquetas(); }
  catch(e){ reprovados++; console.log('  ✗ etiquetas: ' + e.message); }
  try{ testarPagamentoPorVeiculo(); }
  catch(e){ reprovados++; console.log('  ✗ pagamento por veículo: ' + e.message); }
  try{ testarTiposDeVeiculo(); }
  catch(e){ reprovados++; console.log('  ? tipos de veículo: ' + e.message); }
  try{ testarClientes(); }
  catch(e){ reprovados++; console.log('  ? clientes: ' + e.message); }
  try{ testarOperacaoEnxuta(); }
  catch(e){ reprovados++; console.log('  ✗ operação enxuta: ' + e.message); }
  await testarBanco();

  console.log('\n  ' + aprovados + ' aprovados, ' + reprovados + ' reprovados\n');
  process.exit(reprovados ? 1 : 0);
})();
