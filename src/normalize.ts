/**
 * 整理：找表頭、猜欄位、日期（西元／民國／Excel 序號）、金額轉「分」、餘額連續檢查、去重鍵。
 */
import { BankFileError } from './errors.ts';
import { BANK_ROWS_MAX, type Table } from './read.ts';

/** 欄位：日期必填；金額要嘛「支出＋存入」兩欄、要嘛一欄有正負號的「金額」。 */
export const BANK_FIELDS = ['date', 'actualDate', 'time', 'description', 'withdraw', 'deposit', 'amount', 'balance', 'memo', 'counterparty'] as const;
export type BankField = (typeof BANK_FIELDS)[number];
export const BANK_FIELD_LABELS: Record<BankField, string> = {
  date: '交易日期（入帳日）', actualDate: '實際交易日期（有些銀行另外列）', time: '交易時間', description: '摘要', withdraw: '支出金額', deposit: '存入金額',
  amount: '金額（正負號）', balance: '餘額', memo: '備註', counterparty: '對方帳號／戶名',
};
/** 存在 bank_mappings 的對應：欄位 → 表頭文字。 */
export type BankMapping = Partial<Record<BankField, string>>;

export interface BankTxn {
  /** 檔案裡第幾列（從 1 起算，給人對照原檔） */
  line: number;
  txnDate: string;
  txnTime: string | null;
  /** 實際交易日（例：週末的利息隔週一才入帳；玉山「實際交易日期」）；和 txnDate 相同或沒這欄＝null。不另開欄位，原值在 raw */
  actualDate: string | null;
  description: string | null;
  /** 金額一律以「分」存整數（×100），避免小數誤差；台幣帳戶就是元×100 */
  withdrawMinor: number;
  depositMinor: number;
  balanceMinor: number | null;
  memo: string | null;
  counterparty: string | null;
  /** 原始那一列（表頭→值），留著日後重新整理或對帳用 */
  raw: Record<string, string>;
  /** 去重用：同一帳戶內唯一 */
  dedupeKey: string;
}

// ── 找表頭、猜欄位 ─────────────────────────────

const GUESS: [BankField, RegExp][] = [
  ['date', /^(交易|帳務|記帳|入帳|作帳)?日期$|^交易日$|^日期時間$|^交易日期時間$/],
  ['actualDate', /^實際(交易)?日(期)?$/],
  ['time', /^(實際)?(交易)?時間$/],
  // 玉山表頭只寫一個字「提」「存」；「轉出入銀行代號/帳號」是對方帳號不是金額（下面 MONEY_NOT 擋）
  ['withdraw', /支出|提款|提出|^轉出(金額)?$|付款|借方|扣款|^提$|^支$/],
  ['deposit', /存入|收入|^轉入(金額)?$|存款|貸方|入帳金額|^存$|^收$/],
  ['balance', /餘額|結餘/],
  ['amount', /^(交易)?金額$/],
  ['description', /摘要|交易說明|說明|交易類別|交易內容|交易項目/],
  ['memo', /備註|附言|註記|附註/],
  ['counterparty', /對方|轉出入帳號|轉入帳號|轉出帳號|帳號|戶名/],
];

/** 前 30 列裡，最像表頭的那列：能猜到「日期」＋至少一個金額欄的第一列。 */
export function findHeaderRow(table: Table): number {
  let fallback = 0, bestScore = -1;
  for (let i = 0; i < Math.min(30, table.length); i++) {
    const g = guessMapping(table[i]);
    const money = !!(g.withdraw || g.deposit || g.amount);
    if (g.date && money) return i;
    const score = Object.keys(g).length;
    if (score > bestScore) { bestScore = score; fallback = i; }
  }
  return fallback;
}

const MONEY_FIELDS = new Set<BankField>(['withdraw', 'deposit', 'amount', 'balance']);
/** 帶「帳號／代號／戶名」的欄位一定不是金額 */
const MONEY_NOT = /帳號|代號|戶名|銀行/;

export function guessMapping(headers: string[]): BankMapping {
  const out: BankMapping = {};
  const used = new Set<string>();
  for (const [field, re] of GUESS) {
    const h = headers.find((x) => {
      const k = x?.replace(/\s/g, '');
      return k && !used.has(x) && re.test(k) && !(MONEY_FIELDS.has(field) && MONEY_NOT.test(k));
    });
    if (h) { out[field] = h; used.add(h); }
  }
  // 有「支出／存入」兩欄就不要單一金額欄（例如表頭同時有「金額」說明欄）
  if (out.withdraw && out.deposit) delete out.amount;
  return out;
}

/** 存好的對應能不能套用到這份表：對應到的每個表頭都要在這一列找得到。 */
export function mappingFits(mapping: BankMapping, headers: string[]): boolean {
  const vals = Object.values(mapping).filter(Boolean) as string[];
  return vals.length > 0 && vals.every((h) => headers.includes(h));
}

