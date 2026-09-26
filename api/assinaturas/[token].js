/* Rota do cliente — abre em /assinar/{token} (rewrite no vercel.json).

   GET  → contrato congelado + situação (o balcão também usa para esperar)
   POST → grava a assinatura eletrônica feita no celular

   Autenticação: o próprio token. Ele é descartável, tem validade e não
   dá acesso a mais nada do sistema.
   ===================================================================== */
const { json, erro, metodoInvalido, corpo, cliente: ipDaReq, cabecalho } = require('../../lib/http');
const { temBanco, sql } = require('../../lib/banco');
const { seguro } = require('../../lib/tratar');

function tokenValido(t){ return /^[A-Za-z0-9]{4,40}$/.test(String(t || '')); }

function publicar(linha){
  return {
    ok: true,
    token: linha.token,
    status: linha.status,
    clienteNome: linha.cliente_nome || '',
    clienteCpf: linha.cliente_cpf || '',
    contrato: linha.contrato,
    resumo: linha.resumo || null,
    empresa: linha.empresa || null,
    expiraEm: new Date(linha.expira_em).getTime(),
    assinada: linha.status === 'assinada',
    assinadoEm: linha.assinado_em ? new Date(linha.assinado_em).getTime() : null,
    assinatura: linha.status === 'assinada' ? linha.assinatura : null
  };
}

module.exports = async (req, res) => {
  if(req.method !== 'GET' && req.method !== 'POST') return metodoInvalido(res, ['GET', 'POST']);
  if(!temBanco()) return erro(res, 503, 'banco_nao_configurado', 'Postgres ainda não conectado.');

  const token = String((req.query || {}).token || '').trim().toUpperCase();
  if(!tokenValido(token)) return erro(res, 400, 'token_invalido', 'Link de assinatura inválido.');

  return seguro(res, async () => {
    const r = await sql('select * from public.assinaturas where token = $1', [token]);
    if(!r.rows.length) return erro(res, 404, 'assinatura_nao_encontrada',
      'Este link não existe ou já foi removido. Peça um novo link na loja.');
    const linha = r.rows[0];

    if(req.method === 'GET'){
      if(new Date(linha.expira_em).getTime() < Date.now() && linha.status !== 'assinada')
        return json(res, 410, { ok:false, erro:'link_expirado',
          mensagem:'Este link expirou. Peça um novo link na loja.' });
      return json(res, 200, publicar(linha));
    }

    /* POST — assinar */
    if(linha.status === 'assinada')
      return json(res, 200, publicar(linha));
    if(new Date(linha.expira_em).getTime() < Date.now())
      return erro(res, 410, 'link_expirado', 'Este link expirou. Peça um novo link na loja.');

    const b = corpo(req);
    const assinatura = String(b.assinatura || '');
    if(!/^data:image\/(png|jpeg);base64,/.test(assinatura) || assinatura.length > 400000)
      return erro(res, 400, 'assinatura_invalida', 'Assinatura inválida.');
    if(b.aceite !== true && b.aceite !== 'true')
      return erro(res, 400, 'aceite_obrigatorio', 'É preciso aceitar o contrato antes de assinar.');

    await sql(`update public.assinaturas
                  set status='assinada', assinatura=$2, canal=$3, assinado_em=now(),
                      ip=$4, agente=$5, atualizado_em=now()
                where token=$1 and status='pendente'`,
      [token, assinatura, String(b.canal || 'celular').slice(0,20),
       String(ipDaReq(req)).slice(0,60), String(cabecalho(req,'user-agent')||'').slice(0,300)]);

    const dep = await sql('select * from public.assinaturas where token = $1', [token]);
    return json(res, 200, publicar(dep.rows[0]));
  });
};
