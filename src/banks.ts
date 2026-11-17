/**
 * 各家銀行網銀匯出檔的格式紀錄。
 *
 * 銀行沒有公開匯出檔的規格書，這裡每一筆都是拿實際檔案摸出來的，verifiedWith 寫明用什麼樣本驗過。
 * 用途：① 認出這份檔是哪家銀行的哪種格式 ② 銀行改版時（表頭變了）比得出差在哪。
 * 新增一家銀行：在這裡加一筆，並在 tests/fixtures/{代碼}-{名稱}/ 放一份去識別的樣本檔＋expected.json。
 */
import type { BankMapping } from './normalize.ts';

export interface BankProfile {
  /** 財金公司銀行代碼（3 碼） */
  code: string;
  name: string;
  /** 這種匯出檔的名稱（同一家銀行可能有好幾種） */
  variant: string;
  /** 表頭那一列（照原樣，含順序） */
  headers: string[];
  /** 建議的欄位對應（表頭文字） */
  mapping: BankMapping;
  /** 對方帳號欄有沒有印銀行代碼 */
  counterpartyHasBankCode: boolean;
  /** 驗證用的樣本：幾份、幾筆、什麼時候 */
  verifiedWith: string;
  notes: string[];
}

export const BANK_PROFILES: BankProfile[] = [
  {
    code: '808', name: '玉山銀行', variant: '存款交易明細 CSV',
    headers: ['序號', '帳務日期', '實際交易日期', '實際交易時間', '摘要', '提', '存', '餘額', '備註', '轉出入銀行代號/帳號'],
    mapping: { date: '帳務日期', actualDate: '實際交易日期', time: '實際交易時間', description: '摘要', withdraw: '提', deposit: '存', balance: '餘額', memo: '備註', counterparty: '轉出入銀行代號/帳號' },
    counterpartyHasBankCode: true,
    verifiedWith: '2026-11：三份網銀匯出檔、270 筆，餘額逐筆接續',
    notes: [
      'UTF-8 含 BOM、CRLF、每格加引號',
      '表頭「提」「存」只有一個字',
      '兩個日期：帳務日期（餘額照這個排）與實際交易日期（週末的利息隔週一才入帳）',
      '對方欄「銀行代號/16 碼帳號」，沒有對方時印「--」',
      '摘要常是全形字（例：ＰＡＹＵＮｉ０１０６）',
      '勞健保扣款的備註是期別：5 碼民國年月（11508＝2026 年 8 月份）',
    ],
  },
  {
    code: '013', name: '國泰世華銀行', variant: '帳戶交易明細（PDF 轉出的欄位）',
    headers: ['序號', '日期', '提出金額', '存入金額', '餘額', '說明', '對方帳號', '備註'],
    mapping: { date: '日期', withdraw: '提出金額', deposit: '存入金額', balance: '餘額', description: '說明', counterparty: '對方帳號', memo: '備註' },
    counterpartyHasBankCode: false,
    verifiedWith: '2026-11：兩個月 345 筆，來源是網銀「帳戶交易明細」PDF 轉成 CSV；網銀原生 CSV／Excel 匯出檔還沒驗過',
    notes: [
      '日期是民國年、沒有分隔（1150901）；序號每月重來',
      '對方帳號 16 碼、沒有銀行代碼，沒有對方時全 0',
      '跨行轉出後緊接一筆「跨行費用」10／15 元',
      '轉出時備註印的是自己公司的名稱，不是對方',
      '勞健保扣款的備註開頭是「7月」這種只有月份的寫法，年份要從扣款日往前推',
    ],
  },
];

export interface ProfileMatch {
  profile: BankProfile;
  /** 這份檔的表頭裡，紀錄有、檔案沒有的欄 */
  missing: string[];
  /** 檔案有、紀錄沒有的欄 */
  extra: string[];
  /** 表頭完全一樣（不算順序） */
  exact: boolean;
}

/**
 * 這一列表頭最像哪一家銀行的哪種格式（同欄位最多的那個）；一個欄都對不上回 null。
 * 銀行改版時 exact 會變 false，missing／extra 列出差在哪，可以提醒人「這家銀行的格式跟上次不一樣」。
 */
export function matchBankProfile(headers: string[], code?: string): ProfileMatch | null {
  const clean = headers.map((h) => (h ?? '').replace(/\s/g, '')).filter(Boolean);
  let best: ProfileMatch | null = null, bestHit = 0;
  for (const p of BANK_PROFILES) {
    if (code && p.code !== code) continue;
    const want = p.headers.map((h) => h.replace(/\s/g, ''));
    const hit = want.filter((h) => clean.includes(h)).length;
    if (hit > bestHit) {
      bestHit = hit;
      const missing = want.filter((h) => !clean.includes(h));
      const extra = clean.filter((h) => !want.includes(h));
      best = { profile: p, missing, extra, exact: missing.length === 0 && extra.length === 0 };
    }
  }
  return best;
}
