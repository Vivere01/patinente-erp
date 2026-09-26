/* =====================================================================
   Conexão com o Postgres hospedado na Vercel.
   Uma pool por instância de função — o Postgres aceita conexões breves,
   então o pool é pequeno e com tempo de vida curto.
   ===================================================================== */
const { Pool } = require('pg');

let pool = null;

function urlBanco(){
  return process.env.POSTGRES_URL
      || process.env.POSTGRES_PRISMA_URL
      || process.env.POSTGRES_URL_NON_POOLING
      || process.env.DATABASE_URL
      || '';
}

/* Postgres gerenciado costuma vir com parâmetros de libpq que o driver
   Node não conhece (channel_binding) ou que aqui são tratados à parte
   (sslmode). Tira para não gerar erro de conexão. */
function limparUrl(url){
  try{
    const u = new URL(url);
    u.searchParams.delete('channel_binding');
    u.searchParams.delete('sslmode');
    return u.toString();
  }catch(e){ return url; }
}

function temBanco(){
  return !!urlBanco();
}

class ErroBanco extends Error {
  constructor(codigo, mensagem){
    super(mensagem || codigo);
    this.codigo = codigo;
  }
}

function conectar(){
  const url = urlBanco();
  if(!url) throw new ErroBanco('banco_nao_configurado', 'POSTGRES_URL não definida');
  if(!pool){
    const limpa = limparUrl(url);
    const local = /@(localhost|127\.0\.0\.1)/.test(limpa);
    pool = new Pool({
      connectionString: limpa,
      ssl: local ? false : { rejectUnauthorized: false },
      max: 1,
      idleTimeoutMillis: 20000,
      connectionTimeoutMillis: 12000
    });
    pool.on('error', ()=>{ pool = null; });
  }
  return pool;
}

async function sql(texto, params){
  const p = conectar();
  try{
    return await p.query(texto, params);
  }catch(e){
    if(e && e.code === 'ECONNREFUSED') throw new ErroBanco('banco_indisponivel', e.message);
    throw e;
  }
}

async function transacao(fn){
  const p = conectar();
  const cliente = await p.connect();
  try{
    await cliente.query('begin');
    const r = await fn(cliente);
    await cliente.query('commit');
    return r;
  }catch(e){
    try{ await cliente.query('rollback'); }catch(_){}
    throw e;
  }finally{
    cliente.release();
  }
}

module.exports = { sql, transacao, temBanco, urlBanco, limparUrl, ErroBanco };
