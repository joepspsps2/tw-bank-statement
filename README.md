# @joelincc/tw-bank-statement

讀台灣網銀匯出的交易明細，整理成統一格式。

各家銀行匯出的檔案長得都不一樣：玉山寫「提」「存」，國泰寫「提出金額」「存入金額」；有的日期是 2026/01/05，有的是民國 1150901；有的給 CSV、有的給 Excel、有的給「副檔名是 .xls、其實是網頁」的檔案。這個套件把它們翻成同一種格式，讓記帳、對帳程式不用每家銀行各寫一份。

- **沒有外部依賴**：只用 Web 標準 API，Node.js 22 以上、瀏覽器、Cloudflare Workers 都能跑。
- **只讀、只整理**：不連網、不存檔，也不判斷「這筆是什麼錢」。分類、對帳留給你的系統。
- **金額不經浮點**：一律存成「分」的整數（元 ×100），用字串運算換算。

## 安裝

```bash
npm install @joelincc/tw-bank-statement
```

## 用法

```ts
import { readBankTable, findHeaderRow, guessMapping, normalizeRows, matchBankProfile } from '@joelincc/tw-bank-statement';

const bytes = new Uint8Array(await file.arrayBuffer());
const { format, table } = await readBankTable(bytes);    // 'csv' | 'xlsx' | 'html'，二維表格
const headerRow = findHeaderRow(table);                  // 表頭在第幾列（前面常有帳號說明）
const mapping = guessMapping(table[headerRow]);          // 照表頭文字猜：哪欄是日期、支出、存入、餘額…
const { txns, skipped, balanceBreaks } = normalizeRows(table, headerRow, mapping);

txns[0];
// { line: 2, txnDate: '2026-01-05', actualDate: '2026-01-03', txnTime: '02:11:00',
//   description: '利息', withdrawMinor: 0, depositMinor: 1200, balanceMinor: 1001200,
//   memo: null, counterparty: null, raw: {…原始整列…}, dedupeKey: '…' }

skipped;        // 沒有日期的列（小計、頁尾說明），附原因
balanceBreaks;  // 餘額接不起來的列號：上一筆餘額 − 支出 + 存入 ≠ 這一筆，代表漏列或匯出不完整
matchBankProfile(table[headerRow]); // 認出是哪家銀行的哪種格式；銀行改版時列出少了、多了哪幾欄
```

猜不對的欄位，讓使用者在畫面上指一次，把 `mapping`（欄位 → 表頭文字）存起來，下次同一家銀行直接套用。對應是照**表頭文字**記的，不是照欄位位置，所以銀行調換欄位順序也認得。

## 收哪些檔

| 格式 | 說明 |
|---|---|
| CSV | UTF-8（有沒有 BOM 都可以）或 Big5，自動判斷；逗號、Tab、分號分隔都收；引號內的逗號與換行都處理 |
| Excel `.xlsx` | 讀第一張工作表；自己解壓縮，不靠外部套件；解開後超過 50 MB 會擋下（防壓縮炸彈） |
| 網頁表格的 `.xls` | 很多網銀的「匯出 Excel」其實是 HTML 表格，取列數最多的那個 `<table>` |
| 舊版二進位 `.xls`、PDF | **不收**，會丟出 `BankFileError`，訊息請使用者改匯 CSV／.xlsx |

上限：檔案 5 MB、2 萬筆。

## 日期與金額

| 寫法 | 例 | 結果 |
|---|---|---|
| 西元 | `2026/11/06`、`2026-1-6 13:05`、`20261106` | `2026-11-06` |
| 民國 | `115/11/06`、`115.11.06`、`1151106`、`115年11月6日` | `2026-11-06` |
| Excel 日期序號 | `46332` | `2026-11-06`（1900 日期系統） |
| 金額 | `1,234`、`NT$1,234.5`、`(30)`、`30-`、`-30` | 分：`123400`、`123450`、`-3000`… |
| 浮點殘渣 | `1234.5000000001` | `123450` |
| 銀行印的空白 | `--`、`-` | 空白 |

## 已驗證的銀行

**銀行沒有公開網銀匯出檔的規格書，這裡每一家都是拿實際檔案摸出來的。** 細節在 [`src/banks.ts`](src/banks.ts)。

| 代碼 | 銀行 | 匯出檔 | 驗證 |
|---|---|---|---|
| 808 | 玉山銀行 | 存款交易明細 CSV | 三份實際檔案、270 筆，餘額逐筆接續 |
| 013 | 國泰世華銀行 | 帳戶交易明細（PDF 轉出的欄位） | 兩個月 345 筆；**網銀原生 CSV／Excel 還沒驗過** |

其他銀行通常也能讀（靠表頭文字猜欄位），只是還沒有實際檔案驗證。

## 新增一家銀行

歡迎送 PR。只需要三樣東西，**全部用假資料**：

1. `tests/fixtures/{銀行代碼}-{英文名}/sample.csv`（或 `.xlsx`）：照那家銀行匯出檔的格式，**帳號、金額、名稱全部換成假的**，表頭與日期、金額的寫法保持原樣。
2. 同一個資料夾放 `expected.json`：這份樣本應該讀出幾筆、每筆的日期與金額。
3. `src/banks.ts` 加一筆格式紀錄：表頭、建議對應、怪癖，以及用什麼樣本驗證過。

`npm test` 會自動跑每個資料夾，並跑個資掃描：出現像真實帳號的長數字、檢查碼合法的統編或身分證號，測試就會失敗。

## 已知限制

- 全形數字的金額（`１，２３４`）、全形括號的負數目前看不懂，那一列會被略過並列出原因。
- Excel 的 1904 日期系統（舊版 Mac Excel）還沒處理。
- 用「XML 加前綴」寫法產生的 .xlsx（例如部分 .NET 工具產的檔）可能讀成空表格。
- UTF-16 編碼的文字檔不收。

## English

Parse transaction-history exports from Taiwanese online banking (CSV in UTF-8 or Big5, `.xlsx`, and HTML tables saved as `.xls`) into one normalized shape: ROC (Minguo) dates and Excel serial dates become ISO dates, amounts become integer minor units without floating-point math, and a running-balance check flags missing rows. Zero dependencies; runs on Node.js 22+, browsers and Cloudflare Workers. Bank formats were reverse-engineered from real exports because banks publish no specification. Contributions of new bank formats are welcome, using synthetic sample data only.

## 授權

MIT
