#!/usr/bin/env node
// public-gate pr-gate v0.2.0
// 正本在擁有者的私有工具庫（public-gate）；勿在公開 repo 手改。
//
// 進門檢查（外人的 PR 動到敏感檔就等擁有者）：
//   - PR 作者是 repo 擁有者／成員／協作者 → 放行（測試與清潔掃描是另一支檢查）。
//   - 外人的 PR 沒動到敏感檔 → 放行（照 PR 審查清單審）。
//   - 外人的 PR 動到敏感檔（.github/、.public-gate/、package.json、lockfile、建置設定檔 tsconfig*.json／.npmrc／
//     .nvmrc／.npmignore、config 的 sensitivePaths、檔名像鑰匙／驗證／寄件）→ 失敗並貼 needs-owner-review 標籤。
//   - 檔案清單拿不完整（GitHub 的清單上限 3,000 個檔；或 PR 自己說動了 N 個、實際取到的數量對不上）
//     → 當作動到敏感檔處理：看不到的那些檔可能就是敏感檔。
//     放行條件：擁有者（或成員／協作者）在 GitHub 上對 **PR 目前最新的那個 commit** 按了 Approve（Review changes → Approve），
//     之後按這一格的 Re-run，或貼 owner-approved 標籤觸發重查。
//     核准綁在 commit 上：對方核准後再推新 commit，舊的 Approve 對新 commit 不算數，要重新審。
//     標籤只用來觸發重查與提示，不當核准憑證；PR 狀態、最新 commit、審查一律用 API 現查，不信事件裡的舊快照。
//     限制（照實講）：核准被撤回（Dismiss、改要求修改）時，舊的綠燈不會自己變紅——審查事件只能在 PR 的環境觸發，
//     外人改得掉，不可信。所以把關放在合併那一刻：能合併的只有擁有者／AI，合併外部 PR 前一律跑
//     `node .public-gate/pr-gate.mjs --pr <號碼>`（唯讀、現查最新 commit 與審查，不過就不合併；審查清單第 5 步）。
//
// 為什麼跑在 pull_request_target：規則要從「我們的 main」讀，不能用 PR 自己帶來的版本（不然對方改掉這支就過關）。
// 安全前提（workflow 範本已照做）：只 checkout 我們的 main、絕不 checkout 或執行 PR 的程式、不給任何 secret，
// 權限只有讀 PR、貼標籤。PR 動了哪些檔是用 GitHub API 問的，不碰 PR 的檔案內容。
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const APPROVE_LABEL = 'owner-approved';
export const WAIT_LABEL = 'needs-owner-review';
const INTERNAL = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const DEFAULT_SENSITIVE = ['.github/', '.public-gate/', 'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'SECURITY.md', 'LICENSE', '.npmrc', '.nvmrc', '.npmignore'];
/** 建置設定檔：tsconfig.json、tsconfig.build.json…（任何一層資料夾） */
const SENSITIVE_BASENAME = /^tsconfig.*\.json$/i;
/** GitHub「PR 動了哪些檔」API 最多只給 3,000 個 */
export const FILES_API_LIMIT = 3000;
export const INCOMPLETE = '（檔案清單不完整）';
const SENSITIVE_NAME = /(auth|secret|token|credential|passw|apikey|api-key|signing|smtp|sendmail|mailer|webhook)/i;

export function isSensitive(path, extra = []) {
  const all = [...DEFAULT_SENSITIVE, ...extra];
  if (all.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p || path.endsWith(`/${p}`)))) return true;
  if (SENSITIVE_BASENAME.test(path.split('/').pop())) return true;
  return SENSITIVE_NAME.test(path);
}

/**
 * 擁有者對 headSha 的有效核准：每位內部審查人只看他「最後一次」對 headSha 的審查，要是 APPROVED，且沒有人要求修改。
 * reviews：GitHub API 的 { user:{login}, author_association, state, commit_id, submitted_at }。
 */
