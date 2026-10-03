/* POST /api/login — abre sessão com e-mail + senha.

   Dois caminhos, na mesma tela:
   1. a conta da loja (LOJA_EMAIL / LOJA_SENHA do projeto) — é o
      administrador de fábrica;
   2. qualquer usuário cadastrado em Usuários, conferido contra o
      salt + hash gravados no documento.

   A conta bloqueada (ativo = false) não entra por nenhum dos dois. */
const { json, erro, metodoInvalido, corpo } = require('../lib/http');
const { temBanco, sql } = require('../lib/banco');
const { conferirCredenciais, credenciaisConfiguradas, criarToken, temSegredo,
        conferirUsuario, usuarioNoDoc, temUsuarios, papelSeguro,
        emailNormalizado, VALIDADE_HORAS } = require('../lib/auth');
const { seguro } = require('../lib/tratar');

async function documento(){
  const r = await sql('select doc from public.estado where id = 1');
  return (r.rows[0] && r.rows[0].doc) || {};
}

module.exports = async (req, res) => {
  if(req.method !== 'POST') return metodoInvalido(res, ['POST']);

  if(!temSegredo()) return erro(res, 503, 'segredo_nao_configurado',
    'Defina AUTH_SECRET no projeto da Vercel (Settings → Environment Variables).');
  if(!temBanco()) return erro(res, 503, 'banco_nao_configurado',
    'POSTGRES_URL não definida. Conecte o Postgres no painel da Vercel.');

  return seguro(res, async () => {
    const b = corpo(req);
    const email = emailNormalizado(b.email);
    const senha = String(b.senha == null ? '' : b.senha);

    if(!email || !senha)
      return erro(res, 400, 'credenciais_ausentes', 'Informe e-mail e senha.');

    const doc = await documento();
    const u = usuarioNoDoc(doc, email);
    if(u && u.ativo === false)
      return erro(res, 401, 'conta_bloqueada', 'Esta conta está bloqueada. Fale com o administrador.');

    let quem = null;

    if(credenciaisConfiguradas()){
      const env = conferirCredenciais(email, senha);
      if(env.ok) quem = { email: emailNormalizado(env.email), papel: u ? papelSeguro(u.papel) : 'administrador',
                          nome: (u && u.nome) || emailNormalizado(env.email) };
    }
    if(!quem && u){
      const c = conferirUsuario(doc, email, senha);
      if(c.ok) quem = c;
    }

    if(!quem){
      if(!credenciaisConfiguradas() && !temUsuarios(doc))
        return erro(res, 503, 'loja_nao_configurada', 'Defina LOJA_EMAIL e LOJA_SENHA no projeto da Vercel.');
      return erro(res, 401, 'credenciais_invalidas', 'E-mail ou senha incorretos.');
    }

    const token = criarToken(quem.email, VALIDADE_HORAS);
    return json(res, 200, { ok: true, token, validaHoras: VALIDADE_HORAS,
      usuario: { email: quem.email, papel: quem.papel, nome: quem.nome || quem.email } });
  });
};
