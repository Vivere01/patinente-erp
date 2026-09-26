/* POST /api/assinaturas — o balcão publica o contrato para assinar no
   celular do cliente (passo 5 do wizard). Grava o texto CONGELADO: o que
   o cliente lê é exatamente o que vai para o contrato assinado.

   Se o token já foi assinado, nada é reescrito — o balcão recebe a
   assinatura já feita e a aplica na locação.
   ===================================================================== */
const { json, erro, metodoInvalido, corpo } = require('../lib/http');
const { temBanco, sql } = require('../lib/banco');
const { exigirSessao } = require('../lib/guardar');
const { seguro } = require('../lib/tratar');

function tokenValido(t){ return /^[A-Za-z0-9]{4,40}$/.test(String(t || '')); }

module.exports = async (req, res) => {
  if(req.method !== 'POST') return metodoInvalido(res, ['POST']);
  if(!temBanco()) return erro(res, 503, 'banco_nao_configurado', 'POSTGRES_URL não definida.');
  if(!exigirSessao(req, res)) return;

  return seguro(res, async () => {
    const b = corpo(req);
    const token = String(b.token || '').trim().toUpperCase();
    if(!tokenValido(token)) return erro(res, 400, 'token_invalido', 'Token de assinatura inválido.');
    if(!b.contrato || String(b.contrato).length < 50)
      return erro(res, 400, 'contrato_invalido', 'Texto do contrato ausente ou curto.');

    const cliente = b.cliente || {};
    const horas = Math.min(48, Math.max(1, Number(b.validadeHoras) || 6));

    const existe = await sql('select status, assinatura from public.assinaturas where token = $1', [token]);

    if(!existe.rows.length){
      await sql(`insert into public.assinaturas
                   (token, cliente_nome, cliente_cpf, contrato, resumo, empresa, expira_em)
                 values ($1,$2,$3,$4,$5,$6, now() + ($7 || ' hours')::interval)`,
        [token, String(cliente.nome || '').slice(0,160), String(cliente.cpf || '').slice(0,20),
         String(b.contrato), b.resumo ? JSON.stringify(b.resumo) : null,
         b.empresa ? JSON.stringify(b.empresa) : null, String(horas)]);
    }else if(existe.rows[0].status === 'pendente'){
      await sql(`update public.assinaturas
                    set cliente_nome=$2, cliente_cpf=$3, contrato=$4, resumo=$5, empresa=$6,
                        expira_em = now() + ($7 || ' hours')::interval, atualizado_em = now()
                  where token = $1`,
        [token, String(cliente.nome || '').slice(0,160), String(cliente.cpf || '').slice(0,20),
         String(b.contrato), b.resumo ? JSON.stringify(b.resumo) : null,
         b.empresa ? JSON.stringify(b.empresa) : null, String(horas)]);
    }

    const r = await sql('select status, assinado_em, expira_em from public.assinaturas where token = $1', [token]);
    const linha = r.rows[0];
    return json(res, 200, {
      ok: true, token,
      status: linha.status,
      assinada: linha.status === 'assinada',
      assinadoEm: linha.assinado_em ? new Date(linha.assinado_em).getTime() : null,
      expiraEm: new Date(linha.expira_em).getTime(),
      link: '/assinar/' + token
    });
  });
};
