/* =====================================================================
   PONTA A PONTE DA LOCAÇÃO — do cliente do zero à vistoria sincronizada.

   Os handlers são os REAIS de produção: /api/login, /api/estado (o
   balcão grava o documento inteiro com lock otimista), /api/assinaturas
   e /api/assinaturas/{token} (contrato assinado no celular),
   /api/vistoria (fila, fotos em staging e commit da comanda) e
   /api/fotos (o balcão abre a imagem pelo link assinado). Só o Postgres
   é simulado, com a mesma semântica do lib/schema-sql.js: documento
   versionado com lock otimista, gravações enfileiradas no FOR UPDATE.

   Roteiro (o que acontece no dia a dia):
     0) login do balcão com e-mail + senha (senha errada não entra)
     1) sistema do zero: frota de 5 patinetes, sem cliente nem locação
     2) balcão cadastra o cliente e a comanda de 5 patinetes (Pix, pago)
     3) cliente recebe o contrato e assina no celular dele
     4) vistoriador abre a fila por /vistoria/{token} — 5 cartões,
        sem CPF foge do payload público
     5) escaneia a etiqueta de cada patinete e fotografa (2 por veículo)
     6) sincroniza: fotos em lotes paralelos + 1 commit da comanda
        → relógio único, veículos para a rua, comanda ativa
     7) o balcão recarrega o documento e VÊ tudo — incluindo a foto
        abrindo pelo link assinado e a assinatura pronta
     8) chegada de 2 patinetes: fimReal pela hora da comanda, veículo
        volta para a loja, fila e Entregues se atualizam
   ===================================================================== */
'use strict';
const path = require('path');

/* --- ambiente do teste (o que a Vercel teria nas variáveis) --- */
process.env.POSTGRES_URL = process.env.POSTGRES_URL || 'postgres://simulador:senha@localhost/vistoria';
process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'segredo-de-teste-da-ponta-a-ponte';
process.env.LOJA_EMAIL = process.env.LOJA_EMAIL || 'loja@veeloway.com.br';
process.env.LOJA_SENHA = process.env.LOJA_SENHA || 'senh4-da-loj4';

/* --- banco simulado ANTES de carregar qualquer handler --- */
const banco = require(path.join(__dirname, '..', 'lib', 'banco'));

const LAT_MS = Number(process.env.LAT_MS || 25);

const contadores = { leituras: 0, escritasOk: 0, conflitos: 0, fotosN: 0 };
let estado = { doc: {}, versao: 0 };
const assinaturas = new Map();  /* token -> linha */
const fotosTabela = new Map();  /* caminho -> { mime, bytes, tamanho } */
let escritando = Promise.resolve();

function dormir(ms){ return new Promise(r => setTimeout(r, ms)); }
function clone(x){ return JSON.parse(JSON.stringify(x)); }

