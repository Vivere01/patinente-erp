/* Aplica schema.sql no Postgres configurado. Idempotente: pode rodar
   quantas vezes quiser — nada é apagado nem duplicado.

   Uso:
     vercel env pull .env.local    (ou exporte POSTGRES_URL)
     npm run schema
*/
require('./env')();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const url = process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL ||
           process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL;

if(!url){
  console.error('\n  ✗ POSTGRES_URL não encontrada.');
  console.error('    Conecte o Postgres no painel da Vercel (Storage → Marketplace)');
  console.error('    e rode `vercel env pull .env.local` antes deste comando.\n');
  process.exit(1);
}

(async () => {
  const pool = new Pool({
    connectionString: url,
    ssl: /@(localhost|127\.0\.0\.1)/.test(url) ? false : { rejectUnauthorized: false }
  });
  try{
    const arquivo = path.join(__dirname, '..', 'schema.sql');
    const sql = fs.readFileSync(arquivo, 'utf8');
    const cliente = await pool.connect();
    try{
      await cliente.query('begin');
      await cliente.query(sql);
      await cliente.query('commit');
    }catch(e){
      await cliente.query('rollback');
      throw e;
    }finally{
      cliente.release();
    }

    const checar = await pool.query(
      "select (select count(*) from information_schema.tables where table_schema='public') as tabelas," +
      "       (select count(*) from public.estado) as estado," +
      "       (select count(*) from information_schema.routines where routine_schema='public' and routine_name='salvar_estado') as funcoes");
    const l = checar.rows[0];
    console.log('\n  ✓ Schema aplicado em ' + new URL(url).host);
    console.log('    tabelas: ' + l.tabelas + ' · linhas em estado: ' + l.estado + ' · função salvar_estado: ' + (Number(l.funcoes) > 0 ? 'ok' : 'AUSENTE'));
    console.log('    Pronto. Rode `npm test` para validar as regras de concorrência.\n');
  }catch(e){
    console.error('\n  ✗ Erro ao aplicar o schema:');
    console.error('   ', e.message, '\n');
    process.exit(1);
  }finally{
    await pool.end();
  }
})();
