/* GET /api/sessao — confirma se o token do aparelho ainda é válido. */
const { json, erro, metodoInvalido } = require('../lib/http');
const { sessaoDe, temSegredo } = require('../lib/auth');
const { temBanco } = require('../lib/banco');

module.exports = async (req, res) => {
  if(req.method !== 'GET') return metodoInvalido(res, ['GET']);
  if(!temSegredo()) return erro(res, 503, 'segredo_nao_configurado', 'AUTH_SECRET não definida.');
  if(!temBanco()) return erro(res, 503, 'banco_nao_configurado', 'POSTGRES_URL não definida.');

  const s = sessaoDe(req);
  if(!s) return erro(res, 401, 'sessao_invalida', 'Sessão expirada ou inválida.');
  return json(res, 200, { ok: true, email: s.e, expiraEm: s.exp });
};
