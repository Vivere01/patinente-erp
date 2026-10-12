/* GET /api/status — a aplicação usa para saber se o banco está pronto. */
const { json, metodoInvalido } = require('../lib/http');
const { temBanco } = require('../lib/banco');
const { temSegredo, credenciaisConfiguradas } = require('../lib/auth');

/* Carimbo do banco (só hospedagem e nome, sem usuário nem senha): o balcão
   compara com o que o celular mostra em /api/status para ter certeza de que
   os dois falam com o mesmo banco — balcão e celular em endereços diferentes
   com bancos diferentes é o "link inválido" que nunca sincroniza. */
function idDoBanco(){
  const u = process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL
    || process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL || '';
  try{
    const p = new URL(u);
    if(!p.hostname) return null;
    const nome = String(p.pathname || '').replace(/\/+$/, '');
    return (p.hostname + (nome && nome !== '/' ? nome : '')).slice(0, 120) || null;
  }catch(e){ return null; }
}

module.exports = async (req, res) => {
  if(req.method !== 'GET') return metodoInvalido(res, ['GET']);
  return json(res, 200, {
    ok: true,
    banco: temBanco(),
    bancoId: idDoBanco(),
    login: temSegredo() && credenciaisConfiguradas(),
    sistema: 'patinente-erp'
  });
};
module.exports.idDoBanco = idDoBanco;
