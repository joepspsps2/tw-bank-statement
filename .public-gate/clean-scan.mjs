#!/usr/bin/env node
// public-gate clean-scan v0.2.0
// 正本在擁有者的私有工具庫（public-gate）；本檔由 new-public-repo.mjs 複製進各公開 repo，勿在公開 repo 手改，
// 要改請改正本再重新套用（巡店程式會比對版本有沒有落後）。
//
// 清潔掃描：公開 repo 與要發布出去的 npm 包裡，不准出現下面任何一種：
//   ① 鑰匙格式（GitHub／npm／Resend／Webhook／SMTP2GO／AWS／Google／Slack／私鑰）
//   ② 帳號編號：32 碼 hex（Cloudflare 帳號等）、UUID（資料庫編號等）
//   ③ 非範例網域的 email（example.com／.org／.net 與 config 的 publicEmails 以外都算）
//   ④ 台灣個資：8 碼以上像帳號的數字（含分段寫法、全形）、檢查碼合法的統編、身分證／居留證號
//   ⑤ 內部代號（私有套件 scope、待辦單號）
//   ⑥ config.json 的 extraPatterns（各 repo 自己加的正規表示式，本身不是祕密的樣式）
// 這裡只放「樣式」類規則，規則本身公開也無妨。擁有者另有一份不公開的名單（人名、公司名這類「詞」），
// 那份比對不在這個 repo 裡，由擁有者在推送前與定期巡檢時在私有端做。
//
// 用法：
//   node .public-gate/clean-scan.mjs            掃 git 追蹤的全部文字檔（沒有 git 就掃整個資料夾）
//   node .public-gate/clean-scan.mjs --pack     掃 `npm pack` 實際會發出去的檔（發布前用；先 build）
//   node .public-gate/clean-scan.mjs 檔案或資料夾…  只掃指定的
// 有命中就印出（值遮一半）並以 1 結束。只用 Node 內建模組。
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/* ---------- 規則 ---------- */

