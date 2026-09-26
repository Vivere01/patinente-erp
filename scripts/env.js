/* Lê .env.local / .env para rodar os scripts fora da Vercel.
   No ambiente da Vercel as variáveis já vêm prontas. */
const fs = require('fs');
const path = require('path');

function ler(arquivo){
  const p = path.join(__dirname, '..', arquivo);
  if(!fs.existsSync(p)) return;
  const texto = fs.readFileSync(p, 'utf8');
  texto.split(/\r?\n/).forEach(linha => {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(linha);
    if(!m) return;
    let valor = m[2];
    if(/^".*"$/.test(valor) || /^'.*'$/.test(valor)) valor = valor.slice(1, -1);
    if(process.env[m[1]] === undefined) process.env[m[1]] = valor;
  });
}

module.exports = function carregar(){
  ler('.env.local');
  ler('.env');
  return process.env;
};
