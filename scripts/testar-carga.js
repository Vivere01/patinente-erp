/* =====================================================================
   CARGA E CONCORRÊNCIA DA VISTORIA — sem banco real.

   Não é teste de integração com o Postgres: é um simulador que replica
   o comportamento do documento versionado (estado/salvar_estado com lock
   otimista: gravações se enfileiram no FOR UPDATE, versão defasada é
   recusada) em memória, com a latência de uma ida e volta ao Neon por
   consulta. O handler REAL da API (api/vistoria.js) roda por cima,
   exatamente como produção — inclusive o custo próprio (real, não
   simulado) de ler/registrar um documento grande.

   O que reproduz do dia a dia — onde o erro costuma acontecer:
     A) comanda de 30 patinetes postada 1 por 1 (o caminho que bugava),
        com o balcão gravando ao mesmo tempo → mede tempo, conflitos e o
        escorrego do relógio entre os cartões
     B) a mesma comanda pelo novo fluxo (fotos em lote + 1 commit)
     C) loteHora do aparelho torto demais → o servidor manda no relógio
     D) dois vistoriadores commitando comandas diferentes ao mesmo tempo
     E) etiqueta repetida dentro da comanda (o 2º tem de recusar)
     F) chegada (devolução) de 30 patinetes num só commit
   ===================================================================== */
'use strict';
const path = require('path');

/* --- patch do banco ANTES de carregar a API: sql vira simulador --- */
process.env.POSTGRES_URL = process.env.POSTGRES_URL || 'postgres://simulador:senha@localhost/vistoria';
const banco = require(path.join(__dirname, '..', 'lib', 'banco'));

const LAT_MS = Number(process.env.LAT_MS || 25);           /* ida e volta ao Neon por consulta */
const PRESSAO_MS = Number(process.env.PRESSAO_MS || 400);  /* o balcão salva a cada X ms */

const contadores = { leituras: 0, escritasOk: 0, conflitos: 0, fotos: 0, pressao: 0 };
let estado = { doc: {}, versao: 1 };
let escritando = Promise.resolve();

function dormir(ms){ return new Promise(r => setTimeout(r, ms)); }

/* o custo de parse do documento — tão real quanto o doc for grande */
function cloneDoc(){ return JSON.parse(JSON.stringify(estado.doc)); }

async function simularSql(texto, params){
  const t = String(texto).replace(/\s+/g, ' ').trim();
  if(t.indexOf('select doc, versao from public.estado') === 0){
    contadores.leituras++;
    await dormir(LAT_MS);
    return { rows: [{ doc: cloneDoc(), versao: estado.versao }] };
  }
  if(t.indexOf('select doc from public.estado') === 0){
    contadores.leituras++;
    await dormir(LAT_MS);
    return { rows: [{ doc: cloneDoc() }] };
  }
  if(t.indexOf('select ok, versao, doc from public.salvar_estado') === 0){
    await dormir(LAT_MS);
    const espera = escritando.then(async () => {
      if(Number(params[1]) !== estado.versao){
        contadores.conflitos++;
        return { rows: [{ ok: false, versao: estado.versao, doc: cloneDoc() }] };
      }
      estado.doc = JSON.parse(params[0]);
      estado.versao++;
      contadores.escritasOk++;
      return { rows: [{ ok: true, versao: estado.versao, doc: cloneDoc() }] };
    });
    escritando = espera.then(() => {}, () => {});
    return espera;
  }
  if(t.indexOf('insert into public.fotos') === 0){
    contadores.fotos++;
    await dormir(LAT_MS);
    return { rows: []};
  }
  if(t.indexOf('select caminho from public.fotos') === 0){
    await dormir(LAT_MS);
    const pedidos = (params[0] || []);
    return { rows: pedidos.map(c => ({ caminho: String(c) })) };
  }
  throw new Error('SQL não simulado na carga: ' + t.slice(0, 120));
}

banco.sql = simularSql;
banco.temBanco = () => true;

const api = require(path.join(__dirname, '..', 'api', 'vistoria'));

/* ---------- utilidades ---------- */
const ERC = [];
function ok(nome, cond, detalhe){
  console.log((cond ? '  ✓ ' : '  ✗ ') + nome + (detalhe && !cond ? ' — ' + detalhe : ''));
  if(!cond) { ERC.push(nome); }
}

let respostaBruta = '';
function pedir(body){
  const res = { statusCode: 0, setHeader(){}, end(t){ respostaBruta = t; } };
  return api({ method: 'POST', body: body, query: {} }, res).then(() =>
    ({ status: res.statusCode, j: respostaBruta ? JSON.parse(respostaBruta) : null }));
}

