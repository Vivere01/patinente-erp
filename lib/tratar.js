/* Embute as rotas para tratar erro de banco e erro inesperado sempre
   do mesmo jeito: 503 quando o Postgres não está acessível, 500 no resto. */
const { erro } = require('./http');
const { ErroBanco } = require('./banco');

async function seguro(res, fn){
  try{
    return await fn();
  }catch(e){
    console.error('[api]', e && e.stack ? e.stack : e);
    if(e instanceof ErroBanco || (e && e.codigo === 'banco_nao_configurado')){
      return erro(res, 503, e.codigo || 'banco_indisponivel',
        'Banco de dados indisponível. Verifique POSTGRES_URL e o estado do resource na Vercel.');
    }
    return erro(res, 500, 'erro_interno', String(e && e.message ? e.message : e));
  }
}

module.exports = { seguro };
