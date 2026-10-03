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

  /* --- o atendente não vê dinheiro nem usuários --- */
  const irPara = corpo('irPara');
  ok(irPara.indexOf("(tab==='financeiro' || tab==='relatorios' || tab==='usuarios') && !ehAdministrador()") >= 0,
     'irPara bloqueia financeiro, relatórios e usuários para quem não é administrador');
  const perm = corpo('aplicarPermissoes');
  ok(perm.indexOf("soAdmin('financeiro')") >= 0 && perm.indexOf("soAdmin('relatorios')") >= 0 &&
     perm.indexOf("soAdmin('usuarios')") >= 0,
     'aplicarPermissoes esconde as três abas do administrador');
  ok(perm.indexOf("irPara('painel')") >= 0,
     'quem está numa aba proibida volta para o painel');
  ok(/<button data-tab="usuarios">/.test(html) && /id="page-usuarios"/.test(html),
     'a aba Usuários existe com a página própria');
  ok(/<button data-tab="relatorios">/.test(html) && /id="page-relatorios"/.test(html),
     'a aba Relatórios existe com a página própria');

  ok((html.match(/id="cardUsuarios"/g) || []).length === 1 &&
     /<section class="page" id="page-usuarios"[\s\S]{0,1200}id="cardUsuarios"/.test(html),
     'o card de usuários mora na aba dele');
  ok(/<section class="page" id="page-usuarios"[\s\S]{0,1600}id="btnNovoUsuario"/.test(html),
     'a aba de usuários tem o botão de cadastrar');
  ok(irPara.indexOf("if(tab==='usuarios') renderUsuarios()") >= 0 &&
     irPara.indexOf("if(tab==='relatorios') renderRelatorios()") >= 0,
     'entrar numa aba redesenha a página dela');
  ok(corpo('renderFinanceiro').indexOf('if(!ehAdministrador()) return;') >= 0,
     'renderFinanceiro tem trava própria para o atendente');
  ok(corpo('renderRelatorios').indexOf('if(!ehAdministrador()) return;') >= 0,
     'renderRelatorios tem trava própria para o atendente');
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
  ['renderCaixa','renderFrota','renderClientes','renderHistorico','renderFinanceiro','renderRelatorios','renderUsuarios','renderConfig']
    .forEach(fn=> ok(repintar.indexOf(fn) >= 0, 'repintarTela atualiza a aba de ' + fn));
}

/* ------------------------------------------------------------------ H */
function testarIdentidadeVisual(){
  console.log('\nH. Identidade visual — VeeLo Way (amarelo e preto)');
  const raiz = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(raiz, 'index.html'), 'utf8');
  const assinar = fs.readFileSync(path.join(raiz, 'assinar.html'), 'utf8');
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
  ok(/<img src="assets\/logo-veeloway\.jpeg"[^>]*><span id="empresa">/.test(assinar),
     'a tela de assinatura do cliente também leva o logo');
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
/* A aba Relatórios responde o mês: quantas viagens, quanto faturou,
   quem mais viajou, qual foi o melhor dia e quais horas são cheias. */
function testarRelatorios(){
  console.log('\nI. Relatórios — o mês numa tela só');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const corpo = f => extrairFuncao(html, f);

  ok(/<button data-tab="relatorios">Relatórios<\/button>/.test(html),
     'a navegação tem a aba Relatórios');
  ok(/<section class="page" id="page-relatorios">/.test(html),
     'a aba tem a página própria');
  ok(/id="rMes"/.test(html) && /id="kpisRel"/.test(html) && /id="tbRelClientes"/.test(html) &&
     /id="tbRelDias"/.test(html) && /id="tbRelHoras"/.test(html) && /id="tbRelResumo"/.test(html),
     'a página tem o seletor de mês, os KPIs e as quatro tabelas');
  ok(html.indexOf("relatorios:'renderRelatorios'") >= 0 &&
     /if\(tab==='relatorios'\) renderRelatorios\(\)/.test(html),
     'a aba é redesenhada ao entrar e quando os dados mudam');
  ok(/<input[^>]*id="rMes"[^>]*type="month"|type="month"[^>]*id="rMes"/.test(html),
     'o mês é escolhido num seletor de calendário');

  /* --- o fechamento do mês, com um mês de exemplo --- */
  const ctx = vm.createContext({ console });
  vm.runInContext([
    extrairFuncao(html, 'diaKey'),
    extrairFuncao(html, 'mesKey'),
    extrairFuncao(html, 'estornada'),
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
  await testarBanco();

  console.log('\n  ' + aprovados + ' aprovados, ' + reprovados + ' reprovados\n');
  process.exit(reprovados ? 1 : 0);
})();
