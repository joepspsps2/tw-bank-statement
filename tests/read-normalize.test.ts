// 讀檔與整理：日期、金額、CSV、Big5、HTML 偽 .xls、.xlsx（含壓縮炸彈防護）、表頭、欄位對應、去重鍵、玉山格式。
// 測試資料全部是假的（帳號、金額、名稱都是編的）；只有銀行印的「格式」照實際檔案。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
  BankFileError, findHeaderRow, guessMapping, mappingFits, normalizeDate, normalizeRows, normalizeTime, parseCsv, parseMinor,
  readBankTable, readHtmlTable, sniffBankFile, formatMinor, formatCounterparty, displayText,
} from '../src/index.ts';

function fails(fn: () => unknown, code: string) { assert.throws(fn, (e) => e instanceof BankFileError && e.code === code, `應該擋 ${code}`); }
const enc = (s: string) => new TextEncoder().encode(s);
const bankName = (code: string) => ({ '808': '玉山商業銀行', '017': '兆豐國際商業銀行', '822': '中國信託商業銀行' } as Record<string, string>)[code] ?? null;
/** 測試用 xlsx：照真 Excel 的檔案配置，一個檔用 deflate、其他 stored */
function makeXlsx(rows: (string | number)[][], sheetXml?: string): Uint8Array {
  const shared: string[] = [];
  const sIdx = (v: string) => { let i = shared.indexOf(v); if (i < 0) { shared.push(v); i = shared.length - 1; } return i; };
  const col = (n: number) => String.fromCharCode(65 + n);
  const sheet = `<?xml version="1.0"?><worksheet><sheetData>${rows.map((r, i) => r.length === 0 ? '' : `<row r="${i + 1}">${r.map((v, k) => typeof v === 'number'
    ? `<c r="${col(k)}${i + 1}"><v>${v}</v></c>` : `<c r="${col(k)}${i + 1}" t="s"><v>${sIdx(v)}</v></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`;
  const files: [string, string, boolean][] = [
    ['xl/workbook.xml', '<workbook><sheets><sheet name="明細" sheetId="1" r:id="rId1"/></sheets></workbook>', false],
    ['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>', false],
    ['xl/sharedStrings.xml', `<sst>${shared.map((s) => `<si><t>${s.replace(/&/g, '&amp;')}</t></si>`).join('')}</sst>`, true],
    ['xl/worksheets/sheet1.xml', sheetXml ?? sheet, true],
  ];
  const parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let off = 0;
  for (const [name, body, deflate] of files) {
    const nameB = enc(name), raw = enc(body), data = deflate ? new Uint8Array(deflateRawSync(raw)) : raw;
    const lh = new Uint8Array(30 + nameB.length); const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(8, deflate ? 8 : 0, true); lv.setUint32(18, data.length, true); lv.setUint32(22, raw.length, true); lv.setUint16(26, nameB.length, true); lh.set(nameB, 30);
    const ch = new Uint8Array(46 + nameB.length); const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(10, deflate ? 8 : 0, true); cv.setUint32(20, data.length, true); cv.setUint32(24, raw.length, true); cv.setUint16(28, nameB.length, true); cv.setUint32(42, off, true); ch.set(nameB, 46);
    parts.push(lh, data); central.push(ch); off += lh.length + data.length;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const eocd = new Uint8Array(22); const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true); ev.setUint32(12, cdSize, true); ev.setUint32(16, off, true);
  const all = [...parts, ...central, eocd];
  const out = new Uint8Array(all.reduce((a, p) => a + p.length, 0)); let p = 0;
  for (const x of all) { out.set(x, p); p += x.length; }
  return out;
}

test('日期：西元、民國、無分隔、Excel 序號、帶時間；不合法回 null', () => {
  assert.equal(normalizeDate('2026/11/06'), '2026-11-06');
  assert.equal(normalizeDate('2026-1-6 13:05:00'), '2026-01-06');
  assert.equal(normalizeDate('20261106'), '2026-11-06');
  assert.equal(normalizeDate('115/11/06'), '2026-11-06');
  assert.equal(normalizeDate('115.11.06'), '2026-11-06');
  assert.equal(normalizeDate('1151106'), '2026-11-06');
  assert.equal(normalizeDate('115年11月6日'), '2026-11-06');
  assert.equal(normalizeDate('46332'), '2026-11-06');
  assert.equal(normalizeDate('2026/02/30'), null);
  assert.equal(normalizeDate('合計'), null);
  assert.equal(normalizeDate(''), null);
  assert.equal(normalizeTime('9:05'), '09:05:00');
  assert.equal(normalizeTime('130512'), '13:05:12');
});

test('金額轉分：千分位、幣別、負號、括號、空白；浮點殘渣四捨五入', () => {
  assert.equal(parseMinor('1,234'), 123400);
  assert.equal(parseMinor('NT$1,234.5'), 123450);
  assert.equal(parseMinor('-30'), -3000);
  assert.equal(parseMinor('(30)'), -3000);
  assert.equal(parseMinor('30-'), -3000);
  assert.equal(parseMinor('1234.5000000001'), 123450);
  assert.equal(parseMinor('0.125'), 13);
  assert.equal(parseMinor(''), null);
  assert.equal(parseMinor('-'), null);
  assert.ok(Number.isNaN(parseMinor('abc')));
  assert.equal(formatMinor(123450), '1,234.50');
  assert.equal(formatMinor(-300), '-3');
});

test('CSV：引號裡的逗號與換行、Tab 分隔、BOM', () => {
  assert.deepEqual(parseCsv('﻿a,b\n"x,1","line\nbreak"\r\n3,4'), [['a', 'b'], ['x,1', 'line\nbreak'], ['3', '4']]);
  assert.deepEqual(parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a,"say ""hi"""'), [['a', 'say "hi"']]);
});

test('空白列保留在原位置（列號對得上原檔），整理時跳過、不算略過', async () => {
  const { table } = await readBankTable(enc('帳號,1\n\n日期,支出,存入\n2026/11/01,5,\n\n2026/11/02,,7\n\n'));
  assert.equal(table.length, 6);
  const h = findHeaderRow(table);
  assert.equal(h, 2);
  const { txns, skipped } = normalizeRows(table, h, guessMapping(table[h]));
  assert.deepEqual(txns.map((t) => t.line), [4, 6]);
  assert.equal(skipped.length, 0);
});

test('Big5 編碼的 CSV 也讀得懂（台灣網銀常見）', async () => {
  // 「交易日期,摘要」的 Big5 位元組
  const big5 = new Uint8Array([0xa5, 0xe6, 0xa9, 0xf6, 0xa4, 0xe9, 0xb4, 0xc1, 0x2c, 0xba, 0x4b, 0xad, 0x6e, 0x0a, 0x31, 0x2c, 0x32]);
  const { format, table } = await readBankTable(big5);
  assert.equal(format, 'csv');
  assert.deepEqual(table[0], ['交易日期', '摘要']);
});

test('格式判斷：舊版 .xls 二進位、PDF 擋下並說明；HTML 偽 .xls 當表格讀', async () => {
  assert.equal(sniffBankFile(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0])), 'xls_binary');
  await assert.rejects(readBankTable(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0])), (e) => e instanceof BankFileError && e.code === 'bank_xls');
  await assert.rejects(readBankTable(enc('%PDF-1.7 xxx')), (e) => e instanceof BankFileError && e.code === 'bank_format');
  await assert.rejects(readBankTable(new Uint8Array()), (e) => e instanceof BankFileError && e.code === 'bank_empty');
  const html = '<html><meta charset="utf-8"><table><tr><td>帳號：0001</td></tr></table><table><tr><th>交易日期</th><th>支出</th><th>存入</th><th>餘額</th></tr>'
    + '<tr><td>2026/11/01</td><td>1,000</td><td></td><td>9,000</td></tr><tr><td colspan="2">合計</td><td>&nbsp;</td><td>x</td></tr></table></html>';
  const t = readHtmlTable(html);
  assert.deepEqual(t[0], ['交易日期', '支出', '存入', '餘額']);
  assert.deepEqual(t[2], ['合計', '', ' ', 'x']);
  const r = await readBankTable(enc(html));
  assert.equal(r.format, 'html');
});