/* foto de teste do tamanho de um clique de celular já comprimido
   pela página (900 px, qualidade 0.55 ≈ 120 KB) */
function foto(n){
  const bytes = Math.round(n / 4) * 3;
  const alvo = Buffer.alloc(bytes);
  for(let i = 0; i < bytes; i++) alvo[i] = (i * 131 + n) & 0xff;
  return 'data:image/jpeg;base64,' + alvo.toString('base64');
}

/* ---------- documento ---------- */
const TOKEN = 'TOKEN567890ABCD';
const GRANDE = 'G1';  /* comanda grande: um cliente, 30 patinetes */
const OUTRO = 'G2';   /* outro cliente, 15 patinetes */
const N_GRANDE = 30;
const N_OUTRO = 15;
const FOTOS_POR = 3;
const TAM_FOTO = 120 * 1024;

function documento(){
  const agora = Date.now();
  const veiculos = [];
  for(let i = 1; i <= 60; i++){
    veiculos.push({ id: i, codigo: 'PAT-' + String(i).padStart(3, '0'),
                    tipoId: 'pat', tipoNome: 'Patinete', status: 'loja' });
  }
  const locacoes = []; const grupos = [];
  const comanda = (gr, n, prefiX) => {
    const ids = [];
    for(let i = 1; i <= n; i++){
      const id = 'L' + prefiX + '-' + i;
      ids.push(id);
      locacoes.push({
        id: id, grupoId: gr, veiculoId: null, veiculoCodigo: '',
        clienteId: gr, clienteNome: gr === GRANDE ? 'Comanda grande (simulação)' : 'Outro cliente',
        tipoId: 'pat', tipoNome: 'Patinete',
        tarifaLabel: '30 minutos', duracaoMin: 30,
        inicio: null, fimPrevisto: null, fimReal: null,
        pagoEm: agora, liberadaEm: null, vistoriadaEm: null, vistoriadoPor: null,
        valorBase: 20, valorExcedente: 0, minutosExcedente: 0,
        pagamento: 'Pix', obsSaida: '', obsEntrada: '', obsVistoria: '',
        fotosSaida: [], fotosEntrada: [], status: 'pendente'
      });
    }
    grupos.push({ id: gr, status: 'aguardando_vistoria', locacaoIds: ids,
                  clienteNome: gr === GRANDE ? 'Comanda grande (simulação)' : 'Outro cliente',
                  valorBase: 20 * n, pagoEm: agora });
  };
  comanda(GRANDE, N_GRANDE, '1');
  comanda(OUTRO, N_OUTRO, '2');

  /* histórico do dia a dia: 250 locações passadas engordam o documento —
     que é lido e regravado por inteiro em cada operação */
  for(let i = 0; i < 250; i++){
    locacoes.push({
      id: 'H' + i, grupoId: null, veiculoId: null, veiculoCodigo: 'PAT-' + String((i % 60) + 1).padStart(3, '0'),
      clienteId: 'c' + i, clienteNome: 'Histórico ' + i, tipoId: 'pat', tipoNome: 'Patinete',
      tarifaLabel: '30 minutos', duracaoMin: 30,
      inicio: agora - (i + 1) * 86400000, fimPrevisto: agora - (i + 1) * 86400000 + 1800000,
      fimReal: agora - (i + 1) * 86400000 + 2000000, pagoEm: agora - (i + 1) * 86400000,
      liberadaEm: agora - (i + 1) * 86400000, vistoriadaEm: agora - (i + 1) * 86400000,
      valorBase: 20, valorExcedente: 0, minutosExcedente: 0, pagamento: 'Pix',
      obsSaida: 'nota de histórico ' + i, obsEntrada: '', obsVistoria: '',
      fotosSaida: [], fotosEntrada: [], status: 'finalizada'
    });
  }
  return {
    config: { vistoriaToken: TOKEN, exigirFoto: true, toleranciaMin: 5 },
    empresa: { nome: 'VeeLo Way (simulação)' },
    caixas: [{ dia: new Date(agora).toISOString().slice(0, 10), status: 'aberto' }],
    veiculos: veiculos, locacoes: locacoes, grupos: grupos, clientes: []
  };
}

function reiniciarDoc(){ estado = { doc: documento(), versao: 1 }; }
function docBytes(){ return Buffer.byteLength(JSON.stringify(estado.doc)); }

