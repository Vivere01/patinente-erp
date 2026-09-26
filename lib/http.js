/* =====================================================================
   Respostas, corpo da requisição e utilidades HTTP das funções da Vercel.
   ===================================================================== */
function json(res, status, corpo){
  const texto = JSON.stringify(corpo === undefined ? null : corpo);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(texto);
  return corpo;
}

function erro(res, status, codigo, mensagem, extra){
  return json(res, status, Object.assign({ erro: codigo, mensagem: mensagem || codigo }, extra || {}));
}

function metodoInvalido(res, aceitos){
  res.setHeader('Allow', aceitos.join(', '));
  return erro(res, 405, 'metodo_nao_permitido', 'Método não permitido. Use: ' + aceitos.join(', '));
}

/* O corpo já vem interpretado pela Vercel quando é JSON; cobre o resto. */
function corpo(req){
  if(req.body && typeof req.body === 'object') return req.body;
  const bruto = typeof req.body === 'string' ? req.body : (req.rawBody || '');
  if(!bruto) return {};
  try{ return JSON.parse(bruto); }catch(e){ return {}; }
}

function cabecalho(req, nome){
  const h = req.headers || {};
  const alvo = String(nome).toLowerCase();
  for(const k in h){ if(k.toLowerCase() === alvo) return h[k]; }
  return undefined;
}

function cliente(req){
  const xff = cabecalho(req, 'x-forwarded-for');
  if(xff) return String(xff).split(',')[0].trim();
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'desconhecido';
}

module.exports = { json, erro, metodoInvalido, corpo, cabecalho, cliente };
