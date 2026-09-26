/* POST /api/admin/banco — manutenção do Postgres hospedado na Vercel.

   { acao: 'aplicar' }   aplica schema.sql (idempotente, nada apaga)
   { acao: 'conferir' }  roda as regras do banco numa transação que é
                         DESCARTADA ao final — não deixa dado para trás
   { acao: 'limpar' }    apaga só artefatos de verificação
                         (fotos em instalacao/ e assinaturas TESTE%)

   Exige sessão válida: o token é assinado com AUTH_SECRET, que existe
   apenas do lado do servidor. Nenhum texto da requisição entra na
   consulta — o SQL é constante, vinda de lib/schema-sql.js.
   ===================================================================== */
const { json, erro, metodoInvalido, corpo } = require('../../lib/http');
const { temBanco, sql, transacao } = require('../../lib/banco');
const { exigirSessao } = require('../../lib/guardar');
const { seguro } = require('../../lib/tratar');
const SCHEMA = require('../../lib/schema-sql');

const CONHECIDAS = ['aplicar', 'conferir', 'limpar'];

/* Executa um passo isolado: se ele falhar, o banco volta ao savepoint
   e o resto do teste continua. O Postgres aborta a transação inteira
   após um erro, então sem savepoint um passo falho derrubaria todos. */
async function passo(c, nome, fn){
  await c.query('savepoint ' + nome);
  try{
    const r = await fn();
    await c.query('release savepoint ' + nome);
    return { ok: true, r: r };
  }catch(e){
    try{ await c.query('rollback to savepoint ' + nome); }catch(_){}
    return { ok: false, erro: String(e && e.message ? e.message : e) };
  }
}

async function aplicar(){
  await sql(SCHEMA);
  const r = await sql(
    "select (select count(*) from information_schema.tables where table_schema='public') as tabelas," +
    "       (select count(*) from public.estado) as estado," +
    "       (select count(*) from information_schema.routines where routine_schema='public' and routine_name='salvar_estado') as funcoes");
  const l = r.rows[0];
  return {
    ok: true, acao: 'aplicar',
    tabelas: Number(l.tabelas), linhas_estado: Number(l.estado),
    funcao_salvar_estado: Number(l.funcoes) > 0
  };
}

class Descartar extends Error {}

