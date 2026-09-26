/* Gera lib/schema-sql.js a partir de schema.sql.
   Motivo: o arquivo .sql não vai para o deploy (.vercelignore), então a
   função de manutenção carrega o SQL de um módulo JS. Fonte única.

   Uso: npm run schema:sync   (o npm test confere se estão em dia)
*/
const fs = require('fs');
const path = require('path');

const origem = path.join(__dirname, '..', 'schema.sql');
const destino = path.join(__dirname, '..', 'lib', 'schema-sql.js');

const sql = fs.readFileSync(origem, 'utf8');
if(/`/.test(sql)) throw new Error('schema.sql contém crase: não dá para embutir em template literal.');

const conteudo =
`/* GERADO por scripts/gerar-schema.js a partir de schema.sql — não edite à mão.
   Rode \`npm run schema:sync\` depois de alterar o schema. */
module.exports = \`${sql}\`;
`;

fs.writeFileSync(destino, conteudo, 'utf8');
console.log('  ✓ lib/schema-sql.js atualizado (' + sql.length + ' caracteres)');
