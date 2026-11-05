/* Vistoria de saída e de chegada pelo link público.

   GET  /api/vistoria?token=...                 fila do momento (payload mínimo)
   POST /api/vistoria { token, acao, ... }      confirma a liberação ou a chegada

   Quem tem o link fotografa, escaneia a etiqueta do patinete e dá o horário —
   e nada mais: o payload não leva CPF, senha, usuários nem o documento inteiro.
   O token é o mesmo de Configurações e só muda se o lojista pedir um novo.

   A PERFORMANCE: comanda grande (30 patinetes pagos de uma vez) não pode
   virar 30 escritas do documento inteiro. O envio é em duas fases:
     1) acao 'fotos': sobe os arquivos em lotes pequenos e paralelos para a
        tabela fotos (staging em 'vistoria/lote/...'), sem tocar no documento;
     2) acao 'liberar' / 'chegada' com itens:[...]: UM commit por comanda —
        uma leitura + uma escrita do documento, com TODAS as locações do
        lote partindo do mesmo horário (relógio não escorrega entre os
        patinetes 1 e 30).

   Liberação (acao='liberar'):
     { token, acao, itens:[{ locacaoId, veiculo, fotos, obs }], loteHora }
     → locação vira 'ativa' com inicio/fimPrevisto reais, o veículo sai para
       'rua' e o grupo fica 'ativo'. Se a locação ainda não tem unidade
       vinculada (reserva por modelo), a unidade escaneada é amarrada aqui —
       desde que seja do modelo reservado e esteja livre na loja.
       Sem itens, o corpo antigo de 1 veículo (locacaoId no topo) segue
       valendo exatamente como antes.

   Chegada (acao='chegada'):
     { token, acao, itens:[{ locacaoId, veiculo, fotos, estado, obs }] }
     → locação vira 'devolvida'; o balcão fecha a cobrança depois, com as
       peças e o excedente. O veículo é identificado pela etiqueta escaneada.

   O 'fotos' em cada item aceita o formato antigo (dataUrl) — usado quando
   o upload em lotes falhou — ou o caminho devolvido por acao:'fotos'
   (validado contra o prefixo de staging do próprio lote).
   loteHora é o horário do celular no instante do botão: o servidor aceita
   só dentro de uma janela curta (relógio torto não derruba a corretude).
   ===================================================================== */
const { json, erro, metodoInvalido, corpo } = require('../lib/http');
const { temBanco, sql } = require('../lib/banco');
const { assinarUrl } = require('../lib/auth');
const { seguro } = require('../lib/tratar');

const VALIDADE_MS = 6 * 3600000;
const TAMANHO_MAX = 600 * 1024;
const PREFIXO_LOTE = 'vistoria/lote/';
const FOTOS_POR_POST = 12;      /* arquivos por POST de fotos */
const FOTOS_POR_ITEM = 6;       /* arquivos por locação (como sempre) */
const ITENS_POR_LOTE = 50;      /* locações por comanda */
const BYTES_POR_POST = 4 * 1024 * 1024;
const JANELA_LOTE_MS = 15 * 60000; /* loteHora válido até 15 min atrás */

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
async function guardarFoto(dataUrl, caminho){
  const bytes = decodificar(dataUrl);
  if(!bytes) return null;
  if(bytes.length > TAMANHO_MAX) throw Object.assign(new Error('Imagem acima de 600 KB.'), { codigo: 413, erro: 'imagem_grande_demais' });
  const mime = /^data:([a-zA-Z0-9.+/-]+);base64,/.exec(String(dataUrl || ''));
  await sql(`insert into public.fotos (caminho, mime, bytes, tamanho)
             values ($1, $2, $3, $4)
             on conflict (caminho) do update set bytes = excluded.bytes,
                                                  mime = excluded.mime,
                                                  tamanho = excluded.tamanho`,
    [caminho, (mime && mime[1]) || 'image/jpeg', bytes, bytes.length]);
  const { exp, sig } = assinarUrl(caminho, VALIDADE_MS);
  return { caminho, ts: Date.now(),
           url: '/api/fotos?caminho=' + encodeURIComponent(caminho) + '&exp=' + exp + '&sig=' + sig };
}

/* Fase 1: staging das fotos fora do documento. Só a tabela fotos muda —
   zero leitura/escrita do estado, então pode rodar em paralelo sem
   conflitar com o balcão. Os arquivos sobem por lote (um id por envio)
   e só passam a valer quando o commit as cita pelo caminho. */