export function approvedAt(reviews, headSha) {
  const last = new Map();
  for (const r of [...reviews].sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at)))) {
    if (!INTERNAL.has(r.author_association) || r.commit_id !== headSha) continue;
    if (!['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) continue;
    last.set(r.user?.login, r.state);
  }
  const states = [...last.values()];
  return states.includes('APPROVED') && !states.includes('CHANGES_REQUESTED');
}

/**
 * 檔案清單拿得完整嗎：PR 自己報的變動檔數（changedFiles）要等於實際取到的筆數（fetched），且都不到 API 上限。
 * 回傳 null＝完整；否則回傳一句原因。changedFiles 讀不到（不是數字）也算不完整。
 */
export function incompleteReason(changedFiles, fetched) {
  if (!Number.isInteger(changedFiles)) return `讀不到 PR 的變動檔數，實際取到 ${fetched} 個`;
  if (changedFiles >= FILES_API_LIMIT || fetched >= FILES_API_LIMIT) return `PR 動了 ${changedFiles} 個檔，GitHub 清單上限 ${FILES_API_LIMIT} 個，後面的看不到`;
  if (changedFiles !== fetched) return `PR 說動了 ${changedFiles} 個檔，實際取到 ${fetched} 個`;
  return null;
}

/**
 * 回傳 { pass, reason, sensitive[], addWait }。
 * changedFiles／fetched：有給就檢查清單完不完整（主程式一定給）；不完整＝當作動到敏感檔。
 */
export function decide({ association, files, reviews = [], headSha, extraSensitive = [], changedFiles, fetched }) {
  const sensitive = files.filter((f) => isSensitive(f, extraSensitive));
  const why = fetched === undefined ? null : incompleteReason(changedFiles, fetched);
  if (why) sensitive.unshift(`${INCOMPLETE}${why}`);
  if (INTERNAL.has(association)) return { pass: true, reason: `作者身分 ${association}，放行（測試與清潔掃描另外檢查）`, sensitive, addWait: false };
  if (!sensitive.length) return { pass: true, reason: '外部 PR，沒動到敏感檔；照審查清單審', sensitive, addWait: false };
  if (approvedAt(reviews, headSha)) return { pass: true, reason: `外部 PR 動到敏感檔，擁有者已核准目前的 commit ${headSha.slice(0, 7)}`, sensitive, addWait: false };
  return { pass: false, reason: `外部 PR 動到敏感檔，等擁有者對目前的 commit ${headSha.slice(0, 7)} 按 Approve 後重跑這一格`, sensitive, addWait: true };
}

async function gh(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}), accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'public-gate', ...(init.headers ?? {}) },
  });
  if (!res.ok && res.status !== 404) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 || res.status === 404 ? null : res.json();
}

async function all(path) {
  const out = [];
  for (let page = 1; ; page++) {
    const batch = await gh(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) return out;
  }
}

async function main() {
  // 合併前現查（唯讀）：node .public-gate/pr-gate.mjs --pr 12 [--repo owner/name]；權杖用 GITHUB_TOKEN
  const prArg = process.argv.indexOf('--pr');
  const readOnly = prArg > -1;
  const repoArg = process.argv.indexOf('--repo');
  const repo = repoArg > -1 ? process.argv[repoArg + 1] : process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('不知道是哪個 repo：加 --repo owner/name');
  const n = readOnly ? Number(process.argv[prArg + 1]) : JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).pull_request.number;
  const pr = await gh(`/repos/${repo}/pulls/${n}`); // 現查，不用事件快照
  const cfg = existsSync('.public-gate/config.json') ? JSON.parse(readFileSync('.public-gate/config.json', 'utf8')) : {};
  const changed = await all(`/repos/${repo}/pulls/${n}/files`);
  const files = [...changed.map((f) => f.filename), ...changed.filter((f) => f.previous_filename).map((f) => f.previous_filename)];
  const reviews = await all(`/repos/${repo}/pulls/${n}/reviews`);
  const d = decide({ association: pr.author_association, files, reviews, headSha: pr.head.sha, extraSensitive: cfg.sensitivePaths ?? [], changedFiles: pr.changed_files, fetched: changed.length });
  console.log(`進門檢查：${d.pass ? '通過' : '擋下'}——${d.reason}`);
  if (d.sensitive.length) console.log(`動到的敏感檔：\n  ${d.sensitive.join('\n  ')}`);
  if (readOnly) { console.log(d.pass ? '→ 可以合併' : '→ 不可合併'); if (!d.pass) process.exit(1); return; }
  const labels = (pr.labels ?? []).map((l) => l.name);
  if (d.addWait && !labels.includes(WAIT_LABEL)) await gh(`/repos/${repo}/issues/${n}/labels`, { method: 'POST', body: JSON.stringify({ labels: [WAIT_LABEL] }) });
  if (d.pass && labels.includes(WAIT_LABEL)) await gh(`/repos/${repo}/issues/${n}/labels/${encodeURIComponent(WAIT_LABEL)}`, { method: 'DELETE' });
  if (!d.pass && labels.includes(APPROVE_LABEL)) await gh(`/repos/${repo}/issues/${n}/labels/${encodeURIComponent(APPROVE_LABEL)}`, { method: 'DELETE' });
  if (!d.pass) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
