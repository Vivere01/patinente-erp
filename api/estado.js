/* GET  /api/estado            → { ok, versao, doc }   carrega a operação
   GET  /api/estado?versao=1   → { ok, versao }        só a versão (sondagem)
   POST /api/estado            → grava com lock otimista e devolve o resultado

   O banco recusa a gravação se outro aparelho salvou antes (versão
   divergente) e devolve o estado novo: a aplicação recarrega em vez de
   sobrescrever. Nada é perdido silenciosamente.
   ===================================================================== */
const { json, erro, metodoInvalido, corpo } = require('../lib/http');
const { temBanco, sql } = require('../lib/banco');
const { exigirSessao } = require('../lib/guardar');
const { seguro } = require('../lib/tratar');

function exigirBanco(res){
  if(temBanco()) return true;
  erro(res, 503, 'banco_nao_configurado', 'POSTGRES_URL não definida. Conecte o Postgres no painel da Vercel.');
  return false;
}

module.exports = async (req, res) => {
  if(req.method !== 'GET' && req.method !== 'POST') return metodoInvalido(res, ['GET', 'POST']);
  if(!exigirBanco(res)) return;
  if(!exigirSessao(req, res)) return;

  return seguro(res, async () => {
    if(req.method === 'GET'){
      const soVersao = String((req.query || {}).versao || '') === '1';
      if(soVersao){
        const r = await sql('select versao from public.estado where id = 1');
        return json(res, 200, { ok: true, versao: Number(r.rows[0].versao) });
      }
      const r = await sql('select doc, versao from public.estado where id = 1');
      const linha = r.rows[0] || { doc: {}, versao: 0 };
      return json(res, 200, { ok: true, versao: Number(linha.versao), doc: linha.doc || {} });
    }

    const b = corpo(req);
    if(!b.doc || typeof b.doc !== 'object' || Array.isArray(b.doc))
      return erro(res, 400, 'documento_invalido', 'Envie o documento em "doc".');
    if(!isFinite(Number(b.versao)))
      return erro(res, 400, 'versao_invalida', 'Envie a versão atual em "versao".');

    const por = b.por || null;
    const r = await sql('select ok, versao, doc from public.salvar_estado($1, $2, $3)',
      [JSON.stringify(b.doc), Number(b.versao), String(por || '').slice(0, 120)]);
    const linha = r.rows[0] || {};
    return json(res, Number(linha.ok) === 1 || linha.ok === true ? 200 : 409, {
      ok: linha.ok === true || Number(linha.ok) === 1,
      versao: Number(linha.versao),
      doc: linha.doc || b.doc
    });
  });
};
