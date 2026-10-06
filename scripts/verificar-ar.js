/* Verificação ponta a ponta no site publicado.

   Confere, contra o Postgres real, a sequência inteira de operação:
   login → estado com lock → histórico → foto → contrato assinado →
   limpeza → identidade no ar → usuário do sistema (e-mail + senha) →
   vistoria pública pelo link do celular.
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

  console.log('\n10. vistoria pública (o link do celular)');
  const gv = await j('/api/estado', { headers: cabecalho(t) });
  const docV = (gv.body && gv.body.doc) || {};
  let tokenV = (docV.config && docV.config.vistoriaToken) || '';
  if(tokenV.length < 12){
    /* primeira execução: o aparelho do balcão cria o token quando abre a
       aba; aqui criamos o mesmo jeito, e só uma vez. */
    tokenV = 'VIST' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
    const docT = Object.assign({}, docV, { config: Object.assign({}, docV.config, { vistoriaToken: tokenV }) });
    const wt = await post(t, '/api/estado', { doc: docT, versao: Number(gv.body.versao), por: 'verificacao' });
    check(wt.status === 200 && wt.body.ok === true, 'token do link da vistoria criado no documento',
          JSON.stringify(wt.body).slice(0, 120));
  }else{
    check(true, 'token do link da vistoria já existe no documento', tokenV.length + ' caracteres');
  }

  const fila = await j('/api/vistoria?token=' + encodeURIComponent(tokenV));
  check(fila.status === 200 && fila.body.ok === true && Array.isArray(fila.body.pendentes) &&
        Array.isArray(fila.body.naRua),
        'com o link certo a fila vem do servidor', JSON.stringify(fila.body).slice(0, 140));
  check(fila.status === 200 && fila.body.pendentes.every(p => p.clienteCpf === undefined) &&
        fila.body.usuarios === undefined && fila.body.contrato === undefined,
        'a fila pública não entrega CPF, usuários nem contrato');

  const tokenRuim = await j('/api/vistoria?token=LINKINVALIDO0000');
  check(tokenRuim.status === 401, 'token errado não abre a fila (401)', 'veio ' + tokenRuim.status);

  const postRuim = await post(null, '/api/vistoria', { token: 'LINKINVALIDO0000', acao: 'liberar', locacaoId: 1 });
  check(postRuim.status === 401, 'POST com token errado é recusado (401)', 'veio ' + postRuim.status);

  const acaoRuim = await post(null, '/api/vistoria', { token: tokenV, acao: 'qualquer', locacaoId: 1 });
  check(acaoRuim.status === 400, 'ação desconhecida é recusada (400)', 'veio ' + acaoRuim.status);

  const locInexistente = await post(null, '/api/vistoria',
    { token: tokenV, acao: 'liberar', locacaoId: 99999999, fotos: ['data:image/jpeg;base64,' + JPG], lacre: '1' });
  check(locInexistente.status === 404, 'locação inexistente responde 404 (nada é gravado)', 'veio ' + locInexistente.status);

  const pagV = await fetch(BASE + '/vistoria/' + tokenV);
  const txtV = pagV.status === 200 ? await pagV.text() : '';
  check(pagV.status === 200 && txtV.indexOf('Vistoriado e liberar') >= 0 && txtV.indexOf('Registrar chegada') >= 0,
        '/vistoria/{token} serve a página do celular', 'status ' + pagV.status);

  const rotaV = await fetch(BASE + '/vistoria');
  const txtR = rotaV.status === 200 ? await rotaV.text() : '';
  check(rotaV.status === 200 && txtR.indexOf('capture="environment"') >= 0,
        '/vistoria também chega na página (e ela pede a câmera)', 'status ' + rotaV.status);

  check(txtV.indexOf('/assets/logo-veeloway.jpeg') >= 0 && txtV.indexOf('src="assets/') < 0 &&
        txtV.indexOf('href="assets/') < 0,
        'a página da vistoria usa a logo em caminho absoluto (a relativa daria 404 em /vistoria/*)');

  const pagHome = await fetch(BASE + '/');
  const txtHome = pagHome.status === 200 ? await pagHome.text() : '';
  check(pagHome.status === 200 && txtHome.indexOf('data-tab="etiquetas"') >= 0 &&
        txtHome.indexOf('id="page-etiquetas"') >= 0 && txtHome.indexOf('jspdf') >= 0 &&
        txtHome.indexOf('function qrFonte(') >= 0,
        'a aba QR Codes está publicada na home, com o gerador de etiquetas e o jsPDF',
        'status ' + pagHome.status);

  check(txtHome.indexOf('data-pgmodo="unica"') >= 0 && txtHome.indexOf('data-pgmodo="porVeiculo"') >= 0 &&
        txtHome.indexOf('function pagamentosAgrupados(') >= 0 && txtHome.indexOf('id="wPgTabela"') >= 0,
        'a home publicada escolhe entre uma forma só para a locação e uma por veículo');

  check(txtHome.indexOf('+ Novo tipo (marca e modelo)') >= 0 &&
        txtHome.indexOf('function criarTipo(') >= 0 &&
        txtHome.indexOf('data-deltipo=') >= 0 &&
        txtHome.indexOf('function excluirTipo(') >= 0,
        'a home publicada cadastra tipo de veículo novo (marca/modelo) com preço próprio');

  console.log('\n11. vistoria ponta a ponta (locação de teste, depois apagada)');
  const g11 = await j('/api/estado', { headers: cabecalho(t) });
  const docA = (g11.body && g11.body.doc) || {};
  const vid11 = 999001, lid11 = 999001, gid11 = 'GTESTVIST', lacre11 = '99111';

  /* monta o documento de teste a partir de uma cópia do real: desliga as
     exigências (senão a verificação deixaria foto gravada) e acrescenta uma
     locação paga aguardando liberação, com veículo próprio */
  function docDeTeste(base){
    const agora = Date.now();
    const d = JSON.parse(JSON.stringify(base));
    const tipo = ((base.veiculos || [])[0] || {}).tipoId || null;
    d.config = Object.assign({}, d.config, { exigirFoto: false, exigirLacre: true });
    d.veiculos = (d.veiculos || []).concat([{ id: vid11, codigo: 'VIST001', status: 'loja', tipoId: tipo }]);
    d.locacoes = (d.locacoes || []).concat([{
      id: lid11, grupoId: gid11, veiculoId: vid11, veiculoCodigo: 'VIST001',
      clienteId: null, clienteNome: 'Locação de teste', clienteCpf: '',
      tipoId: tipo, tipoNome: 'Teste',
      tarifaId: null, tarifaLabel: '30 minutos', minutos: 30, duracaoMin: 30,
      inicio: null, fimPrevisto: null, fimReal: null,
      pagoEm: agora, liberadaEm: null, vistoriadaEm: null, vistoriadoPor: null,
      valorBase: 0, valorExcedente: 0, minutosExcedente: 0,
      pagamento: 'Pix', pagamentoExcedente: null,
      obsSaida: 'verificação', obsEntrada: '', obsVistoria: '',
      atendenteSaida: 'verificacao', atendenteEntrada: '',
      fotosSaida: [], fotosEntrada: [], lacreEsperado: null,
      lacreSaida: null, lacreEntrada: null, danos: [], valorDanos: 0, status: 'pendente'
    }]);
    d.grupos = (d.grupos || []).concat([{
      id: gid11, status: 'aguardando_vistoria', locacaoIds: [lid11],
      clienteNome: 'Locação de teste', valorBase: 0, pagoEm: agora
    }]);
    d.lacres = Object.assign({}, d.lacres || {});
    d.lacres[lacre11] = { n: lacre11, status: 'aplicado', veiculoId: vid11,
                          aplicadoEm: agora, aplicadoPor: 'verificacao' };
    return d;
  }

  let w11 = await post(t, '/api/estado', { doc: docDeTeste(docA), versao: Number(g11.body.versao), por: 'verificacao' });
  if(!(w11.status === 200 && w11.body.ok === true)){
    /* alguém mexeu no sistema durante a verificação: relê e tenta uma vez mais */
    const g11b = await j('/api/estado', { headers: cabecalho(t) });
    w11 = await post(t, '/api/estado',
      { doc: docDeTeste((g11b.body && g11b.body.doc) || {}), versao: Number(g11b.body.versao), por: 'verificacao' });
  }
  check(w11.status === 200 && w11.body.ok === true, 'locação de teste gravada no documento',
        JSON.stringify(w11.body).slice(0, 140));

  try{
    const filaP = await j('/api/vistoria?token=' + encodeURIComponent(tokenV));
    check(filaP.status === 200 && (filaP.body.pendentes || []).some(p => String(p.locacaoId) === String(lid11)),
          'a fila pública mostra a locação paga aguardando liberação', JSON.stringify(filaP.body).slice(0, 140));

    /* o mesmo formato que o cartão manda: texto vindo do atributo data-* */
    const semVeiculo = await post(null, '/api/vistoria',
      { token: tokenV, acao: 'liberar', locacaoId: String(lid11), fotos: [], obs: 'verificação' });
    check(semVeiculo.status === 400 && semVeiculo.body.erro === 'veiculo_nao_escaneado',
          'sem escanear a etiqueta a saída não sai (400 veiculo_nao_escaneado)',
          JSON.stringify(semVeiculo.body).slice(0, 160));

    const veiculoErrado = await post(null, '/api/vistoria',
      { token: tokenV, acao: 'liberar', locacaoId: String(lid11), veiculo: 'VIST999', fotos: [], obs: 'verificação' });
    check(veiculoErrado.status === 409 && veiculoErrado.body.erro === 'veiculo_incorreto',
          'código de outro patinete é recusado (409 veiculo_incorreto)',
          JSON.stringify(veiculoErrado.body).slice(0, 160));

    const lib11 = await post(null, '/api/vistoria',
      { token: tokenV, acao: 'liberar', locacaoId: String(lid11), veiculo: 'VIST001', fotos: [], obs: 'verificação' });
    check(lib11.status === 200 && lib11.body.ok === true &&
          (lib11.body.naRua || []).some(p => String(p.locacaoId) === String(lid11)),
          'liberar acha a locação mesmo com o id chegando como texto', JSON.stringify(lib11.body).slice(0, 160));

    const est1 = await j('/api/estado', { headers: cabecalho(t) });
    const d1 = (est1.body && est1.body.doc) || {};
    const loc1 = (d1.locacoes || []).find(l => String(l.id) === String(lid11));
    const vei1 = (d1.veiculos || []).find(v => String(v.id) === String(vid11));
    check(!!loc1 && loc1.status === 'ativa' && !!loc1.inicio && !!vei1 && vei1.status === 'rua',
          'no documento: locação ativa com a hora de saída e o veículo na rua',
          loc1 ? 'status ' + loc1.status + ' · veículo ' + (vei1 && vei1.status) : 'locação sumiu');

    check(!!loc1 && String(loc1.lacreSaida || '') === lacre11 &&
          (d1.lacres || {})[lacre11] && (d1.lacres || {})[lacre11].status === 'rompido',
          'na saída o lacre sai sozinho: o do veículo é registrado e rompido no estoque',
          loc1 ? 'lacreSaida ' + loc1.lacreSaida + ' · estoque ' + ((d1.lacres || {})[lacre11] || {}).status : 'sumiu');
    /* o cartão de saída não tem mais campo de lacre: só o scan da etiqueta. A
       comparação é contra o documento de antes da locação de teste, porque o
       documento real pode trazer divergências gravadas pelo código antigo. */
    const divAntes = (docA.divergencias || []).map(x => String(x.id));
    const nasceu = (d1.divergencias || [])
      .filter(x => x.tipo === 'lacre_trocado' || x.tipo === 'veiculo_sem_lacre')
      .filter(x => divAntes.indexOf(String(x.id)) < 0);
    const scanNaPagina = txtV.indexOf('Escanear código do patinete') >= 0;
    const campoVelho = txtV.indexOf('Lacre rompido nesta saída') >= 0;
    check(!nasceu.length && scanNaPagina && !campoVelho,
          'na saída não há campo de lacre: o cartão só escaneia a etiqueta e nenhuma divergência nasce',
          nasceu.length ? ('divergência nova: ' + JSON.stringify(nasceu[0]).slice(0, 160))
                        : (campoVelho ? 'campo de lacre antigo ainda na página'
                                      : (scanNaPagina ? '' : 'botão de escanear fora da página')));

    const chegadaSemLacre = await post(null, '/api/vistoria',
      { token: tokenV, acao: 'chegada', locacaoId: String(lid11), veiculo: 'VIST001', fotos: [], lacre: '', estado: 'loja', obs: 'verificação' });
    check(chegadaSemLacre.status === 400 && chegadaSemLacre.body.erro === 'lacre_obrigatorio',
          'na chegada o lacre novo continua sendo obrigatório (400 lacre_obrigatorio)',
          JSON.stringify(chegadaSemLacre.body).slice(0, 160));

    const che11 = await post(null, '/api/vistoria',
      { token: tokenV, acao: 'chegada', locacaoId: String(lid11), veiculo: 'VIST001', fotos: [], lacre: '124', estado: 'loja', obs: 'verificação' });
    check(che11.status === 200 && che11.body.ok === true, 'a chegada passa pelo mesmo link', JSON.stringify(che11.body).slice(0, 160));

    const est2 = await j('/api/estado', { headers: cabecalho(t) });
    const d2 = (est2.body && est2.body.doc) || {};
    const loc2 = (d2.locacoes || []).find(l => String(l.id) === String(lid11));
    const vei2 = (d2.veiculos || []).find(v => String(v.id) === String(vid11));
    check(!!loc2 && loc2.status === 'devolvida' && !!loc2.fimReal && loc2.lacreEntrada === '124' &&
          !!vei2 && vei2.status === 'loja',
          'no documento: o relógio parou na chegada, o lacre novo ficou gravado e o veículo voltou para a loja',
          loc2 ? 'status ' + loc2.status + ' · lacre ' + loc2.lacreEntrada : 'locação sumiu');

    const filaD = await j('/api/vistoria?token=' + encodeURIComponent(tokenV));
    check(filaD.status === 200 && (filaD.body.chegadas || []).some(p => String(p.locacaoId) === String(lid11)),
          'a fila pública lista a chegada de hoje', JSON.stringify(filaD.body).slice(0, 140));

    const vazio = await post(null, '/api/vistoria', { token: tokenV, acao: 'liberar', locacaoId: '   ' });
    check(vazio.status === 400, 'id de locação vazio é recusado (400)', 'veio ' + vazio.status);
  } finally {
    /* apaga só o que a verificação criou — qualquer alteração legítima feita
       no meio tempo (por quem estiver operando o balcão) fica de pé */
    const atual = await j('/api/estado', { headers: cabecalho(t) });
    const docAtual = (atual.body && atual.body.doc) || {};
    const volta = JSON.parse(JSON.stringify(docAtual));
    volta.locacoes = (volta.locacoes || []).filter(l => String(l.id) !== String(lid11));
    volta.grupos = (volta.grupos || []).filter(g => String(g.id) !== gid11);
    volta.veiculos = (volta.veiculos || []).filter(v => String(v.id) !== String(vid11));
    volta.lacres = volta.lacres || {};
    delete volta.lacres[lacre11];
    volta.config = volta.config || {};
    volta.config.exigirFoto = docA.config && docA.config.exigirFoto !== undefined ? docA.config.exigirFoto : true;
    volta.config.exigirLacre = docA.config && docA.config.exigirLacre !== undefined ? docA.config.exigirLacre : true;
    const wVolta = await post(t, '/api/estado',
      { doc: volta, versao: Number((atual.body && atual.body.versao) || 0), por: 'verificacao' });
    const depois11 = await j('/api/estado', { headers: cabecalho(t) });
    const dep = (depois11.body && depois11.body.doc) || {};
    const sobrou = (dep.locacoes || []).some(l => String(l.id) === String(lid11)) ||
                   (dep.veiculos || []).some(v => String(v.id) === String(vid11)) ||
                   !!((dep.lacres || {})[lacre11]);
    check(wVolta.status === 200 && wVolta.body.ok === true && !sobrou,
          'a locação de teste saiu do documento (o resto continua de pé)',
          JSON.stringify(wVolta.body).slice(0, 120));
  }

  console.log('\n  ' + aprovados + ' aprovados, ' + reprovados + ' reprovados\n');
  process.exit(reprovados ? 1 : 0);
})().catch(e => { console.error('\n  ✗ erro:', e && e.message ? e.message : e, '\n'); process.exit(1); });
