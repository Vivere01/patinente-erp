/* POST /api/login — abre a sessão da loja (email + senha do projeto). */
const { json, erro, metodoInvalido, corpo } = require('../lib/http');
const { temBanco } = require('../lib/banco');
const { conferirCredenciais, criarToken, temSegredo, VALIDADE_HORAS } = require('../lib/auth');

module.exports = async (req, res) => {
  if(req.method !== 'POST') return metodoInvalido(res, ['POST']);

  if(!temSegredo()) return erro(res, 503, 'segredo_nao_configurado',
    'Defina AUTH_SECRET no projeto da Vercel (Settings → Environment Variables).');
  if(!temBanco()) return erro(res, 503, 'banco_nao_configurado',
    'POSTGRES_URL não definida. Conecte o Postgres no painel da Vercel.');

  const b = corpo(req);
  const r = conferirCredenciais(b.email, b.senha);

  if(!r.ok){
    const status = r.codigo === 'loja_nao_configurada' ? 503 : 401;
    const msg = r.codigo === 'loja_nao_configurada'
      ? 'Defina LOJA_EMAIL e LOJA_SENHA no projeto da Vercel.'
      : 'E-mail ou senha incorretos.';
    return erro(res, status, r.codigo, msg);
  }

  const token = criarToken(r.email, VALIDADE_HORAS);
  return json(res, 200, { ok: true, token, validaHoras: VALIDADE_HORAS });
};