export function checkMapping(mapping: BankMapping, headers: string[]): void {
  for (const [f, h] of Object.entries(mapping)) {
    if (!(BANK_FIELDS as readonly string[]).includes(f)) throw new BankFileError('bank_mapping', `不認得的欄位：${f}`);
    if (h && !headers.includes(h)) throw new BankFileError('bank_mapping', `表頭裡找不到「${h}」`);
  }
  if (!mapping.date) throw new BankFileError('bank_mapping', '請指定哪一欄是「交易日期」');
  if (!mapping.amount && !mapping.withdraw && !mapping.deposit) throw new BankFileError('bank_mapping', '請指定金額欄：「支出＋存入」兩欄，或一欄有正負號的「金額」');
  if (mapping.amount && (mapping.withdraw || mapping.deposit)) throw new BankFileError('bank_mapping', '「金額（正負號）」和「支出／存入」只能擇一');
  const vals = Object.values(mapping).filter(Boolean);
  if (new Set(vals).size !== vals.length) throw new BankFileError('bank_mapping', '同一欄不能對到兩個欄位');
}

// ── 值的整理 ─────────────────────────────────

/** 日期：西元 2026/11/06、2026-11-06、20261106；民國 115/11/06、115.11.06、1151106；Excel 序號。後面帶時間也收。 */
export function normalizeDate(v: string): string | null {
  const s = v.trim().replace(/[年月]/g, '/').replace(/日/g, ' ').trim();
  if (!s) return null;
  let y: number, m: number, d: number;
  let mt = /^(\d{2,4})[/.\-](\d{1,2})[/.\-](\d{1,2})(?:\D|$)/.exec(s);
  if (mt) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
  else if ((mt = /^(\d{4})(\d{2})(\d{2})(?:\D|$)/.exec(s))) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
  else if ((mt = /^(\d{3})(\d{2})(\d{2})(?:\D|$)/.exec(s))) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
  else if (/^\d{5}(\.\d+)?$/.test(s) && +s > 30000 && +s < 80000) {
    // Excel 日期序號（1900 系統）：25569 = 1970-01-01
    const dt = new Date(Math.round((Math.floor(+s) - 25569) * 86_400_000));
    return dt.toISOString().slice(0, 10);
  } else return null;
  if (y < 1000) y += 1911; // 民國
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return dt.toISOString().slice(0, 10);
}

export function normalizeTime(v: string): string | null {
  const s = v.trim();
  let mt = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (mt) return `${mt[1].padStart(2, '0')}:${mt[2]}:${mt[3] ?? '00'}`;
  mt = /^(\d{2})(\d{2})(\d{2})$/.exec(s);
  if (mt) return `${mt[1]}:${mt[2]}:${mt[3]}`;
  if (/^0?\.\d+$/.test(s)) { // Excel 時間小數
    const sec = Math.round(+s * 86400);
    return [Math.floor(sec / 3600), Math.floor(sec / 60) % 60, sec % 60].map((n) => String(n).padStart(2, '0')).join(':');
  }
  return null;
}

/** 金額轉「分」：去千分位、幣別符號；括號或負號＝負數；空白或「-」＝null。字串運算不經浮點。 */
export function parseMinor(v: string): number | null {
  let s = v.trim().replace(/[,，\s]/g, '').replace(/^(NT\$|NTD|TWD|\$|＄)/i, '').replace(/元$/, '');
  if (s === '' || s === '-' || s === '--' || s === '—') return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith('-') || s.startsWith('－')) { neg = true; s = s.slice(1); }
  else if (s.startsWith('+')) s = s.slice(1);
  if (s.endsWith('-')) { neg = true; s = s.slice(0, -1); }
  const mt = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!mt) return NaN;
  const frac = (mt[2] ?? '').padEnd(2, '0');
  // 超過兩位小數（Excel 浮點殘渣如 1234.5000000001）四捨五入到分
  let minor = Number(mt[1]) * 100 + Number(frac.slice(0, 2));
  if (frac.length > 2 && Number(frac[2]) >= 5) minor += 1;
  if (!Number.isSafeInteger(minor)) return NaN;
  return neg ? -minor : minor;
}

export interface NormalizeResult {
  txns: BankTxn[];
  /** 沒有日期的列（小計、頁尾說明）略過，列出來給人看 */
  skipped: { line: number; reason: string; text: string }[];
  /** 餘額接不起來的列（上一筆餘額 −提＋存 ≠ 這筆餘額）：可能漏列、或匯出不完整。null＝沒有餘額欄、檢查不了 */
  balanceBreaks: number[] | null;
}

/** 餘額連續檢查：舊到新、新到舊兩種排序都試，取斷點少的那個。 */
export function balanceBreaks(txns: BankTxn[]): number[] | null {
  if (txns.length < 2 || txns.some((t) => t.balanceMinor === null)) return null;
  const fwd: number[] = [], back: number[] = [];
  for (let i = 1; i < txns.length; i++) {
    const p = txns[i - 1], c = txns[i];
    if (p.balanceMinor! - c.withdrawMinor + c.depositMinor !== c.balanceMinor) fwd.push(c.line);
    if (c.balanceMinor! - p.withdrawMinor + p.depositMinor !== p.balanceMinor) back.push(p.line);
  }
  return fwd.length <= back.length ? fwd : back;
}

