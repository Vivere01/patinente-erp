/* Fotografias de vistoria.

   POST /api/fotos                    (sessão) grava e devolve URL assinada
   GET  /api/fotos?caminho=...        (sessão) devolve URL assinada nova
   GET  /api/fotos?caminho=...&exp&sig            serve a imagem

   A URL vale 6 horas e é assinada com HMAC: sem a sessão do balcão não
   há como fabricar um link novo, e a imagem não fica exposta em disco
   aberto. Compressão já vem feita no cliente (~50 KB por foto).
   ===================================================================== */
const { json, erro, metodoInvalido, corpo } = require('../lib/http');
const { temBanco, sql } = require('../lib/banco');
const { exigirSessao } = require('../lib/guardar');
const { assinarUrl, conferirUrl } = require('../lib/auth');
const { seguro } = require('../lib/tratar');

const VALIDADE_MS = 6 * 3600000;
const TAMANHO_MAX = 600 * 1024;

function decodificar(dataUrl){
  const s = String(dataUrl || '');
  const i = s.indexOf('base64,');
  const bruto = i >= 0 ? s.slice(i + 7) : s;
  const buf = Buffer.from(bruto, 'base64');
  if(!buf.length) return null;
  return buf;
}

function caminhoValido(c){
  return /^[A-Za-z0-9._\-\/]{1,180}$/.test(String(c || ''));
}

module.exports = async (req, res) => {
  if(req.method !== 'GET' && req.method !== 'POST') return metodoInvalido(res, ['GET', 'POST']);
  if(!temBanco()) return erro(res, 503, 'banco_nao_configurado', 'POSTGRES_URL não definida.');

  const q = req.query || {};

  /* --- leitura pública com link assinado --- */
  if(req.method === 'GET' && q.sig && q.exp){
    const caminho = String(q.caminho || '');
    if(!caminhoValido(caminho)) return erro(res, 400, 'caminho_invalido', 'Caminho inválido.');
    if(!conferirUrl(caminho, q.exp, q.sig)) return erro(res, 403, 'link_invalido', 'Link expirado ou inválido.');

    return seguro(res, async () => {
      const r = await sql('select mime, bytes from public.fotos where caminho = $1', [caminho]);
      if(!r.rows.length) return erro(res, 404, 'foto_nao_encontrada', 'Imagem não encontrada.');
      const buf = r.rows[0].bytes;
      res.statusCode = 200;
      res.setHeader('Content-Type', r.rows[0].mime || 'image/jpeg');
      res.setHeader('Content-Length', buf.length);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.end(buf);
    });
  }

  if(!exigirSessao(req, res)) return;

  /* --- gravar --- */
  if(req.method === 'POST'){
    const b = corpo(req);
    const caminho = String(b.caminho || '').slice(0, 180);
    if(!caminhoValido(caminho)) return erro(res, 400, 'caminho_invalido', 'Caminho inválido.');
    const bytes = decodificar(b.dataUrl);
    if(!bytes) return erro(res, 400, 'imagem_invalida', 'Imagem inválida.');
    if(bytes.length > TAMANHO_MAX) return erro(res, 413, 'imagem_grande_demais', 'Imagem acima de 600 KB.');

    return seguro(res, async () => {
      const mime = /^data:([a-zA-Z0-9.+/-]+);base64,/.exec(String(b.dataUrl || ''));
      await sql(`insert into public.fotos (caminho, mime, bytes, tamanho)
                 values ($1, $2, $3, $4)
                 on conflict (caminho) do update set bytes = excluded.bytes,
                                                     mime = excluded.mime,
                                                     tamanho = excluded.tamanho`,
        [caminho, (mime && mime[1]) || 'image/jpeg', bytes, bytes.length]);
      const { exp, sig } = assinarUrl(caminho, VALIDADE_MS);
      return json(res, 200, { ok: true, caminho, exp, sig,
        url: '/api/fotos?caminho=' + encodeURIComponent(caminho) + '&exp=' + exp + '&sig=' + sig });
    });
  }

  /* --- link novo para exibição --- */
  const caminho = String(q.caminho || '').slice(0, 180);
  if(!caminhoValido(caminho)) return erro(res, 400, 'caminho_invalido', 'Informe o caminho em "caminho".');
  return seguro(res, async () => {
    const r = await sql('select 1 from public.fotos where caminho = $1', [caminho]);
    if(!r.rows.length) return erro(res, 404, 'foto_nao_encontrada', 'Imagem não encontrada.');
    const { exp, sig } = assinarUrl(caminho, VALIDADE_MS);
    return json(res, 200, { ok: true, caminho, exp, sig,
      url: '/api/fotos?caminho=' + encodeURIComponent(caminho) + '&exp=' + exp + '&sig=' + sig });
  });
};
