const EXCEL_FORMULA_PREFIX = /^[\s]*[=+\-@]/;
const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u0009\u000B-\u001F\u007F]/g;

export function toSafeExcelText(value: string): string {
  const sanitized = value.replace(UNSAFE_CONTROL_CHARACTERS, "");

  return EXCEL_FORMULA_PREFIX.test(sanitized) ? `'${sanitized}` : sanitized;
}