/* o balcão mexe no sistema enquanto o celular sincroniza */
let pressao = null;
function iniciarPressao(){
  if(pressao) return;
  pressao = setInterval(() => { estado.versao++; contadores.pressao++; }, PRESSAO_MS);
}
function pararPressao(){ if(pressao){ clearInterval(pressao); pressao = null; } }

function dentroDo(c0){
  const inc = {};
  ['leituras', 'escritasOk', 'conflitos', 'fotos', 'pressao'].forEach(
    k => inc[k] = contadores[k] - (c0[k] || 0));
  return inc;
}
function marco(){ return Object.assign({}, contadores); }
function mostrarResposta(nome, r){
  console.log('   ' + nome + ' status ' + r.status + ': ' +
    JSON.stringify(r.j).slice(0, 400));
}

/* cartões do celular: cada locação com N fotos já comprimidas.
   A frota da comanda G1 usa PAT-001..PAT-030; a de G2 usa PAT-031.. */
function cartoes(prefiX, n, baseFoto){
  const offset = prefiX === '1' ? 0 : 30;
  return Array.from({ length: n }, (_, i) => ({
    locId: 'L' + prefiX + '-' + (i + 1),
    etiqueta: 'PAT-' + String(offset + i + 1).padStart(3, '0'),
    fotos: Array.from({ length: FOTOS_POR }, (_, k) => foto(TAM_FOTO + baseFoto + i * 137 + k))
  }));
}

/* =====================================================================
   A) O CAMINHO ANTIGO: 1 POST por patinete, na sequência do celular
   ===================================================================== */
async function cenarioSequencial(cartoes){
  const c0 = marco(); const t0 = Date.now();
  const inicios = []; let gravados = 0;
  for(const c of cartoes){
    const r = await pedir({ token: TOKEN, acao: 'liberar', locacaoId: c.locId,
      veiculo: c.etiqueta, fotos: c.fotos });
    if(r.status === 200) gravados++;
    const loc = (estado.doc.locacoes || []).find(l => String(l.id) === String(c.locId));
    if(loc && loc.inicio) inicios.push(loc.inicio);
  }
  return { ms: Date.now() - t0, inicios, gravados, c: dentroDo(c0) };
}

/* =====================================================================
   B/C/D/F) O NOVO FLUXO: fotos em lotes paralelos + 1 commit
   ===================================================================== */
async function subirEmLotes(cartoes, lote){
  const mapa = {}; const todas = [];
  cartoes.forEach(c => c.fotos.forEach(f => todas.push(f)));
  let proximo = 0;
  const subir = async () => {
    while(proximo < todas.length){
      const fatia = todas.slice(proximo, proximo + 8);
      proximo += 8;
      const r = await pedir({ token: TOKEN, acao: 'fotos', lote: lote,
        fotos: fatia });
      if(r.status === 200 && r.j && r.j.ok){
        fatia.forEach((f, k) => { if(r.j.caminhos[k]) mapa[f] = r.j.caminhos[k]; });
      }
    }
  };
  await Promise.all([subir(), subir(), subir()]);
  return mapa;
}

async function cenarioEmLote(acao, prefiX, n, baseFoto, loteHora){
  const cs = cartoes(prefiX, n, baseFoto);
  const lote = 'l' + Date.now().toString(36) + prefiX;
  const c0 = marco(); const t0 = Date.now();
  const mapa = await subirEmLotes(cs, lote);
  const msFotos = Date.now() - t0;
  const r = await pedir({ token: TOKEN, acao: acao, lote: lote,
    loteHora: loteHora === undefined ? Date.now() - 1000 : loteHora,
    itens: cs.map(c => ({ locacaoId: c.locId, veiculo: c.etiqueta,
      fotos: c.fotos.map(f => mapa[f] || f), obs: 'carga',
      estado: acao === 'chegada' ? 'loja' : undefined })) });
  return { r, ms: Date.now() - t0, msFotos, c: dentroDo(c0) };
}

/* =====================================================================
   ROTEIRO
   ===================================================================== */