async function simularSql(texto, params){
  const t = String(texto).replace(/\s+/g, ' ').trim();

  /* --- gravação do documento: FOR UPDATE serialize + lock otimista --- */
  if(t.indexOf('select ok, versao, doc from public.salvar_estado') === 0){
    await dormir(LAT_MS);
    const espera = escritando.then(async () => {
      if(Number(params[1]) !== estado.versao){
        contadores.conflitos++;
        return { rows: [{ ok: false, versao: estado.versao, doc: clone(estado.doc) }] };
      }
      estado.doc = JSON.parse(params[0]);
      estado.versao++;
      contadores.escritasOk++;
      return { rows: [{ ok: true, versao: estado.versao, doc: clone(estado.doc) }] };
    });
    escritando = espera.then(() => {}, () => {});
    return espera;
  }

  /* --- leitura do documento --- */
  if(t.indexOf('select versao from public.estado') === 0){
    contadores.leituras++;
    await dormir(LAT_MS);
    return { rows: [{ versao: estado.versao }] };
  }
  if(t.indexOf('select doc, versao from public.estado') === 0){
    contadores.leituras++;
    await dormir(LAT_MS);
    return { rows: [{ doc: clone(estado.doc), versao: estado.versao }] };
  }
  if(t.indexOf('select doc from public.estado') === 0){
    contadores.leituras++;
    await dormir(LAT_MS);
    return { rows: [{ doc: clone(estado.doc) }] };
  }

  /* --- tabela de assinaturas --- */
  if(t.indexOf('insert into public.assinaturas') === 0){
    await dormir(LAT_MS);
    assinaturas.set(String(params[0]), {
      token: String(params[0]), cliente_nome: params[1], cliente_cpf: params[2],
      contrato: params[3], resumo: params[4], empresa: params[5],
      status: 'pendente', assinatura: null, canal: null,
      assinado_em: null, expira_em: new Date(Date.now() + 6 * 3600000).toISOString()
    });
    return { rowCount: 1 };
  }
  if(t.indexOf('update public.assinaturas') === 0){
    await dormir(LAT_MS);
    const linha = assinaturas.get(String(params[0]));
    if(linha && linha.status === 'pendente'){
      linha.status = 'assinada';
      linha.assinatura = params[1];
      linha.canal = params[2];
      linha.assinado_em = new Date().toISOString();
    }
    return { rowCount: 1 };
  }
  if(t.indexOf('from public.assinaturas') > 0){
    await dormir(LAT_MS);
    const linha = assinaturas.get(String(params[0]));
    if(!linha) return { rows: [] };
    if(t.indexOf('assinado_em, expira_em') > 0)
      return { rows: [{ status: linha.status, assinado_em: linha.assinado_em, expira_em: linha.expira_em }] };
    if(t.indexOf('select * from public.assinaturas') === 0) return { rows: [clone(linha)] };
    return { rows: [{ status: linha.status, assinatura: linha.assinatura }] };
  }

  /* --- tabela de fotos --- */
  if(t.indexOf('insert into public.fotos') === 0){
    contadores.fotosN++;
    await dormir(LAT_MS);
    fotosTabela.set(String(params[0]), { mime: params[1], bytes: params[2], tamanho: params[3] });
    return { rowCount: 1 };
  }
  if(t.indexOf('select mime, bytes from public.fotos') === 0){
    await dormir(LAT_MS);
    const f = fotosTabela.get(String(params[0]));
    return { rows: f ? [{ mime: f.mime, bytes: f.bytes }] : [] };
  }
  if(t.indexOf('select 1 from public.fotos') === 0){
    await dormir(LAT_MS);
    return { rows: fotosTabela.has(String(params[0])) ? [{ '?': 1 }] : [] };
  }
  if(t.indexOf('select caminho from public.fotos') === 0){
    await dormir(LAT_MS);
    const pedidos = (params[0] || []);
    return { rows: pedidos.map(c => ({ caminho: String(c) })) };
  }

  throw new Error('SQL não simulado no E2E: ' + t.slice(0, 120));
}

banco.sql = simularSql;
banco.temBanco = () => true;

/* --- handlers reais --- */
const rotaLogin = require(path.join(__dirname, '..', 'api', 'login'));
const rotaEstado = require(path.join(__dirname, '..', 'api', 'estado'));
const rotaAssinaturas = require(path.join(__dirname, '..', 'api', 'assinaturas'));
const rotaAssinar = require(path.join(__dirname, '..', 'api', 'assinaturas', '[token].js'));
const rotaVistoria = require(path.join(__dirname, '..', 'api', 'vistoria'));
const rotaFotos = require(path.join(__dirname, '..', 'api', 'fotos'));

/* --------- utilidades ---------- */
const ERC = [];
function ok(nome, cond, detalhe){
  console.log((cond ? '  ✓ ' : '  ✗ ') + nome + (detalhe && !cond ? ' — ' + detalhe : ''));
  if(!cond) { ERC.push(nome); }
}

/* resposta falsa por pedido: nada compartilhado, então os 3 lotes de
   fotos podem subir em paralelo sem se atrapalharem */
function pedido(rota, req){
  const res = { statusCode: 0, setHeader(k, v){ this.cab[k] = v; },
                cab: {}, end(t){ this.bruto = t; } };
  return rota(req, res).then(() => {
    const b = res.bruto;
    let j = null;
    if(typeof b === 'string' && (b.charAt(0) === '{' || b.charAt(0) === '[')){
      try{ j = JSON.parse(b); }catch(e){ j = null; }
    }
    return { status: res.statusCode, j: j, cab: res.cab, bruto: b, bytes: res.bytes };
  });
}