test('Excel（.xlsx）：共用字串、數字、第一張工作表、deflate 壓縮', async () => {
  const x = makeXlsx([['某某銀行 存款往來明細'], [], ['交易日期', '摘要', '支出金額', '存入金額', '帳戶餘額'], ['2026/11/02', '跨行轉帳', 1500, '', 8500], [46332, '利息', '', 3.5, 8503.5]]);
  const { format, table } = await readBankTable(x);
  assert.equal(format, 'xlsx');
  const h = findHeaderRow(table);
  assert.equal(h, 2); // 空白的第 2 列 Excel 不寫，要補回來
  const m = guessMapping(table[h]);
  assert.deepEqual(m, { date: '交易日期', withdraw: '支出金額', deposit: '存入金額', balance: '帳戶餘額', description: '摘要' });
  const { txns, skipped } = normalizeRows(table, h, m);
  assert.equal(skipped.length, 0);
  assert.deepEqual(txns.map((t) => t.line), [4, 5]);
  assert.deepEqual(txns.map((t) => [t.txnDate, t.withdrawMinor, t.depositMinor, t.balanceMinor]), [['2026-11-02', 150000, 0, 850000], ['2026-11-06', 0, 350, 850350]]);
});

test('Excel 安全：解開後超過 50 MB（壓縮炸彈）擋下；超大欄號不補空格；壞掉的 zip 不會變成程式錯誤', async () => {
  const bomb = makeXlsx([], `<worksheet><sheetData>${' '.repeat(51 * 1024 * 1024)}</sheetData></worksheet>`);
  assert.ok(bomb.length < 1024 * 1024); // 壓縮後很小
  await assert.rejects(readBankTable(bomb), (e) => e instanceof BankFileError && e.code === 'bank_too_big');
  // 目錄謊報解壓後大小＝0：還是要在解壓途中擋下
  const dv = new DataView(bomb.buffer);
  for (let i = 0; i < bomb.length - 4; i++) if (dv.getUint32(i, true) === 0x02014b50) dv.setUint32(i + 24, 0, true);
  await assert.rejects(readBankTable(bomb), (e) => e instanceof BankFileError && e.code === 'bank_too_big');
  const wide = makeXlsx([], '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>日期</t></is></c><c r="XFD1"><v>1</v></c><c r="ZZZZZZ1"><v>2</v></c></row></sheetData></worksheet>');
  const { table } = await readBankTable(wide);
  assert.deepEqual(table, [['日期']]);
  const broken = makeXlsx([['a']]);
  broken.fill(0xff, 40, broken.length - 22); // 中間亂掉、結尾目錄還在
  await assert.rejects(readBankTable(broken), (e) => e instanceof BankFileError);
});