async function conferir(){
  const testes = [];
  const marcar = (nome, ok, detalhe) => testes.push({ nome: nome, ok: !!ok, detalhe: detalhe || '' });

  try{
    await transacao(async (c) => {
      /* lock otimista */
      const ini = await c.query('select versao from public.estado where id = 1');
      const v0 = Number((ini.rows[0] || {}).versao || 0);

      const a = await passo(c, 'aceita', () => c.query(
        'select ok, versao from public.salvar_estado($1,$2,$3)',
        [JSON.stringify({ teste: 'A', veiculos: [] }), v0, 'manutencao']));
      marcar('gravação com a versão correta é aceita', a.ok && (a.r.rows[0].ok === true || Number(a.r.rows[0].ok) === 1),
        a.ok ? '' : a.erro);

      const b = await passo(c, 'recusa', () => c.query(
        'select ok, versao, doc from public.salvar_estado($1,$2,$3)',
        [JSON.stringify({ teste: 'B', veiculos: [] }), v0, 'manutencao']));
      const recusado = b.ok && (b.r.rows[0].ok === false || Number(b.r.rows[0].ok) === 0);
      marcar('gravação com versão defasada é recusada', recusado, b.ok ? '' : b.erro);
      marcar('estado antigo preservado — nada foi sobrescrito',
        recusado && b.r.rows[0].doc && b.r.rows[0].doc.teste === 'A', '');

      const e = await c.query('select doc from public.estado where id = 1');
      marcar('banco continua com o documento A', e.rows[0].doc && e.rows[0].doc.teste === 'A', '');

      /* histórico imutável */
      const ev = await passo(c, 'insere_evento', () => c.query(
        "insert into public.eventos (usuario, acao, detalhe) values ('manutencao','conferencia','...') returning id"));
      marcar('evento registrado', ev.ok && !!ev.r.rows[0].id, ev.ok ? '' : ev.erro);

      const upd = await passo(c, 'upd_evento', () => c.query(
        'update public.eventos set acao = $1 where id = $2',
        ['hack', ev.ok ? ev.r.rows[0].id : -1]));
      marcar('UPDATE em eventos é recusado pelo banco', !upd.ok, upd.ok ? 'passou' : '');

      const del = await passo(c, 'del_evento', () => c.query(
        'delete from public.eventos where id = $1', [ev.ok ? ev.r.rows[0].id : -1]));
      marcar('DELETE em eventos é recusado pelo banco', !del.ok, del.ok ? 'passou' : '');

      /* fotos */
      const caminho = 'instalacao/conferencia-' + Date.now() + '.jpg';
      const bytes = Buffer.from('Zm90byBkZSBjb25mZXJlbmNpYQ==', 'base64');
      const f = await passo(c, 'fotos', async () => {
        await c.query('insert into public.fotos (caminho, mime, bytes, tamanho) values ($1,$2,$3,$4)',
          [caminho, 'image/jpeg', bytes, bytes.length]);
        return await c.query('select octet_length(bytes) as n from public.fotos where caminho = $1', [caminho]);
      });
      marcar('foto gravada e lida com o mesmo tamanho',
        f.ok && Number(f.r.rows[0].n) === bytes.length, f.ok ? '' : f.erro);

      /* assinatura */
      const token = 'TESTE' + Date.now().toString(36).toUpperCase();
      const as = await passo(c, 'assinatura', async () => {
        await c.query('insert into public.assinaturas (token, cliente_nome, contrato, resumo) values ($1,$2,$3,$4)',
          [token, 'Cliente de teste', 'Contrato de teste.',
           JSON.stringify({ total: 60 })]);
        await c.query("update public.assinaturas set status='assinada', assinatura=$2, assinado_em=now() where token=$1",
          [token, 'data:image/png;base64,AAAA']);
        return await c.query('select status, assinatura from public.assinaturas where token = $1', [token]);
      });
      marcar('assinatura gravada',
        as.ok && as.r.rows[0].status === 'assinada' && as.r.rows[0].assinatura === 'data:image/png;base64,AAAA',
        as.ok ? '' : as.erro);

      const snap = await c.query('select count(*) as n from public.snapshots');
      marcar('snapshots acessíveis', Number(snap.rows[0].n) >= 0, '');

      throw new Descartar();
    });
  }catch(e){
    if(!(e instanceof Descartar)){
      return { ok: false, acao: 'conferir', testes: testes, erro: String(e && e.message ? e.message : e) };
    }
  }

  return { ok: true, acao: 'conferir', testes: testes, descartado: true };
}

async function limpar(){
  const fotos = await sql("delete from public.fotos where caminho like 'instalacao/%'");
  const assin = await sql("delete from public.assinaturas where token like 'TESTE%'");
  return { ok: true, acao: 'limpar', fotos: fotos.rowCount, assinaturas: assin.rowCount };
}

module.exports = async (req, res) => {
  if(req.method !== 'POST') return metodoInvalido(res, ['POST']);
  if(!temBanco()){
    return erro(res, 503, 'banco_nao_configurado',
      'POSTGRES_URL não definida. Conecte o Postgres no painel da Vercel.');
  }
  if(!exigirSessao(req, res)) return;

  const acao = String((corpo(req) || {}).acao || '');
  if(CONHECIDAS.indexOf(acao) < 0){
    return erro(res, 400, 'acao_invalida', 'Use uma das ações: ' + CONHECIDAS.join(', '));
  }

  return seguro(res, async () => {
    const r = acao === 'aplicar' ? await aplicar()
            : acao === 'conferir' ? await conferir()
            : await limpar();
    return json(res, 200, r);
  });
};