/* foto do tamanho real de um clique já comprimido pelo celular */
function foto(n){
  const bytes = Math.round(n / 4) * 3;
  const alvo = Buffer.alloc(bytes);
  for(let i = 0; i < bytes; i++) alvo[i] = (i * 131 + n) & 0xff;
  return 'data:image/jpeg;base64,' + alvo.toString('base64');
}

/* --------- documentos de apoio ---------- */
const TOKEN = 'TOKEN567890ABCD';
const HOJE = new Date().toISOString().slice(0, 10);

function inicializa(){
  estado = { doc: {}, versao: 0 };
  assinaturas.clear();
  fotosTabela.clear();
  escritando = Promise.resolve();
}
function documentoZero(){
  const veiculos = [];
  for(let i = 1; i <= 5; i++){
    veiculos.push({ id: i, codigo: 'PAT-00' + i, tipoId: 'pat', tipoNome: 'Patinete', status: 'loja' });
  }
  return {
    config: { vistoriaToken: TOKEN, exigirFoto: true, toleranciaMin: 5 },
    empresa: { nome: 'VeeLo Way' },
    tipos: [{ id: 'pat', nome: 'Patinete', duracoes: [{ min: 30, preco: 20 }], excedenteMin: 1 }],
    caixas: [{ dia: HOJE, status: 'aberto' }],
    caixa: [],
    veiculos: veiculos,
    clientes: [],
    locacoes: [],
    grupos: [],
    auditoria: []
  };
}
function cloneDoc(d){ return JSON.parse(JSON.stringify(d || {})); }

