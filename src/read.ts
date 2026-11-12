/**
 * 讀檔：網銀匯出的 CSV（UTF-8／Big5）、Excel .xlsx、網頁表格假裝的 .xls → 二維表格。
 * 只用 Web 標準 API（TextDecoder、DecompressionStream），Node 22+、瀏覽器、Cloudflare Workers 都能跑，沒有外部依賴。
 */
import { BankFileError } from './errors.ts';

export const BANK_FILE_MAX = 5 * 1024 * 1024;
export const BANK_ROWS_MAX = 20_000;

export type Table = string[][];
export type BankFileFormat = 'csv' | 'xlsx' | 'html';

// ── 讀檔 ─────────────────────────────────────

/** 檔案開頭判格式。舊版 Excel（.xls 二進位）不支援，請網銀改匯 CSV 或 .xlsx。 */
export function sniffBankFile(bytes: Uint8Array): BankFileFormat | 'xls_binary' | 'unknown' {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'xlsx';
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return 'xls_binary';
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'unknown'; // PDF
  const head = decodeText(bytes.slice(0, 4096)).slice(0, 4096).toLowerCase();
  if (/<(html|table|meta|!doctype)/.test(head)) return 'html';
  if (bytes.length > 0 && !bytes.slice(0, 4096).some((b) => b === 0)) return 'csv';
  return 'unknown';
}

/** 文字檔解碼：先試 UTF-8（去 BOM），不是合法 UTF-8 就當 Big5（台灣網銀常見）。 */
export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    // 截在多位元組字中間也會丟錯：這裡只用來猜格式，最後一個字壞掉不影響
  }
  try {
    return new TextDecoder('big5').decode(bytes);
  } catch {
    throw new BankFileError('bank_encoding', '看不懂這個檔案的文字編碼，請改匯 UTF-8 的 CSV 或 Excel（.xlsx）');
  }
}

export async function readBankTable(bytes: Uint8Array): Promise<{ format: BankFileFormat; table: Table }> {
  if (bytes.length === 0) throw new BankFileError('bank_empty', '檔案是空的');
  if (bytes.length > BANK_FILE_MAX) throw new BankFileError('bank_too_big', '檔案超過 5 MB，請分段（例如一次一個月）匯出');
  const kind = sniffBankFile(bytes);
  if (kind === 'xls_binary') throw new BankFileError('bank_xls', '這是舊版 Excel（.xls），請在網銀改選「CSV」或「Excel（.xlsx）」匯出；或用 Excel 打開後另存成 .xlsx');
  if (kind === 'unknown') throw new BankFileError('bank_format', '看不懂這個檔案，目前收 CSV、Excel（.xlsx）；PDF 對帳單還不收');
  const table = kind === 'xlsx' ? await readXlsx(bytes) : kind === 'html' ? readHtmlTable(decodeText(bytes)) : parseCsv(decodeText(bytes));
  // 空白列保留（畫面上的「第幾列」才對得上原檔），整理時再跳過；只去掉檔尾的空白列
  const cleaned = table.map((r) => r.map(cleanCell));
  while (cleaned.length > 0 && cleaned[cleaned.length - 1].every((c) => c === '')) cleaned.pop();
  if (cleaned.length === 0) throw new BankFileError('bank_empty', '檔案裡沒有資料列');
  if (cleaned.length > BANK_ROWS_MAX + 50) throw new BankFileError('bank_too_many', `一次最多 ${BANK_ROWS_MAX.toLocaleString()} 筆，請分段匯出`);
  return { format: kind, table: cleaned };
}

function cleanCell(v: string): string {
  // 有些網銀在數字前面加 = 或 '（="00123"）讓 Excel 不吃掉前導零
  return v.replace(/ |　/g, ' ').replace(/^=?"(.*)"$/s, '$1').replace(/^'/, '').replace(/\s+/g, ' ').trim();
}

/** CSV：自動判分隔符號（逗號、Tab、分號），支援雙引號包住的欄位與欄內換行。 */
export function parseCsv(text: string): Table {
  const src = text.replace(/^﻿/, '');
  const firstLines = src.split(/\r?\n/).slice(0, 20).join('\n');
  const count = (ch: string) => firstLines.split(ch).length;
  const delim = [',', '\t', ';'].sort((a, b) => count(b) - count(a))[0];
  const rows: Table = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell.trim() === '') { quoted = true; cell = ''; }
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** 網銀「匯出 Excel」很多其實是 HTML 表格存成 .xls：取最多列的那個 <table>。 */
export function readHtmlTable(html: string): Table {
  const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => m[0]);
  let best: Table = [];
  for (const t of tables.length ? tables : [html]) {
    const rows: Table = [];
    for (const tr of t.matchAll(/<tr[\s\S]*?(?=<tr[\s>]|<\/table>|$)/gi)) {
      const cells: string[] = [];
      for (const td of tr[0].matchAll(/<t([dh])([^>]*)>([\s\S]*?)(?=<t[dh][\s>]|<\/tr>|$)/gi)) {
        const text = unescapeXml(td[3].replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ''));
        cells.push(text);
        const span = /colspan\s*=\s*["']?(\d+)/i.exec(td[2]);
        for (let k = 1; k < Math.min(Number(span?.[1] ?? 1), 50); k++) cells.push('');
      }
      if (cells.length) rows.push(cells);
    }
    if (rows.length > best.length) best = rows;
  }
  return best;
}

