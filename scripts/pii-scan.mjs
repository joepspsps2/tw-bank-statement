// 個資掃描：推上 GitHub、發布 npm 前自動跑（npm test 的最後一步、GitHub Actions）。
// 抓三種東西，抓到就失敗：① 8 碼以上的數字串（帳號、電號…）② 檢查碼合法的統編 ③ 檢查碼合法的身分證／居留證號。
// 確定是假的值寫進 scripts/pii-allow.json 並寫原因。這個套件的測試只准用假資料。
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dirname, '..');
const allowFile = join(root, 'scripts', 'pii-allow.json');
const allow = new Set(Object.keys(existsSync(allowFile) ? JSON.parse(readFileSync(allowFile, 'utf8')).values : {}));
const SKIP = new Set(['node_modules', 'dist', '.git']);

function files(dir) {
  return readdirSync(dir).flatMap((n) => {
    if (SKIP.has(n)) return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  }).filter((p) => /\.(ts|mjs|js|json|csv|md|ya?ml|txt|html)$/.test(p) && !p.endsWith('package-lock.json') && p !== allowFile);
}

/** 明顯是假的：去掉前面的 0 之後是全 0、同一個數字重複、或 123456789… 這種連號 */
function looksFake(v) {
  const s = v.replace(/^0+/, '');
  if (s === '' || /^(\d)\1+$/.test(s)) return true;
  return '12345678901234567890'.includes(s) || '98765432109876543210'.includes(s);
}
function isTaxId(v) {
  if (!/^\d{8}$/.test(v)) return false;
  const w = [1, 2, 1, 2, 1, 2, 4, 1];
  let sum = 0;
  for (let i = 0; i < 8; i++) { const p = Number(v[i]) * w[i]; sum += Math.floor(p / 10) + (p % 10); }
  return sum % 5 === 0 || (v[6] === '7' && (sum + 1) % 5 === 0);
}
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVXYWZIO';
function isNationalId(v) {
  if (!/^[A-Z][1289ABCD]\d{8}$/.test(v)) return false;
  const n = LETTERS.indexOf(v[0]) + 10;
  const d2 = /[A-D]/.test(v[1]) ? (LETTERS.indexOf(v[1]) + 10) % 10 : Number(v[1]);
  const ds = [Math.floor(n / 10), n % 10, d2, ...v.slice(2).split('').map(Number)];
  const w = [1, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1];
  return ds.reduce((a, d, i) => a + d * w[i], 0) % 10 === 0;
}

const found = [];
for (const f of files(root)) {
  readFileSync(f, 'utf8').split('\n').forEach((raw, i) => {
    const line = raw.normalize('NFKC');
    const hit = (kind, v) => found.push(`${relative(root, f)}:${i + 1}  ${kind}  ${v.slice(0, 2)}＊＊＊＊${v.slice(-2)}`);
    for (const m of line.matchAll(/(?<![0-9A-Za-z])\d{8,}(?!\d)/g)) {
      const v = m[0];
      if (allow.has(v)) continue;
      if (v.length === 8 && isTaxId(v) && !/^(\d)\1{7}$/.test(v)) hit('統編（檢查碼合法）', v);
      else if (!looksFake(v)) hit('長數字（像帳號）', v);
    }
    for (const m of line.matchAll(/(?<![A-Za-z0-9])[A-Z][1289ABCD]\d{8}(?!\d)/g)) if (!allow.has(m[0]) && isNationalId(m[0])) hit('身分證／居留證號', m[0]);
  });
}
if (found.length) {
  console.error(`個資掃描：抓到 ${found.length} 處，不能推上去：\n  ${found.join('\n  ')}\n確定是假資料的話，把值加進 scripts/pii-allow.json 並寫原因。`);
  process.exit(1);
}
console.log('個資掃描：通過');
