/* Vistoria de saída e de chegada pelo link público.

   GET  /api/vistoria?token=...                 fila do momento (payload mínimo)
   POST /api/vistoria { token, acao, ... }      confirma a liberação ou a chegada

   Quem tem o link fotografa, confere o lacre e dá o horário — e nada mais:
   o payload não leva CPF, senha, usuários nem o documento inteiro. O token
   é o mesmo de Configurações e só muda se o lojista pedir um novo.

   Liberação (acao='liberar'):
     { token, locacaoId, fotos:[dataUrl,...], lacre, obs }
     → locação vira 'ativa' com inicio/fimPrevisto reais, o veículo sai
       para 'rua', o lacre esperado é rompido e o grupo fica 'ativo'.

   Chegada (acao='chegada'):
     { token, locacaoId, fotos:[dataUrl,...], lacre, estado, obs }
     → locação vira 'devolvida' com fimReal da hora do celular; o balcão
       fecha a cobrança depois, com as peças e o excedente.
   ===================================================================== */
const { json, erro, metodoInvalido, corpo } = require('../lib/http');
const { temBanco, sql } = require('../lib/banco');
const { assinarUrl } = require('../lib/auth');
const { seguro } = require('../lib/tratar');

const VALIDADE_MS = 6 * 3600000;
const TAMANHO_MAX = 600 * 1024;

function exigirBanco(res){
  if(temBanco()) return true;
  erro(res, 503, 'banco_nao_configurado', 'POSTGRES_URL não definida. Conecte o Postgres no painel da Vercel.');
  return false;
}

function tokenValido(db, token){
  const esperado = db && db.config ? String(db.config.vistoriaToken || '') : '';
  const recebido = String(token || '');
  if(esperado.length < 12 || recebido.length < 12) return false;
  if(esperado.length !== recebido.length) return false;
  let d = 0;
  for(let i=0;i<esperado.length;i++) d |= esperado.charCodeAt(i) ^ recebido.charCodeAt(i);
  return d === 0;
}

function decodificar(dataUrl){
  const s = String(dataUrl || '');
  const i = s.indexOf('base64,');
  const bruto = i >= 0 ? s.slice(i + 7) : s;
  if(!bruto) return null;
  const buf = Buffer.from(bruto, 'base64');
  return buf.length ? buf : null;
}

/* grava a foto e devolve o caminho + URL assinada para a tela do celular */
async function guardarFoto(dataUrl, locId, indice){
  const bytes = decodificar(dataUrl);
  if(!bytes) return null;
  if(bytes.length > TAMANHO_MAX) throw Object.assign(new Error('Imagem acima de 600 KB.'), { codigo: 413, erro: 'imagem_grande_demais' });
  const caminho = 'vistoria/' + String(locId).replace(/[^A-Za-z0-9_-]/g, '') + '/' + indice + '-' + Date.now() + '.jpg';
  const mime = /^data:([a-zA-Z0-9.+/-]+);base64,/.exec(String(dataUrl || ''));
  await sql(`insert into public.fotos (caminho, mime, bytes, tamanho)
             values ($1, $2, $3, $4)
             on conflict (caminho) do update set bytes = excluded.bytes,
                                                 mime = excluded.mime,
                                                 tamanho = excluded.tamanho`,
    [caminho, (mime && mime[1]) || 'image/jpeg', bytes, bytes.length]);
  const { exp, sig } = assinarUrl(caminho, VALIDADE_MS);
  return { id: 'f' + Date.now() + '' + indice, caminho, ts: Date.now(),
           url: '/api/fotos?caminho=' + encodeURIComponent(caminho) + '&exp=' + exp + '&sig=' + sig };
}

function lacreAplicadoNo(db, veiculoId){
  const lacres = db.lacres || {};
  return Object.values(lacres).find(l => l && l.status === 'aplicado' && l.veiculoId === veiculoId) || null;
}
function lacreDe(db, n){
  return (db.lacres || {})[String(n == null ? '' : n).trim()] || null;
}
function marcarRomper(db, n, locId, veiculoId, quem){
  const l = lacreDe(db, n);
  if(!l) return false;
  l.status = 'rompido'; l.rompidoEm = Date.now(); l.rompidoPor = quem;
  l.locacaoId = locId; l.veiculoId = veiculoId;
  return true;
}
function divergir(db, tipo, detalhe, extra){
  db.seq = db.seq || {};
  db.seq.diverg = (db.seq.diverg || 1);
  const id = db.seq.diverg;
  db.seq.diverg = id + 1;
  db.divergencias = db.divergencias || [];
  db.divergencias.push(Object.assign({
    id: 'diverg' + id, ts: Date.now(), tipo, detalhe,
    usuario: 'vistoria (link)', resolvida: false
  }, extra || {}));
}

/* lê, deixa mutar e grava com lock otimista: se o balcão salvou antes,
   refaz a mutação no documento novo em vez de sobrescrever */