(async () => {
  reiniciarDoc();
  console.log('Carga da vistoria — latência por consulta: ' + LAT_MS + ' ms · ' +
    'pressão do balcão a cada ' + PRESSAO_MS + ' ms');
  console.log('Documento inicial: ' + (docBytes() / 1024).toFixed(0) + ' KB · fotos por locação: ' + FOTOS_POR);

  /* ---------- A: o caminho antigo ---------- */
  console.log('\n[A] comanda de ' + N_GRANDE + ': um POST por patinete, na sequência (o caminho que bugava)');
  reiniciarDoc();
  iniciarPressao();
  const a = await cenarioSequencial(cartoes('1', N_GRANDE, 0));
  pararPressao();
  const aLivres = a.inicios.filter(v => v);
  const escorregoAntigo = aLivres.length ? Math.max.apply(null, aLivres) - Math.min.apply(null, aLivres) : -1;
  console.log('   tempo total: ' + (a.ms / 1000).toFixed(1) + ' s · documento: ' + a.c.leituras +
    ' leituras / ' + a.c.escritasOk + ' escritas ok / ' + a.c.conflitos + ' conflitos com o balcão · ' +
    a.c.fotos + ' inserções de foto');
  console.log('   relógio entre o 1º e o ' + N_GRANDE + 'º patinete: ' + (escorregoAntigo / 1000).toFixed(1) +
    ' s de diferença no inicio');
  ok('[A] nada se perde mesmo com o balcão gravando junto', a.gravados === N_GRANDE,
     'gravados: ' + a.gravados + '/' + N_GRANDE);

  /* ---------- B: o novo fluxo ---------- */
  console.log('\n[B] a mesma comanda: fotos em lotes paralelos + 1 commit');
  reiniciarDoc();
  iniciarPressao();
  const horaLote = Date.now() - 2000;
  const b = await cenarioEmLote('liberar', '1', N_GRANDE, 50000, horaLote);
  pararPressao();
  console.log('   tempo total: ' + (b.ms / 1000).toFixed(1) + ' s (fotos ' + (b.msFotos / 1000).toFixed(1) +
    ' s + commit ' + ((b.ms - b.msFotos) / 1000).toFixed(1) + ' s) · documento: ' + b.c.leituras +
    ' leituras / ' + b.c.escritasOk + ' escritas ok / ' + b.c.conflitos + ' conflitos');
  const locsB = estado.doc.locacoes.filter(l => l.grupoId === GRANDE);
  const iniciosB = locsB.map(l => l.inicio);
  ok('[B] um commit grava a comanda inteira de ' + N_GRANDE,
     b.r.status === 200 && b.r.j && b.r.j.ok && (b.r.j.resultados || []).every(x => x.ok));
  ok('[B] o relógio do lote vale para todos — escorrego zero', new Set(iniciosB).size === 1,
     'inicios diferentes: ' + new Set(iniciosB).size);
  ok('[B] bate com a hora do celular (loteHora, 2 s antes)', Math.abs(iniciosB[0] - horaLote) < 120000,
     'inicio: ' + new Date(iniciosB[0]).toISOString());
  ok('[B] ' + FOTOS_POR + ' fotos ficaram em cada locação',
     locsB.every(l => (l.fotosSaida || []).length === FOTOS_POR));
  ok('[B] veículos saíram para a rua e a comanda ficou ativa',
     locsB.every(l => {
       const v = estado.doc.veiculos.find(vv => vv.id === l.veiculoId);
       return v && v.status === 'rua';
     }) && (estado.doc.grupos.find(g => g.id === GRANDE) || {}).status === 'ativo');

  /* ---------- C: loteHora torta demais ---------- */
  console.log('\n[C] relógio do celular 3 h atrasado no commit');
  reiniciarDoc();
  const torto = await cenarioEmLote('liberar', '1', 3, 90000, Date.now() - 3 * 3600000);
  const ins3 = estado.doc.locacoes.filter(l => l.grupoId === GRANDE && l.status === 'ativa').map(l => l.inicio);
  const pC = {
    status: torto.r.status,
    todosOk: (torto.r.j && torto.r.j.resultados || []).every(x => x.ok),
    unicos: new Set(ins3).size,
    inicio: ins3[0], agoraNoTeste: Date.now()
  };
  ok('[C] relógio torto demais: o servidor manda no horário',
     pC.status === 200 && pC.todosOk && pC.unicos === 1 &&
       pC.inicio > pC.agoraNoTeste - 120000 && pC.inicio < pC.agoraNoTeste + 120000,
     'detalhe: ' + JSON.stringify(pC));

  /* ---------- D: pressão dura + dois vistoriadores ---------- */
  console.log('\n[D] dois vistoriadores, duas comandas, commitando ao mesmo tempo');
  reiniciarDoc();
  iniciarPressao();
  const [d1, d2] = await Promise.all([
    cenarioEmLote('liberar', '1', N_GRANDE, 200000),
    cenarioEmLote('liberar', '2', N_OUTRO, 300000)
  ]);
  pararPressao();
  const okD1 = d1.r.status === 200 && d1.r.j && d1.r.j.ok && (d1.r.j.resultados || []).every(x => x.ok);
  const okD2 = d2.r.status === 200 && d2.r.j && d2.r.j.ok && (d2.r.j.resultados || []).every(x => x.ok);
  const ativas = estado.doc.locacoes.filter(l => l.status === 'ativa').length;
  console.log('   tempos: ' + (d1.ms / 1000).toFixed(1) + ' s e ' + (d2.ms / 1000).toFixed(1) +
    ' s · conflitos suportados: ' + (d1.c.conflitos + d2.c.conflitos) +
    ' · pressões do balcão: ' + (d1.c.pressao + d2.c.pressao));
  if(!(okD1 && okD2)){ mostrarResposta('[D1]', d1.r); mostrarResposta('[D2]', d2.r); }
  ok('[D] as duas comandas gravam (' + N_GRANDE + ' + ' + N_OUTRO + ')',
     okD1 && okD2 && ativas === N_GRANDE + N_OUTRO,
     'ativas no fim: ' + ativas + ' · d1: ' + d1.r.status + ' · d2: ' + d2.r.status);

  /* ---------- E: etiqueta repetida ---------- */
  console.log('\n[E] a mesma etiqueta escaneada em dois cartões da comanda');
  reiniciarDoc();
  const csE = cartoes('1', 5, 400000);
  const etiquetasE = ['PAT-007', 'PAT-002', 'PAT-002', 'PAT-004', 'PAT-005'];
  const loteE = 'le' + Date.now().toString(36);
  const mapaE = await subirEmLotes(csE, loteE);
  const rE = await pedir({ token: TOKEN, acao: 'liberar', lote: loteE, loteHora: Date.now() - 500,
    itens: csE.map((c, i) => ({ locacaoId: c.locId, veiculo: etiquetasE[i],
      fotos: c.fotos.map(f => mapaE[f] || f) })) });
  const resE = (rE.j && rE.j.resultados) || [];
  const ativasE = estado.doc.locacoes.filter(l => l.status === 'ativa').length;
  ok('[E] o cartão com etiqueta já usada recusa; o resto grava',
     ativasE === 4 && resE.length === 5 && resE[2].ok === false && resE[2].erro === 'veiculo_indisponivel',
     'ativas: ' + ativasE + ' · respostas: ' + JSON.stringify(resE.map(x => !!x.ok)));

  /* ---------- F: chegada de 30 num commit ---------- */
  console.log('\n[F] chegada (devolução) de ' + N_GRANDE + ' patinetes num commit');
  reiniciarDoc();
  iniciarPressao();
  await cenarioEmLote('liberar', '1', N_GRANDE, 500000);
  const chegada = await cenarioEmLote('chegada', '1', N_GRANDE, 600000, Date.now() - 500);
  pararPressao();
  const devolvidas = estado.doc.locacoes.filter(l => l.grupoId === GRANDE && l.status === 'devolvida');
  ok('[F] chegada em lote: ' + N_GRANDE + ' devolvidas, veículos de volta à loja',
     chegada.r.status === 200 && devolvidas.length === N_GRANDE &&
       devolvidas.every(l => {
         const v = estado.doc.veiculos.find(vv => vv.id === l.veiculoId);
         return v && v.status === 'loja';
       }),
     'devolvidas: ' + devolvidas.length + ' · status: ' + chegada.r.status);
  ok('[F] a hora da chegada vem do loteHora (relógio da comanda)',
     devolvidas.length && new Set(devolvidas.map(l => l.fimReal)).size === 1);

  /* ---------- informe final ---------- */
  console.log('\n---- comparativo da mesma comanda de ' + N_GRANDE + ' patinetes ----');
  console.log('  [A] caminho antigo: ' + (a.ms / 1000).toFixed(1) + ' s · ' + (escorregoAntigo / 1000).toFixed(1) +
    ' s de relógio torto entre cartões · ' + a.c.leituras + '/' + a.c.escritasOk +
    ' leituras/escritas do documento');
  console.log('  [B] novo fluxo:     ' + (b.ms / 1000).toFixed(1) + ' s · relógio único · ' +
    b.c.leituras + '/' + b.c.escritasOk + ' leituras/escritas do documento');
  console.log('  documento no fim: ' + (docBytes() / 1024).toFixed(0) + ' KB');

  pararPressao();
  const reprovados = ERC.length;
  console.log('\n' + (reprovados ? reprovados + ' reprovação(ões) na carga.' : 'Carga toda verde.'));
  process.exit(reprovados ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