test('整理：表頭前的說明列、小計列略過並列原因；單欄正負號金額；重複表頭（分頁）跳過', () => {
  const table = parseCsv([
    '帳號,0123456789', '查詢期間,2026/11/01~2026/11/30',
    '交易日期,交易時間,摘要,金額,餘額,備註', '115/11/01,09:00,薪資轉帳,"-50,000","100,000",十月薪資',
    '115/11/01,09:00,手續費,-15,"99,985",', '交易日期,交易時間,摘要,金額,餘額,備註', '115/11/03,,匯入,"2,000","101,985",客戶A', '合計,,,,,',
  ].join('\n'));
  const h = findHeaderRow(table);
  assert.equal(h, 2);
  const m = guessMapping(table[h]);
  assert.equal(m.amount, '金額');
  assert.equal(m.withdraw, undefined);
  const { txns, skipped } = normalizeRows(table, h, m);
  assert.deepEqual(txns.map((t) => [t.line, t.txnDate, t.txnTime, t.withdrawMinor, t.depositMinor, t.memo]), [
    [4, '2026-11-01', '09:00:00', 5_000_000, 0, '十月薪資'], [5, '2026-11-01', '09:00:00', 1500, 0, null], [7, '2026-11-03', null, 0, 200000, '客戶A']]);
  assert.deepEqual(skipped.map((s) => [s.line, s.reason]), [[8, '日期看不懂：合計']]);
  assert.equal(txns[0].raw['摘要'], '薪資轉帳');
});

test('同一天兩筆一模一樣的交易（沒有餘額欄）：用出現順序區分，不會被當重複', () => {
  const table = parseCsv('日期,支出,存入\n2026/11/01,15,\n2026/11/01,15,');
  const { txns } = normalizeRows(table, 0, { date: '日期', withdraw: '支出', deposit: '存入' });
  assert.equal(txns.length, 2);
  assert.notEqual(txns[0].dedupeKey, txns[1].dedupeKey);
});

