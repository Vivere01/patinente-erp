/* =====================================================================
   Login da loja e sessão.

   O token é um payload assinado com HMAC-SHA256 (sem estado no banco):
   o servidor precisa apenas do AUTH_SECRET para validar. O email e a
   senha da loja vêm das variáveis de ambiente do projeto da Vercel.
   ===================================================================== */
const crypto = require('crypto');
const { cabecalho } = require('./http');

const VALIDADE_HORAS = 12;

function segredo(){
  return process.env.AUTH_SECRET || '';
}

function temSegredo(){ return !!segredo(); }

function base64url(buffer){
  return Buffer.from(buffer).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}

function debase64url(texto){
  const t = String(texto).replace(/-/g,'+').replace(/_/g,'/');
  const pad = t.length % 4 ? '='.repeat(4 - (t.length % 4)) : '';
  return Buffer.from(t + pad, 'base64');
}

function hmac(texto){
  return base64url(crypto.createHmac('sha256', segredo()).update(String(texto)).digest());
}

function igual(a, b){
  const ba = Buffer.from(String(a||''), 'utf8');
  const bb = Buffer.from(String(b||''), 'utf8');
  if(ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/* --- credenciais da loja (variáveis de ambiente) --- */
function credenciaisConfiguradas(){
  return !!(process.env.LOJA_EMAIL && process.env.LOJA_SENHA);
}

function conferirCredenciais(email, senha){
  if(!credenciaisConfiguradas()) return { ok:false, codigo:'loja_nao_configurada' };
  if(!igual(email, process.env.LOJA_EMAIL) || !igual(senha, process.env.LOJA_SENHA))
    return { ok:false, codigo:'credenciais_invalidas' };
  return { ok:true, email: process.env.LOJA_EMAIL };
}

/* =====================================================================
   Senhas dos usuários cadastrados no sistema.

   Guardadas no documento como salt + hash PBKDF2-SHA256 (120 mil
   iterações). O navegador deriva a mesma chave com WebCrypto, então o
   servidor só precisa comparar — a senha em claro nunca é gravada.
   ===================================================================== */
const ITERACOES = 120000;

function emailNormalizado(e){
  return String(e == null ? '' : e).trim().toLowerCase();
}

function novoSalt(){
  return crypto.randomBytes(16).toString('hex');
}

function hashSenha(senha, salt){
  return crypto.pbkdf2Sync(String(senha == null ? '' : senha), Buffer.from(String(salt || ''), 'hex'),
    ITERACOES, 32, 'sha256').toString('hex');
}

function conferirHash(senha, salt, hash){
  if(!salt || !hash) return false;
  return igual(hashSenha(senha, salt), hash);
}

/* Papel: o sistema tem dois — administrador vê tudo e cria usuários,
   atendente opera o balcão sem mexer com dinheiro. */
function papelSeguro(p){
  return p === 'gerente' || p === 'administrador' || p === 'admin' ? 'administrador' : 'atendente';
}

/* Procura o usuário pelo e-mail, respeitando a situação dele. */
function usuarioNoDoc(doc, email){
  const alvo = emailNormalizado(email);
  if(!alvo || !doc || !Array.isArray(doc.usuarios)) return null;
  for(const u of doc.usuarios){
    if(u && emailNormalizado(u.email) === alvo) return u;
  }
  return null;
}

function temUsuarios(doc){
  return !!(doc && Array.isArray(doc.usuarios) && doc.usuarios.length);
}

/* Confere e-mail + senha contra o documento gravado no banco. */
function conferirUsuario(doc, email, senha){
  const u = usuarioNoDoc(doc, email);
  if(!u || u.ativo === false) return { ok:false, codigo:'credenciais_invalidas' };
  if(!conferirHash(senha, u.salt, u.hash)) return { ok:false, codigo:'credenciais_invalidas' };
  return { ok:true, email: emailNormalizado(email), papel: papelSeguro(u.papel),
           id: u.id, nome: u.nome || emailNormalizado(email) };
}

/* --- token de sessão --- */
function criarToken(email, horas){
  const p = { e: String(email), exp: Date.now() + (horas || VALIDADE_HORAS) * 3600000 };
  const carga = base64url(JSON.stringify(p));
  return carga + '.' + hmac(carga);
}

function lerToken(token){
  if(!temSegredo() || !token || String(token).indexOf('.') < 1) return null;
  const partes = String(token).split('.');
  const assinatura = hmac(partes[0]);
  const a = Buffer.from(assinatura);
  const b = Buffer.from(partes[1] || '');
  if(a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try{
    const p = JSON.parse(debase64url(partes[0]).toString('utf8'));
    if(!p || !p.e || !p.exp || p.exp < Date.now()) return null;
    return p;
  }catch(e){ return null; }
}

function tokenDaRequisicao(req){
  const h = cabecalho(req, 'authorization') || '';
  if(/^bearer /i.test(h)) return h.replace(/^bearer\s+/i,'').trim();
  return '';
}

/* Devolve o payload da sessão ou null. */
function sessaoDe(req){
  return lerToken(tokenDaRequisicao(req));
}

/* --- URL temporária assinada (fotos) --- */
function assinarUrl(caminho, validadeMs){
  const exp = Date.now() + (validadeMs || 6 * 3600000);
  return { exp, sig: hmac(caminho + '|' + exp) };
}

function conferirUrl(caminho, exp, sig){
  if(!temSegredo()) return false;
  if(!caminho || !exp || !sig) return false;
  const expNum = Number(exp);
  if(!isFinite(expNum) || expNum < Date.now()) return false;
  return igual(hmac(caminho + '|' + expNum), String(sig));
}

module.exports = {
  criarToken, lerToken, sessaoDe, tokenDaRequisicao,
  conferirCredenciais, credenciaisConfiguradas,
  hashSenha, conferirHash, novoSalt, papelSeguro,
  usuarioNoDoc, conferirUsuario, temUsuarios, emailNormalizado,
  assinarUrl, conferirUrl, temSegredo, VALIDADE_HORAS, ITERACOES
};
