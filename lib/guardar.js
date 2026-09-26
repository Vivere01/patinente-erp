/* Guarda de sessão usada por todas as rotas internas do balcão. */
const { sessaoDe } = require('./auth');
const { erro } = require('./http');

function exigirSessao(req, res){
  const s = sessaoDe(req);
  if(!s){
    erro(res, 401, 'sessao_invalida', 'Faça login novamente.');
    return null;
  }
  return s;
}

module.exports = { exigirSessao };