async function salvarFotos(res, b, agora){
  const lote = String(b.lote || '').replace(/[^A-Za-z0-9_-]/g, '');
  if(lote.length < 6 || lote.length > 60)
    return erro(res, 400, 'lote_invalido', 'Identificação do envio de fotos inválida. Atualize a tela.');
  const brutas = Array.isArray(b.fotos) ? b.fotos.filter(Boolean).slice(0, FOTOS_POR_POST) : [];
  if(!brutas.length) return erro(res, 400, 'foto_obrigatoria', 'Nada para guardar.');
  let memoria = 0;
  for(const f of brutas){
    const s = String(f || '');
    memoria += s.length - (s.indexOf('base64,') >= 0 ? s.indexOf('base64,') + 7 : 0);
  }
  if(memoria > BYTES_POR_POST)
    return erro(res, 413, 'lote_grande_demais', 'Lote de fotos acima do aceito. Atualize a tela e tente de novo.');

  const caminhos = [], urls = [];
  for(let i = 0; i < brutas.length; i++){
    const destino = PREFIXO_LOTE + lote + '/' + i + '-' + agora + '-' + Date.now() + '.jpg';
    const f = await guardarFoto(brutas[i], destino);
    /* alinhado ao pedido pelo índice: quem falha devolve null */
    caminhos.push(f ? destino : null); urls.push(f ? f.url : null);
  }
  return json(res, 200, { ok: true, lote: lote, caminhos: caminhos, urls: urls });
}

/* Fase 2: lê, deixa mutar e grava com lock otimista: se o balcão salvou
   antes, refaz a mutação no documento novo em vez de sobrescrever.
   A leitura inicial vem de fora (o mesmo snapshot da validação), então um
   commit de comanda inteira custa no máximo leitura + escrita por tentativa.
   Devolve o documento gravado — a resposta não relê nada. */
async function comLock(doc, versao, mutar){
  for(let tentativa = 0; tentativa < 4; tentativa++){
    let linha = { doc: doc, versao: versao };
    if(tentativa > 0){
      const r = await sql('select doc, versao from public.estado where id = 1');
      linha = r.rows[0] || { doc: {}, versao: 0 };
    }
    const atual = linha.doc || {};
    const resultado = mutar(atual);
    if(resultado === false) return { ok: false, inviavel: true };
    const w = await sql('select ok, versao, doc from public.salvar_estado($1, $2, $3)',
      [JSON.stringify(atual), Number(linha.versao) || 0, 'vistoria (link)']);
    const out = w.rows[0] || {};
    if(out.ok === true || Number(out.ok) === 1)
      return { ok: true, doc: out.doc || atual, versao: Number(out.versao) || 0 };
  }
  return { ok: false, conflito: true };
}

