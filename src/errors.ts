/** 看不懂檔案、欄位對應不對時丟出的錯誤；code 給程式判斷，message 是給財務看的白話中文。 */
export class BankFileError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'BankFileError';
    this.code = code;
  }
}
