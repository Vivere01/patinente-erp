/* GET /api/status — a aplicação usa para saber se o banco está pronto. */
const { json, metodoInvalido } = require('../lib/http');
const { temBanco } = require('../lib/banco');
const { temSegredo, credenciaisConfiguradas } = require('../lib/auth');

module.exports = async (req, res) => {
  if(req.method !== 'GET') return metodoInvalido(res, ['GET']);
  return json(res, 200, {
    ok: true,
    banco: temBanco(),
    login: temSegredo() && credenciaisConfiguradas(),
    sistema: 'patinente-erp'
  });
};