function payload(db, agora){
  const locs = Array.isArray(db.locacoes) ? db.locacoes : [];
  const cfg = db.config || {};
  const hoje = new Date(agora); const diaHoje = hoje.getFullYear() + '-' +
    String(hoje.getMonth()+1).padStart(2,'0') + '-' + String(hoje.getDate()).padStart(2,'0');

  const pendentes = locs.filter(l => l.status === 'pendente').map(l => ({
    locacaoId: l.id, grupoId: l.grupoId,
    /* vínculo tardio: sem unidade amarrada, o cartão mostra o modelo
       aguardando a escolha do vistoriador */
    codigo: codigoDoVeiculo(db, l) || '',
    tipoId: l.tipoId || null, tipoNome: l.tipoNome,
    clienteNome: l.clienteNome, pagamento: l.pagamento, valorBase: l.valorBase,
    tarifaLabel: l.tarifaLabel, duracaoMin: l.duracaoMin, pagoEm: l.pagoEm || null,
    obsSaida: l.obsSaida || ''
  }));

  const naRua = locs.filter(l => l.status === 'ativa').map(l => ({
    locacaoId: l.id, grupoId: l.grupoId, codigo: codigoDoVeiculo(db, l), clienteNome: l.clienteNome,
    inicio: l.inicio, fimPrevisto: l.fimPrevisto, tarifaLabel: l.tarifaLabel,
    atrasado: agora > (l.fimPrevisto || agora),
    fotosSaida: (l.fotosSaida || []).length
  }));

  const chegadas = (caixaAberto(db, diaHoje)
    ? locs.filter(l => l.status === 'devolvida' && diaDe(l.fimReal) === diaHoje)
    : []).map(l => ({
      locacaoId: l.id,     codigo: codigoDoVeiculo(db, l), clienteNome: l.clienteNome,
      fimReal: l.fimReal,
      fotosEntrada: (l.fotosEntrada || []).length
    }));

  const liberadas = locs.filter(l => l.vistoriadaEm && diaDe(l.vistoriadaEm) === diaHoje)
    .map(l => ({
      locacaoId: l.id,     codigo: codigoDoVeiculo(db, l), clienteNome: l.clienteNome,
      liberadaEm: l.vistoriadaEm, por: l.vistoriadoPor || 'link público',
      fotos: (l.fotosSaida || []).length, pendente: l.status === 'pendente'
    }));

  return {
    ok: true, agora,
    /* carimbo do deploy: o celular compara com o que viu ao abrir e avisa
       quando há versão nova, sem precisar limpar o cache do navegador */
    deploy: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null,
    empresa: { nome: (db.empresa && db.empresa.nome) || 'Locadora' },
    exigirFoto: cfg.exigirFoto !== false,
    toleranciaMin: Number(cfg.toleranciaMin) || 0,
    /* a coluna "Entregues" do Kanban existe só enquanto o caixa do dia
       está aberto: fechou, as entregas do dia vão para o histórico */
    caixaAberto: caixaAberto(db, diaHoje),
    pendentes, naRua, chegadas, liberadas
  };
}

/* O mesmo critério do sistema: caixa aberto é o registro de hoje com
   status 'aberto'. Sem caixa de hoje, o dia conta como fechado. */
function caixaAberto(db, diaHoje){
  const caixas = Array.isArray(db.caixas) ? db.caixas : [];
  const c = caixas.find(x => x.dia === diaHoje);
  return !!c && c.status === 'aberto';
}