export function normalizeRows(table: Table, headerRow: number, mapping: BankMapping): NormalizeResult {
  const headers = table[headerRow] ?? [];
  checkMapping(mapping, headers);
  const col = (f: BankField) => (mapping[f] ? headers.indexOf(mapping[f]!) : -1);
  const ix = Object.fromEntries(BANK_FIELDS.map((f) => [f, col(f)])) as Record<BankField, number>;
  const txns: BankTxn[] = [];
  const skipped: NormalizeResult['skipped'] = [];
  const seen = new Map<string, number>();
  for (let i = headerRow + 1; i < table.length; i++) {
    const r = table[i];
    const get = (f: BankField) => (ix[f] >= 0 ? (r[ix[f]] ?? '').trim() : '');
    const line = i + 1;
    const text = r.filter(Boolean).join(' ').slice(0, 80);
    if (r.every((c, k) => !c || c === headers[k])) continue; // 空白列、重複的表頭（分頁）
    const date = normalizeDate(get('date'));
    if (!date) { skipped.push({ line, reason: get('date') ? `日期看不懂：${get('date')}` : '沒有日期', text }); continue; }
    let withdraw = 0, deposit = 0;
    if (ix.amount >= 0) {
      const a = parseMinor(get('amount'));
      if (a === null || Number.isNaN(a)) { skipped.push({ line, reason: `金額看不懂：${get('amount') || '空白'}`, text }); continue; }
      if (a < 0) withdraw = -a; else deposit = a;
    } else {
      const w = parseMinor(get('withdraw')), d = parseMinor(get('deposit'));
      if (Number.isNaN(w) || Number.isNaN(d)) { skipped.push({ line, reason: `金額看不懂：${get('withdraw')}／${get('deposit')}`, text }); continue; }
      // 少數銀行支出欄印負號：一律取絕對值
      withdraw = Math.abs(w ?? 0); deposit = Math.abs(d ?? 0);
    }
    if (withdraw === 0 && deposit === 0) { skipped.push({ line, reason: '支出、存入都是 0', text }); continue; }
    const bal = parseMinor(get('balance'));
    const balanceMinor = bal === null || Number.isNaN(bal) ? null : bal;
    const actual = normalizeDate(get('actualDate'));
    const actualDate = actual && actual !== date ? actual : null;
    const time = normalizeTime(get('time')) ?? (ix.time < 0 ? normalizeTime(get('date').replace(/^\S+\s*/, '')) : null);
    // 「--」「-」是銀行印的空白
    const txt = (f: BankField) => { const v = get(f); return v && !/^[-－—]+$/.test(v) ? v : null; };
    const description = txt('description'), memo = txt('memo'), counterparty = txt('counterparty');
    const raw: Record<string, string> = {};
    headers.forEach((h, k) => { if (h && r[k]) raw[h] = r[k]; });
    const base = [date, time ?? '', withdraw, deposit, balanceMinor ?? '', description ?? '', memo ?? '', counterparty ?? ''].join('|');
    const occ = seen.get(base) ?? 0;
    seen.set(base, occ + 1);
    txns.push({ line, txnDate: date, txnTime: time, actualDate, description, withdrawMinor: withdraw, depositMinor: deposit, balanceMinor, memo, counterparty, raw, dedupeKey: `${base}|${occ}` });
  }
  if (txns.length > BANK_ROWS_MAX) throw new BankFileError('bank_too_many', `一次最多 ${BANK_ROWS_MAX.toLocaleString()} 筆，請分段匯出`);
  return { txns, skipped, balanceBreaks: balanceBreaks(txns) };
}

/**
 * 對方帳號給人看：「808/0000123456789012」→「玉山銀行 123456789012」；全 0 帳號（匯款專戶）只留銀行名。其他格式照原樣。
 * bankName：銀行代碼 → 名稱（例如財金公司代碼表）；不給就只顯示代碼。
 */
export function formatCounterparty(v: string | null, bankName: (code: string) => string | null | undefined = () => null): string {
  if (!v) return '';
  const mt = /^(\d{3})[/／-](\d+)$/.exec(v.trim());
  if (!mt) return v;
  const bank = bankName(mt[1])?.replace(/(國際)?商業銀行$/, '銀行').replace(/股份有限公司$/, '') ?? mt[1];
  const acct = mt[2].replace(/^0+/, '');
  return acct ? `${bank} ${acct}` : bank;
}

/** 銀行常印全形字（ＰＡＹＵＮｉ０１０６）：畫面上轉半形好讀；存檔照原樣 */
export function displayText(v: string | null): string {
  return v ? v.normalize('NFKC') : '';
}

export function formatMinor(minor: number | null): string {
  if (minor === null) return '';
  const neg = minor < 0, a = Math.abs(minor);
  const s = `${Math.floor(a / 100).toLocaleString('en-US')}${a % 100 ? `.${String(a % 100).padStart(2, '0')}` : ''}`;
  return neg ? `-${s}` : s;
}
