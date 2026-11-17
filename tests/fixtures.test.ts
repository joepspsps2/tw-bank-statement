// 各家銀行樣本：tests/fixtures/{代碼}-{名稱}/sample.* 讀出來要等於 expected.json。
// 新增一家銀行＝加一個資料夾（去識別的樣本＋正確答案）＋src/banks.ts 一筆格式紀錄，不用改這支測試。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findHeaderRow, guessMapping, matchBankProfile, normalizeRows, readBankTable } from '../src/index.ts';

const root = join(import.meta.dirname, 'fixtures');
for (const dir of readdirSync(root)) {
  test(`樣本：${dir}`, async () => {
    const files = readdirSync(join(root, dir));
    const sample = files.find((f) => f.startsWith('sample.'));
    assert.ok(sample, `${dir} 少 sample 檔`);
    const want = JSON.parse(readFileSync(join(root, dir, 'expected.json'), 'utf8'));
    const { table } = await readBankTable(new Uint8Array(readFileSync(join(root, dir, sample!))));
    const h = findHeaderRow(table);
    const match = matchBankProfile(table[h], want.bank);
    assert.ok(match?.exact, `${dir} 的表頭跟 src/banks.ts 的紀錄不一樣：少 ${match?.missing.join('、')}，多 ${match?.extra.join('、')}`);
    // 銀行紀錄的建議對應，和「只看表頭猜」的結果要一致（猜得到才代表新使用者不用手動指欄位）
    assert.deepEqual(guessMapping(table[h]), match!.profile.mapping);
    const r = normalizeRows(table, h, match!.profile.mapping);
    assert.equal(r.txns.length, want.count);
    assert.equal(r.skipped.length, want.skipped);
    assert.deepEqual(r.balanceBreaks, want.balanceBreaks);
    for (const [i, t] of want.txns.entries()) {
      const got = r.txns[i];
      for (const k of Object.keys(t)) assert.deepEqual(got[k as keyof typeof got], t[k], `${dir} 第 ${i + 1} 筆的 ${k}`);
    }
  });
}

test('銀行改版：表頭少一欄、多一欄時 matchBankProfile 指得出差在哪', () => {
  const m = matchBankProfile(['序號', '帳務日期', '實際交易日期', '實際交易時間', '摘要', '提', '存', '餘額', '附言', '轉出入銀行代號/帳號']);
  assert.equal(m?.profile.code, '808');
  assert.equal(m?.exact, false);
  assert.deepEqual(m?.missing, ['備註']);
  assert.deepEqual(m?.extra, ['附言']);
  assert.equal(matchBankProfile(['完全', '不相干']), null);
});
