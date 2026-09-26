/* POST /api/eventos — histórico imutável. Toda operação vira uma linha;
   a tabela recusa UPDATE e DELETE no banco (gatilho), então a trilha
   permanece mesmo que alguém erre no estado atual.
   ===================================================================== */
const { json, erro, metodoInvalido, corpo } = require('../lib/http');
const { temBanco, sql } = require('../lib/banco');
const { exigirSessao } = require('../lib/guardar');
const { seguro } = require('../lib/tratar');

module.exports = async (req, res) => {
  if(req.method !== 'POST') return metodoInvalido(res, ['POST']);
  if(!temBanco()) return erro(res, 503, 'banco_nao_configurado', 'POSTGRES_URL não definida.');
  const sessao = exigirSessao(req, res);
  if(!sessao) return;

  return seguro(res, async () => {
    const b = corpo(req);
    const acao = String(b.acao || '').slice(0, 80);
    if(!acao) return erro(res, 400, 'acao_obrigatoria', 'Informe a ação em "acao".');

    const usuario = String(b.usuario || sessao.e || 'sistema').slice(0, 120);
    await sql('insert into public.eventos (usuario, acao, detalhe, payload) values ($1,$2,$3,$4)',
      [usuario, acao, String(b.detalhe || '').slice(0, 2000), b.payload ? JSON.stringify(b.payload) : null]);

    return json(res, 200, { ok: true });
  });
};
