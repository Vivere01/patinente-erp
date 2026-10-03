/* Verificação ponta a ponta no site publicado.

   Confere, contra o Postgres real, a sequência inteira de operação:
   login → estado com lock → histórico → foto → contrato assinado →
   limpeza → identidade no ar → usuário do sistema (e-mail + senha).
   Usa as rotas da API como usa o navegador, e confere o HTML
   publicado no fim.

   Uso:
     npm run verificar                      # site e credenciais do .env.local
     node scripts/verificar-ar.js URL EMAIL SENHA

   Cria 1 evento de auditoria e apaga os artefatos de teste ao final.
   ===================================================================== */
require('./env')();

const BASE = (process.argv[2] || process.env.SITE_URL || 'https://patinente-erp.vercel.app').replace(/\/$/, '');
const EMAIL = process.argv[3] || process.env.LOJA_EMAIL;
const SENHA = process.argv[4] || process.env.LOJA_SENHA;

if(!EMAIL || !SENHA){
  console.error('\n  ✗ Defina LOJA_EMAIL e LOJA_SENHA (vercel env pull .env.local)');
  console.error('    ou passe:  node scripts/verificar-ar.js URL EMAIL SENHA\n');
  process.exit(1);
}

let aprovados = 0, reprovados = 0;
function check(cond, nome, detalhe){
  if(cond){ aprovados++; console.log('  ✓ ' + nome); }
  else { reprovados++; console.log('  ✗ ' + nome + (detalhe ? '  → ' + detalhe : '')); }
}
async function j(url, opt){
  const res = await fetch(BASE + url, opt);
  let body = null;
  try{ body = await res.json(); }catch(e){}
  return { status: res.status, body };
}
const cabecalho = (tok) => (tok ? { Authorization: 'Bearer ' + tok, 'content-type': 'application/json' } : { 'content-type': 'application/json' });
const post = (tok, url, b) => j(url, { method: 'POST', headers: cabecalho(tok), body: JSON.stringify(b) });

const CONTRATO = 'CONTRATO DE LOCAÇÃO DE VEÍCULO ELÉTRICO — texto de teste longo o bastante para ser aceito pelo sistema de assinatura eletrônica.';
const JPG = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==';