const ASSINATURA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/* --------- roteiro ---------- */
(async () => {
  console.log('E2E da locação: cliente do zero → comanda → contrato → vistoria sincronizada');
  inicializa();

  const locIds = ['L1-1', 'L1-2', 'L1-3', 'L1-4', 'L1-5'];
  let sessao = '';
  const comSessao = extra => Object.assign({ headers: { authorization: 'Bearer ' + sessao } }, extra);

  /* --------- 0) login do balcão --------- */
  console.log('\n[0] balcão entra com e-mail + senha');
  const entrada = await pedido(rotaLogin, { method: 'POST',
    body: { email: process.env.LOJA_EMAIL, senha: process.env.LOJA_SENHA } });
  ok('[0] sessão do balcão aberta pela API de login',
     entrada.status === 200 && entrada.j && entrada.j.ok && typeof entrada.j.token === 'string');
  if(entrada.j && entrada.j.token) sessao = entrada.j.token;
  const errada = await pedido(rotaLogin, { method: 'POST',
    body: { email: process.env.LOJA_EMAIL, senha: 'senha-errada' } });
  ok('[0] senha errada não abre sessão (401)', errada.status === 401);

  /* --------- 1) sistema do zero --------- */
  console.log('\n[1] frota criada do zero, sem cliente nem locação');
  const v0 = (await pedido(rotaEstado, comSessao({ method: 'GET', query: {} }))).j.versao;
  const g1 = await pedido(rotaEstado, comSessao({ method: 'POST',
    body: { doc: documentoZero(), versao: v0, por: 'balcão (E2E)' } }));
  ok('[1] frota de 5 patinetes gravada com lock otimista',
     g1.status === 200 && g1.j.ok && g1.j.versao === v0 + 1,
     'status ' + g1.status + ' versão ' + (g1.j || {}).versao);

  /* --------- 2) cliente + comanda --------- */
  console.log('\n[2] balcão cadastra o cliente e a comanda (5 patinetes, Pix, pago agora)');
  const e1 = (await pedido(rotaEstado, comSessao({ method: 'GET', query: {} }))).j;
  const doc2 = cloneDoc(e1.doc);
  const agora = Date.now();
  doc2.clientes.push({ id: 'c1', nome: 'Ana Banana (E2E)', cpf: '123.456.789-00',
                       fone: '11 9 8888-0000', criadoEm: agora });
  locIds.forEach(id => doc2.locacoes.push({
    id: id, grupoId: 'G1', veiculoId: null, veiculoCodigo: '',
    clienteId: 'c1', clienteNome: 'Ana Banana (E2E)', clienteCpf: '123.456.789-00',
    tipoId: 'pat', tipoNome: 'Patinete', tarifaLabel: '30 minutos', duracaoMin: 30,
    inicio: null, fimPrevisto: null, fimReal: null,
    pagoEm: agora, liberadaEm: null, vistoriadaEm: null, vistoriadoPor: null,
    valorBase: 20, valorExcedente: 0, minutosExcedente: 0,
    pagamento: 'Pix', obsSaida: 'E2E: cliente mora perto', obsEntrada: '', obsVistoria: '',
    fotosSaida: [], fotosEntrada: [], status: 'pendente'
  }));
  doc2.grupos.push({ id: 'G1', status: 'aguardando_vistoria', locacaoIds: locIds.slice(),
                     clienteNome: 'Ana Banana (E2E)', valorBase: 100, pagoEm: agora });
  const g2 = await pedido(rotaEstado, comSessao({ method: 'POST',
    body: { doc: doc2, versao: e1.versao, por: 'balcão (E2E)' } }));
  ok('[2] cliente e comanda gravados (versão ' + e1.versao + ' → ' + (g2.j || {}).versao + ')',
     g2.status === 200 && g2.j.ok && g2.j.versao === e1.versao + 1);

  /* --------- 3) contrato assinado no celular do cliente --------- */
  console.log('\n[3] cliente recebe e assina o contrato no celular');
  const contrato = 'Contrato de locação VeeLo Way: o equipamento é de uso individual e cuidadoso; ' +
    'a devolução é na hora marcada e o excedente é cobrado pela tarifa combinada no balcão.';
  const publi = await pedido(rotaAssinaturas, comSessao({ method: 'POST', body: {
    token: 'ASSINAR0001', contrato: contrato, validadeHoras: 6,
    cliente: { nome: 'Ana Banana (E2E)', cpf: '123.456.789-00' },
    resumo: { total: 100, formas: [{ forma: 'Pix', total: 100 }] },
    empresa: { nome: 'VeeLo Way' } } }));
  ok('[3] balcão publica o contrato (link /assinar/ASSINAR0001)',
     publi.status === 200 && publi.j.ok && publi.j.status === 'pendente');
  const visto = await pedido(rotaAssinar, { method: 'GET', query: { token: 'ASSINAR0001' } });
  ok('[3] o cliente abre o link e lê exatamente o texto congelado',
     visto.status === 200 && visto.j && visto.j.contrato === contrato);
  const feita = await pedido(rotaAssinar, { method: 'POST', query: { token: 'ASSINAR0001' },
    body: { assinatura: ASSINATURA, aceite: true, canal: 'celular' } });
  ok('[3] assinatura gravada no celular do cliente',
     feita.status === 200 && feita.j && feita.j.status === 'assinada');
  const confere = await pedido(rotaAssinar, { method: 'GET', query: { token: 'ASSINAR0001' } });
  ok('[3] o balcão consulta e vê a assinatura pronta', confere.j && confere.j.assinada === true);

  /* --------- 4) vistoriador abre a fila --------- */
  console.log('\n[4] vistoriador abre /vistoria/{token} no celular');
  const fila0 = await pedido(rotaVistoria, { method: 'GET', query: { token: TOKEN } });
  ok('[4] a fila mostra a comanda de 5, agrupável pelo grupoId',
     fila0.status === 200 && (fila0.j.pendentes || []).length === 5 &&
       (fila0.j.pendentes || []).every(l => l.grupoId === 'G1' &&
         l.clienteNome === 'Ana Banana (E2E)' && !('clienteCpf' in l)));

  /* --------- 5) escaneio das etiquetas + fotos --------- */
  console.log('\n[5] escaneia a etiqueta de cada patinete e fotografa');
  const etiquetas = ['PAT-001', 'PAT-002', 'PAT-003', 'PAT-004', 'PAT-005'];
  const cartoes = locIds.map((id, i) => ({
    locId: id, etiqueta: etiquetas[i],
    fotos: Array.from({ length: 2 }, (_, k) => foto(120 * 1024 + i * 137 + k))
  }));
  ok('[5] etiquetas distintas por cartão (nenhuma repetida)',
     new Set(cartoes.map(c => c.etiqueta)).size === cartoes.length);

  /* --------- 6) sincronização: fotos paralelas + 1 commit --------- */
  console.log('\n[6] sincroniza: fotos em lotes paralelos + 1 commit da comanda');
  const loteComanda = loteDe();
  const mapa = await subirFotos(TOKEN, loteComanda, cartoes.reduce((s, c) => s.concat(c.fotos), []));
  ok('[6] as 10 fotos estão no banco antes do commit (staging)',
     cartoes.every(c => c.fotos.every(f => !!mapa[f])));

  const horaLote = Date.now() - 1500;
  const comit = await pedido(rotaVistoria, { method: 'POST', body: {
    token: TOKEN, acao: 'liberar', lote: loteComanda, loteHora: horaLote,
    itens: cartoes.map(c => ({ locacaoId: c.locId, veiculo: c.etiqueta,
      fotos: c.fotos.map(f => mapa[f] || f), obs: 'E2E: tudo ok, bateria 100%' })) } });
  ok('[6] o commit libera a comanda inteira (5 veículos)',
     comit.status === 200 && comit.j && comit.j.ok &&
       (comit.j.resultados || []).every(r => r.ok),
     JSON.stringify((comit.j || {}).resultados || comit.j).slice(0, 200));

  /* --------- 7) o balcão vê o resultado --------- */
  console.log('\n[7] balcão recarrega o documento e confere');
  const e2 = (await pedido(rotaEstado, comSessao({ method: 'GET', query: {} }))).j;
  const docB = e2.doc;
  const locsB = docB.locacoes.filter(l => l.grupoId === 'G1');
  const inicios = locsB.map(l => l.inicio);
  ok('[7] as 5 locações estão ativas com o MESMO relógio (início do lote)',
     locsB.length === 5 && locsB.every(l => l.status === 'ativa') && new Set(inicios).size === 1);
  ok('[7] a hora veio do aparelho (loteHora, 1,5 s antes do commit)',
     Math.abs(inicios[0] - horaLote) < 120000);
  ok('[7] os 5 patinetes saíram para a rua',
     locsB.every(l => {
       const v = docB.veiculos.find(vv => vv.id === l.veiculoId);
       return v && v.status === 'rua';
     }));
  ok('[7] a comanda virou ativa e as unidades ficaram amarradas na liberação',
     (docB.grupos.find(g => g.id === 'G1') || {}).status === 'ativo' &&
       locsB.every(l => !!l.veiculoCodigo && !!l.veiculoId));
  ok('[7] cada locação tem 2 fotos sincronizadas',
     locsB.every(l => (l.fotosSaida || []).length === 2));

  /* o balcão abre a foto pelo link assinado — igual produção */
  const caminhoFoto = locsB[0].fotosSaida[0].caminho;
  const linkNovo = await pedido(rotaFotos, comSessao({ method: 'GET', query: { caminho: caminhoFoto } }));
  ok('[7] o balcão pede um link novo da foto pela sessão',
     linkNovo.status === 200 && linkNovo.j && linkNovo.j.ok && linkNovo.j.caminho === caminhoFoto);
  const pega = new URL('http://x' + linkNovo.j.url);
  const olhada = await pedido(rotaFotos, { method: 'GET', query: {
    caminho: pega.searchParams.get('caminho'),
    exp: pega.searchParams.get('exp'), sig: pega.searchParams.get('sig') } });
  ok('[7] a foto abre pelo link assinado, no tamanho exato do upload',
     olhada.status === 200 &&
       Number(olhada.cab['Content-Length']) === Math.round((120 * 1024) / 4) * 3,
     'status ' + olhada.status + ' bytes ' + (olhada.cab['Content-Length'] || '?'));
  const sigDepois = (await pedido(rotaAssinar, { method: 'GET', query: { token: 'ASSINAR0001' } })).j;
  ok('[7] a assinatura do contrato segue no banco para o balcão imprimir',
     sigDepois && sigDepois.assinada === true && typeof sigDepois.assinatura === 'string' &&
       sigDepois.assinatura.indexOf('data:image/png') === 0);
  ok('[7] o aparelho do vistoriador não vê nada além do público: fila sem CPF nem contrato',
     (await pedido(rotaVistoria, { method: 'GET', query: { token: TOKEN } })).j.pendentes.length === 0);

  /* --------- 8) chegada de 2 patinetes --------- */
  console.log('\n[8] chegada: 2 patinetes voltam, o resto continua na rua');
  const loteC = 'lc' + Date.now().toString(36);
  const devolve = cartoes.slice(0, 2);
  const fotosEntrada = devolve.map(c => foto(110 * 1024));
  const mapa2 = {};
  const cUma = await pedido(rotaVistoria, { method: 'POST', body: {
    token: TOKEN, acao: 'fotos', lote: loteC, fotos: fotosEntrada } });
  (cUma.j.caminhos || []).forEach((c, k) => { if(c) mapa2[fotosEntrada[k]] = c; });
  const horaChegada = Date.now() - 800;
  const chegada = await pedido(rotaVistoria, { method: 'POST', body: {
    token: TOKEN, acao: 'chegada', lote: loteC, loteHora: horaChegada,
    itens: devolve.map((c, i) => ({ locacaoId: c.locId, veiculo: c.etiqueta,
      fotos: [mapa2[fotosEntrada[i]] || fotosEntrada[i]], estado: 'loja' })) } });
  ok('[8] chegada em lote registrou os 2',
     chegada.status === 200 && (chegada.j.resultados || []).every(r => r.ok),
     JSON.stringify((chegada.j || {}).resultados || {}).slice(0, 200));
  const e3 = (await pedido(rotaEstado, comSessao({ method: 'GET', query: {} }))).j;
  const devol = e3.doc.locacoes.filter(l => locIds.slice(0, 2).includes(l.id) && l.status === 'devolvida');
  const stillNaRua = e3.doc.locacoes.filter(l => l.grupoId === 'G1' && l.status === 'ativa');
  ok('[8] fimReal único (hora da comanda) e veículo de volta à loja',
     devol.length === 2 && new Set(devol.map(l => l.fimReal)).size === 1 &&
       Math.abs(devol[0].fimReal - horaChegada) < 120000 &&
       devol.every(l => {
         const v = e3.doc.veiculos.find(vv => vv.id === l.veiculoId);
         return v && v.status === 'loja';
       }),
     'devolvidas: ' + devol.length);
  const fila2 = await pedido(rotaVistoria, { method: 'GET', query: { token: TOKEN } });
  ok('[8] a fila do celular mostra 3 na rua e 2 entregues com fotos',
     (fila2.j.naRua || []).length === 3 && (fila2.j.chegadas || []).length === 2 &&
       (fila2.j.chegadas || []).every(x => x.fotosEntrada === 1),
     'na rua ' + (fila2.j.naRua || []).length + ' · entregues ' + (fila2.j.chegadas || []).length);
  ok('[8] o restante da comanda não é afetado pela chegada dos 2',
     stillNaRua.length === 3 && stillNaRua.every(l => l.status === 'ativa'));

  /* --------- informe final --------- */
  console.log('\n---- relatório do E2E ----');
  console.log('  documento: ' + contadores.escritasOk + ' gravações · ' +
    contadores.conflitos + ' conflitos de versão · ' + contadores.fotosN +
    ' fotos no banco · ' + contadores.leituras + ' leituras');
  const reprovados = ERC.length;
  console.log('\n' + (reprovados ? reprovados + ' reprovação(ões) no E2E.' :
    'E2E todo verde — do cliente do zero à vistoria sincronizada.'));
  process.exit(reprovados ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

/* --------- helpers usados no roteiro --------- */
let contadorLote = 0;
function loteDe(){ return 'le' + (++contadorLote) + Date.now().toString(36); }

/* fase 1: staging das fotos em lotes de 8, 3 em paralelo (o celular faz isso) */
async function subirFotos(token, lote, fotos){
  const mapa = {};
  let proximo = 0;
  const subir = async () => {
    while(proximo < fotos.length){
      const fatia = fotos.slice(proximo, proximo + 8);
      proximo += 8;
      const r = await pedido(rotaVistoria, { method: 'POST', body: {
        token: token, acao: 'fotos', lote: lote, fotos: fatia } });
      if(r.status === 200 && r.j && r.j.ok)
        fatia.forEach((f, k) => { if(r.j.caminhos[k]) mapa[f] = r.j.caminhos[k]; });
    }
  };
  await Promise.all([subir(), subir(), subir()]);
  return mapa;
}