async function comLock(mutar){
  for(let tentativa = 0; tentativa < 4; tentativa++){
    const r = await sql('select doc, versao from public.estado where id = 1');
    const linha = r.rows[0] || { doc: {}, versao: 0 };
    const doc = linha.doc || {};
    mutar(doc);
    const w = await sql('select ok, versao, doc from public.salvar_estado($1, $2, $3)',
      [JSON.stringify(doc), Number(linha.versao) || 0, 'vistoria (link)']);
    const out = w.rows[0] || {};
    if(out.ok === true || Number(out.ok) === 1) return true;
  }
  return false;
}

function payload(db, agora){
  const locs = Array.isArray(db.locacoes) ? db.locacoes : [];
  const cfg = db.config || {};
  const hoje = new Date(agora); const diaHoje = hoje.getFullYear() + '-' +
    String(hoje.getMonth()+1).padStart(2,'0') + '-' + String(hoje.getDate()).padStart(2,'0');

  const pendentes = locs.filter(l => l.status === 'pendente').map(l => ({
    locacaoId: l.id, grupoId: l.grupoId, codigo: l.veiculoCodigo, tipoNome: l.tipoNome,
    clienteNome: l.clienteNome, pagamento: l.pagamento, valorBase: l.valorBase,
    tarifaLabel: l.tarifaLabel, duracaoMin: l.duracaoMin, pagoEm: l.pagoEm || null,
    obsSaida: l.obsSaida || '', lacreEsperado: l.lacreEsperado || null
  }));

  const naRua = locs.filter(l => l.status === 'ativa').map(l => ({
    locacaoId: l.id, codigo: l.veiculoCodigo, clienteNome: l.clienteNome,
    inicio: l.inicio, fimPrevisto: l.fimPrevisto, tarifaLabel: l.tarifaLabel,
    atrasado: agora > (l.fimPrevisto || agora),
    fotosSaida: (l.fotosSaida || []).length
  }));

  const chegadas = locs.filter(l => l.status === 'devolvida' && diaDe(l.fimReal) === diaHoje)
    .map(l => ({
      locacaoId: l.id, codigo: l.veiculoCodigo, clienteNome: l.clienteNome,
      fimReal: l.fimReal, lacreEntrada: l.lacreEntrada || null,
      fotosEntrada: (l.fotosEntrada || []).length
    }));

  const liberadas = locs.filter(l => l.vistoriadaEm && diaDe(l.vistoriadaEm) === diaHoje)
    .map(l => ({
      locacaoId: l.id, codigo: l.veiculoCodigo, clienteNome: l.clienteNome,
      liberadaEm: l.vistoriadaEm, por: l.vistoriadoPor || 'link público',
      fotos: (l.fotosSaida || []).length, pendente: l.status === 'pendente'
    }));

  return {
    ok: true, agora,
    empresa: { nome: (db.empresa && db.empresa.nome) || 'Locadora' },
    exigirFoto: cfg.exigirFoto !== false,
    exigirLacre: cfg.exigirLacre !== false,
    toleranciaMin: Number(cfg.toleranciaMin) || 0,
    pendentes, naRua, chegadas, liberadas
  };
}