test('欄位對應檢查：缺日期、缺金額、金額兩種寫法混用、同欄重複、表頭沒有', () => {
  const hs = ['日期', '支出', '存入', '金額'];
  const t = [hs, ['2026/11/01', '1', '', '']];
  fails(() => normalizeRows(t, 0, { withdraw: '支出' }), 'bank_mapping');
  fails(() => normalizeRows(t, 0, { date: '日期' }), 'bank_mapping');
  fails(() => normalizeRows(t, 0, { date: '日期', amount: '金額', withdraw: '支出' }), 'bank_mapping');
  fails(() => normalizeRows(t, 0, { date: '日期', withdraw: '支出', deposit: '支出' }), 'bank_mapping');
  fails(() => normalizeRows(t, 0, { date: '日期', withdraw: '提款' }), 'bank_mapping');
  assert.equal(mappingFits({ date: '日期', withdraw: '支出' }, hs), true);
  assert.equal(mappingFits({ date: '交易日', withdraw: '支出' }, hs), false);
});
test('玉山 CSV：表頭「提」「存」單字、帳務日＋實際交易日、對方「代號/帳號」不是金額、「--」是空白、餘額連續檢查', async () => {
  const csv = '﻿"序號","帳務日期","實際交易日期","實際交易時間","摘要","提","存","餘額","備註","轉出入銀行代號/帳號"\r\n'
    + '"1","2026/01/05","2026/01/05","02:11:00","存單利息","0","12","1,012","444000001","--"\r\n'
    + '"2","2026/01/12","2026/01/12","05:18:54","企網轉帳","500","0","512","租金０１１１","017/0000001234567890"\r\n'
    + '"3","2026/02/23","2026/02/20","02:08:20","ＰＡＹＵＮｉ０２２３","0","88","600","","822/0000000000000000"\r\n';
  const { table } = await readBankTable(new TextEncoder().encode(csv));
  const h = findHeaderRow(table);
  const m = guessMapping(table[h]);
  assert.deepEqual(m, { date: '帳務日期', actualDate: '實際交易日期', time: '實際交易時間', withdraw: '提', deposit: '存', balance: '餘額', description: '摘要', memo: '備註', counterparty: '轉出入銀行代號/帳號' });
  const r = normalizeRows(table, h, m);
  assert.equal(r.txns.length, 3); assert.equal(r.skipped.length, 0);
  assert.deepEqual(r.balanceBreaks, []);
  assert.equal(r.txns[0].counterparty, null); // 「--」
  assert.equal(r.txns[0].actualDate, null);   // 同一天不標
  assert.equal(r.txns[2].txnDate, '2026-02-23'); assert.equal(r.txns[2].actualDate, '2026-02-20');
  assert.equal(formatCounterparty(r.txns[1].counterparty, bankName), '兆豐銀行 1234567890');
  assert.equal(formatCounterparty(r.txns[2].counterparty, bankName), '中國信託銀行'); // 全 0＝匯款專戶，只留銀行
  assert.equal(displayText(r.txns[2].description), 'PAYUNi0223');
  // 少一列 → 餘額接不起來
  const cut = normalizeRows([table[0], table[1], table[3]], 0, m);
  assert.deepEqual(cut.balanceBreaks, [3]);
});


test('安全：特製檔案不會讓讀檔慢到卡死（很多開頭沒有結尾）；工作表編號裡的特殊符號不會被當成比對規則', async () => {
  const t0 = Date.now();
  readHtmlTable('<table'.repeat(200_000));
  readHtmlTable('<table><tr><td' + '<td'.repeat(200_000));
  assert.ok(Date.now() - t0 < 2000, `HTML 讀了 ${Date.now() - t0} ms`);
  const t1 = Date.now();
  const rowsBomb = makeXlsx([], '<worksheet><sheetData>' + '<row r="1"><c r="A1"><v>1</v></c>'.repeat(100_000) + '</sheetData></worksheet>');
  await readBankTable(rowsBomb).catch(() => null);
  assert.ok(Date.now() - t1 < 2000, `xlsx 讀了 ${Date.now() - t1} ms`);
  // r:id 寫成正規表示式特殊字「((((」（舊寫法會丟 SyntaxError 變成程式錯誤）；長度不變，zip 位置才對得上：照樣找到第一張工作表
  const x = makeXlsx([['日期', '支出'], ['2026/11/01', 5]]);
  const patched = Buffer.from(x).toString('latin1').replace('r:id="rId1"', 'r:id="(((("').replace('Id="rId1"', 'Id="(((("');
  const bytes = new Uint8Array(Buffer.from(patched, 'latin1'));
  const { table } = await readBankTable(bytes);
  assert.deepEqual(table[0], ['日期', '支出']);
});