function diaDe(ts){
  if(!ts) return '';
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

/* O que a câmera lê da etiqueta colada no patinete: aceita o código puro
   (PAT-001), com prefixo da marca ou como link, e ignora caixa e espaços. */
function codigoLido(v){
  let t = String(v == null ? '' : v).trim();
  const m = t.match(/^https?:\/\/[^\s]+\/([^\/\s#?]+)[^\s]*$/);
  if(m) t = m[1];
  return t.replace(/^veeloway:/i, '').trim();
}

function codigoDoVeiculo(db, loc){
  if(loc && loc.veiculoCodigo) return String(loc.veiculoCodigo);
  /* reserva por modelo ainda sem unidade: mostra o modelo a definir */
  if(loc && !loc.veiculoCodigo && loc.tipoNome) return '';
  const v = ((db || {}).veiculos || []).find(x => String(x.id) === String(loc && loc.veiculoId));
  return v ? String(v.codigo) : '';
}

/* Acha o veículo físico pelo código escaneado na etiqueta. */
function veiculoPorCodigo(db, codigo){
  const alvo = String(codigo == null ? '' : codigo).trim().toUpperCase();
  if(!alvo) return null;
  return ((db || {}).veiculos || []).find(v => String(v.codigo || '').toUpperCase() === alvo) || null;
}

/* =====================================================================
   VALIDAÇÃO DE UM ITEM (locId, veículo escaneado, fotos, estado).

   O que é regra da locação na tela (409 por código errado ou ocupado)
   é conferido contra o snapshot da leitura — e re-conferido DENTRO do
   lock, porque entre leitura e gravação o balcão pode mudar tudo.
   ===================================================================== */

/* confere uma foto: caminho do staging do próprio lote ou dataUrl */
function caminhoDoLote(v, lote){
  const s = String(v || '');
  if(s.indexOf('data:') === 0) return { dataUrl: s };
  if(s.indexOf('/') === 0) return null; /* nunca um caminho de resposta */
  if(PREFIXO_LOTE + lote + '/' !== s.slice(0, (PREFIXO_LOTE + lote + '/').length)) return null;
  const resto = s.slice(PREFIXO_LOTE.length + lote.length + 1);
  if(!resto || /[^A-Za-z0-9_.-]/.test(resto)) return null;
  return { caminho: s };
}

/* As fotos de um item, preparadas antes do commit:
   dataUrls viram arquivos já guardados; caminhos de lote são conferidos
   no banco de uma vez (uma consulta para a comanda inteira). */
async function prepararFotos(itens, agora){
  const exigidas = new Map(); /* dataUrl -> índice para gravar */
  const possiveis = [];       /* caminhos a conferir */
  itens.forEach((it, i) => {
    it.usoFotos = [];
    for(const f of it.fotosBrutas){
      const t = caminhoDoLote(f, it.lote);
      if(!t) continue;
      if(t.dataUrl){ it.usoFotos.push({ dataUrl: t.dataUrl }); }
      else { it.usoFotos.push({ caminho: t.caminho }); possiveis.push(t.caminho); }
    }
    if(it.usoFotos.length > FOTOS_POR_ITEM) it.usoFotos = it.usoFotos.slice(0, FOTOS_POR_ITEM);
  });
  if(possiveis.length){
    const r = await sql('select caminho from public.fotos where caminho = ANY($1)', [possiveis]);
    const validos = new Set((r.rows || []).map(x => String(x.caminho)));
    itens.forEach(it => { it.usoFotos = it.usoFotos.filter(f => !f.caminho || validos.has(f.caminho)); });
  }
  for(const it of itens){
    for(const f of it.usoFotos){
      if(!f.dataUrl) continue;
      const destino = PREFIXO_LOTE + it.lote + '/c-' + agora + '-' + Date.now() + '-' +
        Math.floor(Math.random() * 1e6) + '.jpg';
      const g = await guardarFoto(f.dataUrl, destino);
      if(g){ delete f.dataUrl; f.caminho = destino; }
    }
  }
}

/* Registro enxuto da foto dentro da locação (os bytes já estão na tabela). */
function registroDaFoto(f, legenda, indice){
  return { id: 'f' + Date.now() + '' + indice, caminho: f.caminho, ts: f.ts || Date.now(), legenda: legenda };
}

function msgDe(codigo){
  const m = {
    ja_liberada: 'Essa locação já foi liberada.',
    ja_devolvida: 'Essa locação não está na rua.',
    veiculo_nao_escaneado: 'Escaneie o código do patinete antes de continuar.',
    veiculo_incorreto: 'O código lido não é o deste cartão.',
    veiculo_nao_encontrado: 'O código não é de nenhum veículo da frota.',
    veiculo_indisponivel: 'A unidade não está livre na loja.',
    foto_obrigatoria: 'Ao menos uma foto é obrigatória para a vistoria.'
  };
  return m[codigo] || 'Não gravou. Atualize a tela e tente de novo.';
}

/* Confere 1 item contra o documento. Devolve { erro } ou { loc } —
   sem tocar em nada: a mutação dentro do lock é outra função. */
function conferirItem(db, it, acao, exigirFoto){
  const locId = it.locId;
  const mesmaLoc = l => !!l && String(l.id) === String(locId);
  const loc = (db.locacoes || []).find(mesmaLoc);
  if(!loc) return { erro: 'locacao_nao_encontrada' };
  if(acao === 'liberar' && loc.status !== 'pendente') return { erro: 'ja_liberada' };
  if(acao === 'chegada' && loc.status !== 'ativa') return { erro: 'ja_devolvida' };

  const lido = codigoLido(it.veiculo);
  const esperadoCodigo = codigoDoVeiculo(db, loc);
  if(!lido) return { erro: 'veiculo_nao_escaneado' };
  const semVinculo = acao === 'liberar' && !loc.veiculoCodigo && !esperadoCodigo;

  if(!semVinculo && lido.toUpperCase() !== String(esperadoCodigo).toUpperCase())
    return { erro: 'veiculo_incorreto', recebido: lido, esperado: String(esperadoCodigo || '') };

  if(semVinculo){
    const v = veiculoPorCodigo(db, lido);
    if(!v) return { erro: 'veiculo_nao_encontrado' };
    if(String(v.tipoId) !== String(loc.tipoId)) return { erro: 'veiculo_incorreto' };
    if(v.status !== 'loja') return { erro: 'veiculo_indisponivel' };
    const preso = (db.locacoes || []).some(l => l.id !== loc.id &&
      (l.status === 'ativa' || l.status === 'pendente') &&
      l.veiculoId != null && String(l.veiculoId) === String(v.id));
    if(preso) return { erro: 'veiculo_indisponivel' };
  }

  if(exigirFoto && !(it.usoFotos || []).length) return { erro: 'foto_obrigatoria' };
  return { loc: loc, lido: lido };
}

/* Aplica 1 item já conferido no documento dentro do lock.
   Devolve null quando o estado mudou por baixo (o chamador registra). */
function aplicarItem(db, it, conferido, acao, horaBase, quem){
  const loc = (db.locacoes || []).find(l => l.id === conferido.loc.id);
  if(!loc) return false;
  if(acao === 'liberar' && loc.status !== 'pendente') return false;
  if(acao === 'chegada' && loc.status !== 'ativa') return false;

  const lido = codigoLido(it.veiculo);
  const semVinculo = acao === 'liberar' && !loc.veiculoCodigo && !codigoDoVeiculo(db, loc);

  if(semVinculo){
    const v = veiculoPorCodigo(db, lido);
    if(!v || String(v.tipoId) !== String(loc.tipoId) || v.status !== 'loja') return false;
    const preso = (db.locacoes || []).some(l => l.id !== loc.id &&
      (l.status === 'ativa' || l.status === 'pendente') &&
      l.veiculoId != null && String(l.veiculoId) === String(v.id));
    if(preso) return false;
    loc.veiculoId = v.id;
    loc.veiculoCodigo = String(v.codigo);
  } else {
    const esperadoCodigo = String(codigoDoVeiculo(db, loc)).toUpperCase();
    if(lido.toUpperCase() !== esperadoCodigo) return false;
  }

  const fotos = (it.usoFotos || []).filter(f => f.caminho)
    .map((f, i) => registroDaFoto(f, acao === 'liberar' ? ('Vistoria de saída ' + (i+1))
                                                     : ('Vistoria de chegada ' + (i+1)), i + '-' + Date.now()));

  if(acao === 'liberar'){
    const dur = Number(loc.duracaoMin) || 0;
    /* relógio único do lote: os 30 patinetes da comanda começam juntos */
    loc.inicio = horaBase;
    loc.fimPrevisto = horaBase + dur * 60000;
    loc.liberadaEm = horaBase;
    loc.vistoriadaEm = horaBase;
    loc.vistoriadoPor = quem;
    loc.fotosSaida = fotos;
    loc.obsVistoria = String(it.obs || '').trim().slice(0, 300);
    loc.status = 'ativa';

    const veiculo = (db.veiculos || []).find(v => v.id === loc.veiculoId);
    if(veiculo) veiculo.status = 'rua';

    const g = (db.grupos || []).find(x => x.id === loc.grupoId);
    if(g){
      g.status = 'ativo';
      const irmaos = (db.locacoes || []).filter(l => l.grupoId === g.id);
      const inicios = irmaos.map(l => l.inicio).filter(Boolean);
      const fins = irmaos.map(l => l.fimPrevisto).filter(Boolean);
      if(inicios.length) g.inicio = Math.min.apply(null, inicios);
      if(fins.length) g.fimPrevisto = Math.max.apply(null, fins);
      g.liberadoEm = horaBase;
    }
  } else {
    loc.fimReal = loc.fimReal || horaBase;
    loc.chegadaEm = horaBase;
    loc.status = 'devolvida';
    if(fotos.length) loc.fotosEntrada = fotos;
    if(it.obs) loc.obsEntrada = String(it.obs).trim().slice(0, 300);
    if(!loc.atendenteEntrada) loc.atendenteEntrada = quem;
    const veiculo = (db.veiculos || []).find(v => v.id === loc.veiculoId);
    if(veiculo) veiculo.status = it.estado === 'manutencao' ? 'manutencao' : 'loja';
  }
  return true;
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
    const acao = String(b.acao || '');
    if(acao !== 'liberar' && acao !== 'chegada' && acao !== 'fotos')
      return erro(res, 400, 'acao_invalida', 'Ação desconhecida.');

    const r = await sql('select doc, versao from public.estado where id = 1');
    const dbInicial = (r.rows[0] || {}).doc || {};
    const versaoInicial = Number(r.rows[0] || {}).versao || 0;
    if(!tokenValido(dbInicial, b.token)) return erro(res, 401, 'token_invalido', 'Link inválido. Peça um novo link da vistoria no balcão.');

    if(acao === 'fotos') return await salvarFotos(res, b, agora);

    /* os id chegam como texto, vindos do atributo data-* do cartão: a
       procura compara por igual, servindo para id numérico quanto texto
       (o id real sai do documento, nunca do pedido) */
    const emLote = Array.isArray(b.itens);
    const crudos = emLote ? b.itens : [b];
    if(!emLote && (b.locacaoId == null || String(b.locacaoId).trim() === ''))
      return erro(res, 400, 'locacao_invalida', 'Informe a locação.');
    if(emLote && !crudos.length) return erro(res, 400, 'lote_vazio', 'Nenhum veículo na comanda.');

    const loteId = String(b.lote || '').replace(/[^A-Za-z0-9_-]/g, '') ||
      ('d' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36));
    const itens = crudos.slice(0, ITENS_POR_LOTE).map(c => ({
      locId: c.locacaoId,
      veiculo: c.veiculo,
      fotosBrutas: Array.isArray(c.fotos) ? c.fotos.filter(Boolean).slice(0, FOTOS_POR_ITEM) : [],
      obs: c.obs,
      estado: acao === 'chegada' ? (c.estado === 'manutencao' ? 'manutencao' : 'loja') : null,
      lote: loteId
    }));

    const exigirFoto = dbInicial.config ? dbInicial.config.exigirFoto !== false : true;

    /* O relógio do lote vem do celular no instante do botão: reduz o
       escorrego da cronometragem quando a comanda sobe em vários POSTs.
       Só vale dentro da janela — relógio torto demais cai no horário do
       servidor, como sempre. */
    const pedida = Number(b.loteHora);
    const horaBase = emLote && isFinite(pedida) && agora - pedida >= 0 && agora - pedida <= JANELA_LOTE_MS
      ? pedida : agora;

    /* fotos primeiro: staging fora do documento, sem lock */
    await prepararFotos(itens, agora);

    /* conferência contra o snapshot da leitura — cada falha vira
       resultado por item em vez de derrubar a comanda inteira */
    const resultados = [];
    const aplicaveis = [];
    for(const it of itens){
      if(it.locId == null || String(it.locId).trim() === ''){
        resultados.push({ locacaoId: String(it.locId == null ? '' : it.locId), ok: false,
                          erro: 'locacao_invalida', mensagem: msgDe('locacao_nao_encontrada') });
        continue;
      }
      const c = conferirItem(dbInicial, it, acao, exigirFoto);
      if(c.erro){
        resultados.push({ locacaoId: String(it.locId), ok: false, erro: c.erro, mensagem: msgDe(c.erro) });
        continue;
      }
      it.loc = c.loc; it.lido = c.lido;
      aplicaveis.push(it);
    }

    if(!aplicaveis.length)
      return json(res, 200, { ok: false, resultados: resultados });

    const quem = 'vistoria (link)';
    const lock = await comLock(dbInicial, versaoInicial, db => {
      let aplicados = 0;
      for(const it of aplicaveis){ it.motivo = null; }
      for(const it of aplicaveis){
        const foi = aplicarItem(db, it, { loc: it.loc }, acao, horaBase, quem);
        if(foi === false){
          it.motivo = (acao === 'liberar' && it.loc.status === 'ativa') ? 'ja_liberada'
            : (acao === 'chegada' && it.loc.status === 'devolvida') ? 'ja_devolvida' : 'veiculo_indisponivel';
        } else { aplicados++; }
      }
      /* nada valeu a gravação: nem versiona o documento */
      if(!aplicados) return false;
    });

    for(const it of aplicaveis){
      if(lock.ok && !it.motivo)
        resultados.push({ locacaoId: String(it.locId), ok: true });
      else {
        const erroItem = it.motivo || 'conflito';
        resultados.push({ locacaoId: String(it.locId), ok: false, erro: erroItem, mensagem: msgDe(erroItem) });
      }
    }

    if(!lock.ok){
      if(lock.inviavel)
        return json(res, 409, { ok: false, resultados: resultados,
          erro: 'veiculo_indisponivel',
          mensagem: 'A unidade escaneada deixou de estar livre. Escolha outra unidade pronta do modelo reservado.' });
      return json(res, 409, { ok: false, resultados: resultados, erro: 'conflito',
        mensagem: 'Outro aparelho salvou ao mesmo tempo. Atualize a tela e tente de novo.' });
    }

    /* resposta mínima: a fila o celular já busca à parte — não relê o
       documento inteiro só para fechar a resposta */
    return json(res, 200, { ok: true, lote: loteId, resultados: resultados });
  });
};