(async () => {
  console.log('\n1. sessão (' + BASE + ')');
  const lg = await post(null, '/api/login', { email: EMAIL, senha: SENHA });
  check(lg.status === 200 && !!lg.body.token, 'login da loja abre sessão', JSON.stringify(lg.body));
  if(!lg.body || !lg.body.token){ console.log('\n  0 aprovados, 1 reprovado\n'); process.exit(1); }
  const t = lg.body.token;

  const ruim = await post(null, '/api/login', { email: EMAIL, senha: SENHA + 'x' });
  check(ruim.status === 401, 'senha errada é recusada (401)', 'veio ' + ruim.status);

  /* limpa sobras de uma execução anterior para as contagens serem
     determinísticas — e nunca mexe no documento real */
  await post(t, '/api/admin/banco', { acao: 'limpar' });

  console.log('\n2. estado com lock otimista');
  const g0 = await j('/api/estado', { headers: cabecalho(t) });
  const v0 = Number(g0.body && g0.body.versao);
  const original = (g0.body && g0.body.doc) || {};
  check(g0.status === 200 && typeof original === 'object',
        'GET /api/estado carrega a versão atual (v' + v0 + ', ' + Object.keys(original).length + ' chaves)',
        JSON.stringify(g0.body).slice(0, 120));
  if(!(g0.status === 200)){ console.log('\n  parando: não consegui ler o estado\n'); process.exit(1); }

  /* grava o MESMO documento de volta: testa o lock sem tocar no conteúdo */
  const w1 = await post(t, '/api/estado', { doc: original, versao: v0, por: 'verificacao' });
  check(w1.status === 200 && w1.body.ok === true && Number(w1.body.versao) === v0 + 1,
        'gravando com a versão atual é aceito (v' + v0 + '→v' + (v0 + 1) + ')', JSON.stringify(w1.body));

  const w2 = await post(t, '/api/estado', { doc: { __perdido: true }, versao: v0, por: 'verificacao' });
  check(w2.status === 409 && w2.body.ok === false, 'versão defasada é recusada (409)', 'veio ' + w2.status);

  const g1 = await j('/api/estado', { headers: cabecalho(t) });
  check(g1.status === 200 && Number(g1.body.versao) === v0 + 1 &&
        JSON.stringify(g1.body.doc) === JSON.stringify(original),
        'nada foi sobrescrito: o documento continua igual', JSON.stringify(g1.body).slice(0, 120));

  console.log('\n3. histórico imutável');
  const ev = await post(t, '/api/eventos', { usuario: 'verificacao', acao: 'verificacao', detalhe: 'rotina npm run verificar-ar' });
  check(ev.status === 200 && ev.body.ok === true, 'POST /api/eventos registra a ação', JSON.stringify(ev.body));

  console.log('\n4. fotos de vistoria');
  const fp = await post(t, '/api/fotos', { caminho: 'instalacao/teste.jpg', dataUrl: 'data:image/jpeg;base64,' + JPG });
  check(fp.status === 200 && fp.body.ok === true && !!fp.body.url, 'grava e devolve link assinado', JSON.stringify(fp.body).slice(0, 160));
  if(fp.body && fp.body.url){
    const img = await fetch(BASE + fp.body.url);
    const buf = Buffer.from(await img.arrayBuffer());
    check(img.status === 200 && img.headers.get('content-type') === 'image/jpeg' &&
          buf.length === Buffer.from(JPG, 'base64').length,
          'a URL assinada devolve a imagem (' + buf.length + ' bytes)', 'status ' + img.status);
    const semSig = await fetch(BASE + '/api/fotos?caminho=instalacao/teste.jpg');
    check(semSig.status === 401 || semSig.status === 403, 'sem sessão nem assinatura não há como ler a foto', 'veio ' + semSig.status);
  }

  console.log('\n5. contrato e assinatura eletrônica');
  const ap = await post(t, '/api/assinaturas', { token: 'TESTE001', contrato: CONTRATO, cliente: { nome: 'Cliente de teste', cpf: '00000000000' }, resumo: { total: 60 }, validadeHoras: 6 });
  check(ap.status === 200 && ap.body.link === '/assinar/TESTE001' && ap.body.status === 'pendente',
        'balcão publica o link para o cliente', JSON.stringify(ap.body).slice(0, 160));

  const cl = await j('/api/assinaturas/TESTE001');
  check(cl.status === 200 && cl.body.contrato === CONTRATO && cl.body.assinada === false,
        'cliente lê exatamente o texto congelado', 'status ' + cl.status);

  const ass = await j('/api/assinaturas/TESTE001', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ assinatura: 'data:image/png;base64,AAAA', aceite: true, canal: 'celular' })
  });
  check(ass.status === 200 && ass.body.assinada === true, 'assinatura eletrônica gravada', JSON.stringify(ass.body).slice(0, 160));

  const dep = await j('/api/assinaturas/TESTE001');
  check(dep.status === 200 && dep.body.assinada === true && dep.body.assinatura === 'data:image/png;base64,AAAA',
        'assinatura permanece na releitura', '');

  const pag = await fetch(BASE + '/assinar/TESTE001');
  check(pag.status === 200 && /assinatura/i.test(await pag.text()), '/assinar/TESTE001 serve a tela do cliente', 'status ' + pag.status);

  console.log('\n6. limpeza dos artefatos');
  const lim = await post(t, '/api/admin/banco', { acao: 'limpar' });
  check(lim.status === 200 && lim.body.fotos === 1 && lim.body.assinaturas === 1,
        'remove 1 foto e 1 assinatura de teste', JSON.stringify(lim.body));

  const fora = await j('/api/assinaturas/TESTE001');
  check(fora.status === 404, 'link de teste removido (404)', 'veio ' + fora.status);
  if(fp.body && fp.body.url){
    const gone = await fetch(BASE + fp.body.url);
    check(gone.status === 404, 'foto de teste removida (404)', 'veio ' + gone.status);
  }

  console.log('\n7. situação final');
  const fin = await j('/api/estado', { headers: cabecalho(t) });
  check(fin.status === 200 && Number(fin.body.versao) >= v0 + 1 &&
        JSON.stringify(fin.body.doc) === JSON.stringify(original),
        'estado íntegro e idêntico ao de antes (v' + fin.body.versao + ')',
        JSON.stringify(fin.body).slice(0, 120));
  const st = await j('/api/status');
  check(st.status === 200 && st.body.banco === true && st.body.login === true, 'status: banco e login prontos', JSON.stringify(st.body));
  const sg = await j('/api/sessao', { headers: cabecalho(t) });
  check(sg.status === 200 && sg.body.ok === true, 'sessão segue válida para o balcão', JSON.stringify(sg.body));

  console.log('\n8. identidade no ar');
  const pagTopo = await fetch(BASE + '/');
  const txt = pagTopo.status === 200 ? await pagTopo.text() : '';
  check(pagTopo.status === 200 && txt.indexOf('assets/logo-veeloway.jpeg') >= 0 && txt.indexOf('--brand:#ffe500') >= 0,
        'a página publicada traz o logo e o amarelo da marca', 'status ' + pagTopo.status);
  const img = await fetch(BASE + '/assets/logo-veeloway.jpeg', { method: 'HEAD' });
  check(img.status === 200 && String(img.headers.get('content-type') || '').indexOf('image/jpeg') >= 0,
        'o logo responde como imagem (200)', 'veio ' + img.status + ' ' + img.headers.get('content-type'));
  check(txt.indexOf('id="loEmail"') >= 0 && txt.indexOf('id="loSenha"') >= 0,
        'no ar: o acesso pede e-mail e senha (sem PIN de 4 dígitos)',
        txt.indexOf('id="loEmail"') < 0 ? 'id="loEmail" ausente' : 'id="loSenha" ausente');
  check(txt.indexOf('data-tab="relatorios"') >= 0 && txt.indexOf('id="page-relatorios"') >= 0,
        'no ar: a aba Relatórios existe para o administrador',
        txt.indexOf('data-tab="relatorios"') < 0 ? 'aba ausente' : 'página ausente');

  console.log('\n9. usuário do sistema (e-mail + senha, sem PIN)');
  const auth = require('../lib/auth');
  const g9 = await j('/api/estado', { headers: cabecalho(t) });
  const doc9 = (g9.body && g9.body.doc) || {};
  const versao9 = Number(g9.body && g9.body.versao);
  const usuarios = Array.isArray(doc9.usuarios) ? doc9.usuarios.slice() : [];
  const senha9 = 'SenhaDeTeste123';
  const salt9 = auth.novoSalt();
  const novo = {
    id: usuarios.reduce((m, u) => Math.max(m, Number(u.id) || 0), 0) + 1,
    nome: 'Verificação AR',
    email: 'verificacao@veeloway.test',
    papel: 'atendente',
    ativo: true,
    salt: salt9,
    hash: auth.hashSenha(senha9, salt9)
  };
  const docNovo = Object.assign({}, doc9, { usuarios: usuarios.concat([novo]) });
  const w9 = await post(t, '/api/estado', { doc: docNovo, versao: versao9, por: 'verificacao' });
  check(w9.status === 200 && w9.body.ok === true, 'usuário de teste gravado no documento',
        JSON.stringify(w9.body));

  const dentro = await post(null, '/api/login', { email: novo.email, senha: senha9 });
  check(dentro.status === 200 && dentro.body.usuario && dentro.body.usuario.papel === 'atendente',
        'usuário do sistema entra pelo e-mail e pela senha (papel Atendente)',
        JSON.stringify(dentro.body));

  const errada = await post(null, '/api/login', { email: novo.email, senha: senha9 + 'x' });
  check(errada.status === 401, 'senha errada recusa o usuário (401)', 'veio ' + errada.status);

  const bloqueado = usuarios.concat([Object.assign({}, novo, { ativo: false })]);
  const docBloq = Object.assign({}, docNovo, { usuarios: bloqueado });
  const wB = await post(t, '/api/estado', { doc: docBloq, versao: Number(w9.body.versao), por: 'verificacao' });
  const semEntrar = await post(null, '/api/login', { email: novo.email, senha: senha9 });
  check(wB.status === 200 && semEntrar.status === 401, 'conta bloqueada não entra (401)',
        'gravou ' + wB.status + ', login ' + semEntrar.status);

  const voltar = await post(t, '/api/estado', { doc: original, versao: Number(wB.body.versao), por: 'verificacao' });
  const depois = await j('/api/estado', { headers: cabecalho(t) });
  check(voltar.status === 200 && JSON.stringify(depois.body.doc) === JSON.stringify(original),
        'documento restaurado, idêntico ao de antes (v' + (depois.body && depois.body.versao) + ')',
        JSON.stringify(depois.body).slice(0, 120));

  console.log('\n  ' + aprovados + ' aprovados, ' + reprovados + ' reprovados\n');
  process.exit(reprovados ? 1 : 0);
})().catch(e => { console.error('\n  ✗ erro:', e && e.message ? e.message : e, '\n'); process.exit(1); });