function diaDe(ts){
  if(!ts) return '';
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

module.exports = async (req, res) => {
  if(req.method !== 'GET' && req.method !== 'POST') return metodoInvalido(res, ['GET', 'POST']);
  if(!exigirBanco(res)) return;

  return seguro(res, async () => {
    const agora = Date.now();

    if(req.method === 'GET'){
      const token = (req.query || {}).token;
      const r = await sql('select doc from public.estado where id = 1');
      const db = (r.rows[0] || {}).doc || {};
      if(!tokenValido(db, token)) return erro(res, 401, 'token_invalido', 'Link inválido. Peça um novo link da vistoria no balcão.');
      return json(res, 200, payload(db, agora));
    }

    const b = corpo(req);
    const r = await sql('select doc from public.estado where id = 1');
    const dbInicial = (r.rows[0] || {}).doc || {};
    if(!tokenValido(dbInicial, b.token)) return erro(res, 401, 'token_invalido', 'Link inválido. Peça um novo link da vistoria no balcão.');

    const acao = String(b.acao || '');
    /* o id chega como texto, vindo do atributo data-* do cartão: a procura
       compara o valor por igual, servindo tanto para id numérico quanto para
       id em texto (o id real sai do documento, nunca do pedido) */
    const locId = b.locacaoId;
    if(locId == null || String(locId).trim() === '')
      return erro(res, 400, 'locacao_invalida', 'Informe a locação.');
    const mesmaLoc = l => !!l && String(l.id) === String(locId);
    if(acao !== 'liberar' && acao !== 'chegada') return erro(res, 400, 'acao_invalida', 'Ação desconhecida.');

    const loc0 = (dbInicial.locacoes || []).find(mesmaLoc);
    if(!loc0) return erro(res, 404, 'locacao_nao_encontrada', 'Locação não encontrada.');
    if(acao === 'liberar' && loc0.status !== 'pendente')
      return erro(res, 409, 'ja_liberada', 'Essa locação já foi liberada.');
    if(acao === 'chegada' && loc0.status !== 'ativa')
      return erro(res, 409, 'ja_devolvida', 'Essa locação não está na rua.');

    const exigirFoto = dbInicial.config ? dbInicial.config.exigirFoto !== false : true;
    const exigirLacre = dbInicial.config ? dbInicial.config.exigirLacre !== false : true;
    const fotosBrutas = Array.isArray(b.fotos) ? b.fotos.filter(Boolean).slice(0, 6) : [];
    if(exigirFoto && !fotosBrutas.length)
      return erro(res, 400, 'foto_obrigatoria', 'Ao menos uma foto é obrigatória para a vistoria.');
    const lacre = String(b.lacre == null ? '' : b.lacre).trim().slice(0, 20);
    if(exigirLacre && acao === 'liberar' && !lacre)
      return erro(res, 400, 'lacre_obrigatorio', 'Informe o número do lacre rompido.');
    if(exigirLacre && acao === 'chegada' && !lacre)
      return erro(res, 400, 'lacre_obrigatorio', 'Informe o número do novo lacre.');
    const estado = acao === 'chegada' ? (b.estado === 'manutencao' ? 'manutencao' : 'loja') : null;

    /* fotos primeiro: caminho novo por locação e por rodada */
    const fotos = [];
    for(let i = 0; i < fotosBrutas.length; i++){
      const f = await guardarFoto(fotosBrutas[i], loc0.id, i + '-' + Date.now());
      if(f) fotos.push({ id: f.id, caminho: f.caminho, ts: f.ts,
                         legenda: acao === 'liberar' ? ('Vistoria de saída ' + (i+1)) : ('Vistoria de chegada ' + (i+1)) });
    }

    const ok = await comLock(db => {
      const loc = (db.locacoes || []).find(mesmaLoc);
      if(!loc) return;
      const quem = 'vistoria (link)';

      if(acao === 'liberar'){
        const dur = Number(loc.duracaoMin) || 0;
        const inicio = Date.now();
        loc.inicio = inicio;
        loc.fimPrevisto = inicio + dur * 60000;
        loc.liberadaEm = inicio;
        loc.vistoriadaEm = inicio;
        loc.vistoriadoPor = quem;
        loc.fotosSaida = fotos;
        loc.lacreSaida = lacre;
        loc.obsVistoria = String(b.obs || '').trim().slice(0, 300);
        loc.status = 'ativa';

        const veiculo = (db.veiculos || []).find(v => v.id === loc.veiculoId);
        if(veiculo) veiculo.status = 'rua';

        if(exigirLacre){
          const ap = lacreAplicadoNo(db, loc.veiculoId);
          const esperado = ap ? String(ap.n) : (loc.lacreEsperado || null);
          if(esperado && esperado !== lacre){
            divergir(db, 'lacre_trocado',
              (loc.veiculoCodigo || '') + ' saiu com lacre ' + lacre + ', mas o sistema tinha ' + esperado,
              { veiculoId: loc.veiculoId, esperado, informado: lacre, locacaoId: loc.id });
          } else if(!esperado){
            divergir(db, 'veiculo_sem_lacre',
              (loc.veiculoCodigo || '') + ' saiu sem lacre registrado no sistema (informado ' + lacre + ')',
              { veiculoId: loc.veiculoId, informado: lacre, locacaoId: loc.id });
          }
          if(esperado) marcarRomper(db, esperado, loc.id, loc.veiculoId, quem);
          if(lacre && lacre !== esperado) marcarRomper(db, lacre, loc.id, loc.veiculoId, quem);
          loc.lacreEsperado = esperado;
        }

        const g = (db.grupos || []).find(x => x.id === loc.grupoId);
        if(g){
          g.status = 'ativo';
          const irmaos = (db.locacoes || []).filter(l => l.grupoId === g.id);
          const inicios = irmaos.map(l => l.inicio).filter(Boolean);
          const fins = irmaos.map(l => l.fimPrevisto).filter(Boolean);
          if(inicios.length) g.inicio = Math.min.apply(null, inicios);
          if(fins.length) g.fimPrevisto = Math.max.apply(null, fins);
          g.liberadoEm = Date.now();
        }
      } else {
        const chegou = Date.now();
        loc.fimReal = loc.fimReal || chegou;
        loc.chegadaEm = chegou;
        loc.status = 'devolvida';
        if(fotos.length) loc.fotosEntrada = fotos;
        if(lacre) loc.lacreEntrada = lacre;
        if(b.obs) loc.obsEntrada = String(b.obs).trim().slice(0, 300);
        if(!loc.atendenteEntrada) loc.atendenteEntrada = quem;
        const veiculo = (db.veiculos || []).find(v => v.id === loc.veiculoId);
        if(veiculo) veiculo.status = estado;
      }
    });

    if(!ok) return erro(res, 409, 'conflito', 'Outro aparelho salvou ao mesmo tempo. Atualize a tela e tente de novo.');

    const novo = await sql('select doc from public.estado where id = 1');
    return json(res, 200, payload((novo.rows[0] || {}).doc || {}, Date.now()));
  });
};