// ── .xlsx（zip＋XML）：只讀第一張工作表，不靠外部套件 ──────────

/** 解壓後所有檔加起來的上限：擋「壓縮炸彈」（5 MB 的檔解開變好幾 GB 撐爆記憶體）。真的銀行明細解開不到 1 MB。 */
const XLSX_INFLATED_MAX = 50 * 1024 * 1024;
/** 一列最多幾欄：銀行明細不會超過幾十欄；擋檔案裡寫 r="XFD1" 這種超大欄號讓程式補幾萬個空格 */
const XLSX_COLS_MAX = 256;

async function inflateRaw(data: Uint8Array, budget: { left: number }): Promise<Uint8Array> {
  const reader = new Blob([data as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    budget.left -= value.length;
    if (budget.left < 0) {
      await reader.cancel();
      throw new BankFileError('bank_too_big', 'Excel 檔解開後太大，請分段匯出或改匯 CSV');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

async function unzip(bytes: Uint8Array, want: (name: string) => boolean): Promise<Map<string, string>> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new BankFileError('bank_format', 'Excel 檔壞掉了，請重新匯出');
  const entries = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map<string, string>();
  const utf8 = new TextDecoder();
  const budget = { left: XLSX_INFLATED_MAX };
  for (let n = 0; n < entries; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true), rawSize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!want(name)) continue;
    const lNameLen = dv.getUint16(localOff + 26, true), lExtraLen = dv.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const data = bytes.subarray(start, start + compSize);
    // 目錄裡寫的解壓後大小先擋一次（可以造假，所以解壓時還會邊解邊算）
    if (rawSize > budget.left) throw new BankFileError('bank_too_big', 'Excel 檔解開後太大，請分段匯出或改匯 CSV');
    const raw = method === 0 ? data : method === 8 ? await inflateRaw(data, budget) : null;
    if (method === 0) budget.left -= data.length;
    if (!raw) throw new BankFileError('bank_format', 'Excel 檔的壓縮方式不支援，請改匯 CSV');
    out.set(name, utf8.decode(raw));
  }
  return out;
}

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  if (letters.length > 3) return Number.MAX_SAFE_INTEGER; // Excel 最多 3 碼（XFD）
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export async function readXlsx(bytes: Uint8Array): Promise<Table> {
  let files: Map<string, string>;
  try {
    files = await unzip(bytes, (n) => n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels' || n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/[^/]+\.xml$/.test(n));
  } catch (e) {
    // 壞掉或被改過的 zip 讀到檔外會丟 RangeError：當成看不懂的檔，不要變 500
    if (e instanceof RangeError || e instanceof TypeError) throw new BankFileError('bank_format', 'Excel 檔壞掉了，請重新匯出');
    throw e;
  }
  // 第一張工作表：workbook.xml 的第一個 <sheet r:id>，照 rels 找到檔名
  let sheetPath = '';
  const wb = files.get('xl/workbook.xml') ?? '';
  const rid = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb)?.[1];
  const rels = files.get('xl/_rels/workbook.xml.rels') ?? '';
  if (rid) {
    const rel = new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*>`).exec(rels)?.[0];
    const target = rel ? /Target="([^"]+)"/.exec(rel)?.[1] : undefined;
    if (target) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  }
  if (!files.has(sheetPath)) sheetPath = [...files.keys()].filter((k) => k.startsWith('xl/worksheets/')).sort()[0] ?? '';
  const sheet = files.get(sheetPath);
  if (!sheet) throw new BankFileError('bank_format', 'Excel 檔裡找不到工作表');
  const shared: string[] = [];
  for (const si of (files.get('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    shared.push(unescapeXml([...si[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('')));
  }
  const rows: Table = [];
  for (const rm of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    // Excel 不寫空白列：照 <row r="N"> 補回空列，列號才對得上原檔
    const rowNo = Number(/\br="(\d+)"/.exec(rm[1])?.[1] ?? rows.length + 1);
    while (rows.length < rowNo - 1 && rows.length < BANK_ROWS_MAX + 100) rows.push([]);
    const row: string[] = [];
    for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], body = cm[2] ?? '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const t = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let text = '';
      if (t === 's') text = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') text = unescapeXml([...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));
      else if (v !== undefined) text = unescapeXml(v);
      const idx = ref ? colIndex(ref) : row.length;
      if (idx >= XLSX_COLS_MAX) continue; // 超過的欄不要（不補空格）
      while (row.length < idx) row.push('');
      row[idx] = text;
    }
    rows.push(row);
  }
  return rows;
}