export const KEY_RULES = [
  ['GitHub 鑰匙', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['npm 鑰匙', /\bnpm_[A-Za-z0-9]{30,}\b/],
  ['Resend 鑰匙', /\bre_[A-Za-z0-9_]{20,}\b/],
  ['Webhook 簽章密碼', /\bwhsec_[A-Za-z0-9+/=]{16,}/],
  ['SMTP2GO 鑰匙', /\bapi-[A-F0-9]{20,}\b/],
  ['AWS 鑰匙', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['Google 鑰匙', /\bAIza[A-Za-z0-9_-]{35}\b/],
  ['Slack 鑰匙', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['OpenAI／Anthropic 鑰匙', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}/],
  ['私鑰', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];
export const INTERNAL_RULES = [
  ['內部代號（私有套件 scope）', /@joc\//],
  ['內部代號（待辦單號）', /\bKM#\d/i],
];
export const ID_RULES = [
  ['32 碼 hex（帳號編號）', /(?<![0-9A-Za-z])[0-9a-f]{32}(?![0-9A-Za-z])/g],
  ['UUID（資料庫編號等）', /(?<![0-9A-Za-z])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9A-Za-z])/gi],
];
const EMAIL_RE = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g;
const EXAMPLE_DOMAIN_RE = /(?:^|\.)example\.(?:com|org|net)$|(?:^|\.)(?:test|invalid|localhost)$|^users\.noreply\.github\.com$/i;

/* ---------- 台灣個資：檢查碼與「一看就是假的」 ---------- */

const TAX_WEIGHTS = [1, 2, 1, 2, 1, 2, 4, 1];
/** 統編檢查碼（2023 起：加權位數和被 5 整除；第 7 碼是 7 時兩種算法任一成立） */
export function isValidTaxId(v) {
  if (!/^\d{8}$/.test(v)) return false;
  const d = [...v].map(Number);
  const sum = d.reduce((a, x, i) => { const p = x * TAX_WEIGHTS[i]; return a + Math.floor(p / 10) + (p % 10); }, 0);
  return sum % 5 === 0 || (d[6] === 7 && (sum + 1) % 5 === 0);
}

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVXYWZIO'; // A=10 … O=35
/** 身分證（第 2 碼 1／2）、新式居留證（8／9）、舊式居留證（A–D）檢查碼 */
export function isValidNationalId(v) {
  if (!/^[A-Z][1289ABCD]\d{8}$/.test(v)) return false;
  const n = LETTERS.indexOf(v[0]) + 10;
  const d2 = /[A-D]/.test(v[1]) ? (LETTERS.indexOf(v[1]) + 10) % 10 : Number(v[1]);
  const ds = [Math.floor(n / 10), n % 10, d2, ...v.slice(2).split('').map(Number)];
  const w = [1, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1];
  return ds.reduce((a, d, i) => a + d * w[i], 0) % 10 === 0;
}

function isDateLike(s) {
  if (!/^(199\d|20\d\d)(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(\d{4}|\d{6})?$/.test(s)) return false;
  if (s.length === 8) return true;
  return Number(s.slice(8, 10)) < 24 && Number(s.slice(10, 12)) < 60;
}

/**
 * 一眼就是假的或不是個資：
 *   - 整數常數：去掉頭尾的 0 以後有效數字只剩 3 碼以下（全 0、1 後面一串 0 這類）
 *   - 中間有 5 個以上同數字連在一起（頭尾補的 0 不算——帳號常補 0 到固定長度，不能因為補 0 就當假的）
 *   - 6 碼以上順序數字、西元日期
 * 頭尾的 0 只用來判斷上面第一、二條，長度一律看完整的號碼：以 0 開頭或結尾的真號碼（手機、帳號）照抓。
 */
export function looksFake(s) {
  const core = s.replace(/^0+/, '').replace(/0+$/, '');
  if (core.length <= 3) return true;
  if (/(\d)\1{4}/.test(core)) return true;
  for (let i = 0; i + 6 <= s.length; i++) {
    let up = true, down = true;
    for (let j = 1; j < 6; j++) {
      const a = Number(s[i + j - 1]), b = Number(s[i + j]);
      if (b !== (a + 1) % 10) up = false;
      if (b !== (a + 9) % 10) down = false;
    }
    if (up || down) return true;
  }
  return isDateLike(s);
}

/* ---------- 設定 ---------- */

export function loadConfig(root) {
  const read = (f, fallback) => (existsSync(join(root, f)) ? JSON.parse(readFileSync(join(root, f), 'utf8')) : fallback);
  const cfg = read('.public-gate/config.json', {});
  return {
    exclude: cfg.exclude ?? [],
    denyExempt: new Set(Object.keys(cfg.denyExemptFiles ?? {})), // 擁有者私有端的名單比對用，這支不看
    allow: new Map(Object.entries(cfg.allow ?? {})),
    publicEmails: new Set((cfg.publicEmails ?? []).map((e) => e.toLowerCase())),
    extraPatterns: (cfg.extraPatterns ?? []).map((p) => [p.name ?? '自訂樣式', new RegExp(p.regex, p.flags ?? 'i')]),
  };
}

/* ---------- 掃一段文字 ---------- */

/** 印出來的值遮一半，免得掃描紀錄本身又把資料抄一次 */
export function mask(v) {
  const chars = [...v];
  if (chars.length <= 2) return chars[0] + '＊';
  const keep = Math.max(1, Math.floor(chars.length / 4));
  return chars.slice(0, keep).join('') + '＊'.repeat(chars.length - keep * 2) + chars.slice(-keep).join('');
}

const CONFIG_FILE = '.public-gate/config.json';

export function scanText(file, text, ctx) {
  const out = [];
  // 設定檔本身寫著自訂樣式與放行原因，不拿內部代號、自訂樣式比它自己（鑰匙、個資照掃；改它的外部 PR 會被進門檢查擋）
  const selfRules = file === CONFIG_FILE;
  const allowed = (v) => ctx.allow.has(v);
  text.split(/\r?\n/).forEach((raw, idx) => {
    const line = raw.normalize('NFKC'); // 全形數字、全形英文也要抓
    const hit = (rule, value) => out.push({ file, line: idx + 1, rule, value });
    for (const [name, re] of selfRules ? KEY_RULES : [...KEY_RULES, ...INTERNAL_RULES]) { const m = line.match(re); if (m) hit(name, m[0]); }
    for (const [name, re] of ID_RULES) for (const m of line.matchAll(re)) if (!allowed(m[0])) hit(name, m[0]);
    for (const m of line.matchAll(EMAIL_RE)) {
      if (EXAMPLE_DOMAIN_RE.test(m[1]) || ctx.publicEmails.has(m[0].toLowerCase()) || allowed(m[0])) continue;
      hit('非範例網域的 email', m[0]);
    }
    // 8 碼以上數字、統編
    for (const m of line.matchAll(/(?<![0-9A-Za-z])\d{8,}(?!\d)/g)) {
      const v = m[0];
      if (allowed(v)) continue;
      if (v.length === 8 && isValidTaxId(v) && !/^(\d)\1{7}$/.test(v)) hit('統編（檢查碼合法）', v);
      else if (!looksFake(v)) hit('8 碼以上數字（像帳號）', v);
    }
    // 分段寫的號碼（例：1234-567-890123、0912 345 678 這種寫法）
    for (const m of line.matchAll(/(?<![0-9A-Za-z])\d{2,}(?:[- ]\d{2,})+(?![0-9A-Za-z])/g)) {
      if (/\d{4}-\d{2}-\d{2}/.test(m[0])) continue; // 日期
      const v = m[0].replace(/\D/g, '');
      if (v.length < 10 || m[0].split(/[- ]/).some((g) => g.length >= 8)) continue;
      if (!allowed(v) && !allowed(m[0]) && !looksFake(v)) hit('8 碼以上數字（像帳號）', m[0]);
    }
    for (const m of line.matchAll(/(?<![0-9A-Za-z])[A-Z][1289ABCD]\d{8}(?!\d)/g)) {
      if (isValidNationalId(m[0]) && !allowed(m[0])) hit('身分證／居留證號', m[0]);
    }
    if (!selfRules) for (const [name, re] of ctx.extraPatterns) { const m = line.match(re); if (m) hit(name, m[0]); }
  });
  return out;
}

/* ---------- 選檔 ---------- */

const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']);
const toPosix = (p) => p.split(sep).join('/');

function isText(buf) {
  return !buf.subarray(0, 8000).includes(0);
}

function walk(root, dir, out) {
  for (const name of readdirSync(join(root, dir))) {
    if (name === '.git' || name === 'node_modules') continue;
    const rel = dir ? `${dir}/${name}` : name;
    if (statSync(join(root, rel)).isDirectory()) walk(root, rel, out);
    else out.push(rel);
  }
  return out;
}

export function listTracked(root) {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
  } catch {
    return walk(root, '', []);
  }
}

export function listPacked(root) {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  return JSON.parse(out)[0].files.map((f) => f.path);
}

export function scanFiles(root, files, ctx = loadConfig(root)) {
  const findings = [];
  let scanned = 0;
  for (const rel of files.map(toPosix)) {
    const base = rel.split('/').pop();
    if (LOCKFILES.has(base) || rel.includes('node_modules/')) continue;
    if (ctx.exclude.some((p) => rel === p || rel.startsWith(p.endsWith('/') ? p : `${p}/`))) continue;
    const abs = join(root, rel);
    if (!existsSync(abs) || statSync(abs).isDirectory()) continue;
    const buf = readFileSync(abs);
    if (!isText(buf)) continue;
    scanned++;
    findings.push(...scanText(rel, buf.toString('utf8'), ctx));
  }
  return { findings, scanned };
}

/* ---------- 主程式 ---------- */

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd();
  const args = process.argv.slice(2);
  let files;
  if (args.includes('--pack')) files = listPacked(root);
  else if (args.length) files = args.flatMap((p) => (existsSync(p) && statSync(p).isDirectory() ? walk(root, toPosix(relative(root, p)), []) : [toPosix(relative(root, p))]));
  else files = listTracked(root);
  const { findings, scanned } = scanFiles(root, files);
  const what = args.includes('--pack') ? 'npm 包' : 'repo';
  if (findings.length) {
    console.error(`清潔掃描（${what}）：${findings.length} 處命中，不能公開：`);
    for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.rule}  ${mask(f.value)}`);
    console.error('確定是假資料：把值寫進 .public-gate/config.json 的 allow 並寫原因（鑰匙放行不了）。');
    process.exit(1);
  }
  console.log(`清潔掃描（${what}）：${scanned} 個檔，0 命中。`);
}
