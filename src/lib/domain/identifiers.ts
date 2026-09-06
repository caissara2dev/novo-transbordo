import { HttpError } from "./errors.ts";

const LETTER_VALUE_MAP: Record<string, number> = {
  A: 10,
  B: 12,
  C: 13,
  D: 14,
  E: 15,
  F: 16,
  G: 17,
  H: 18,
  I: 19,
  J: 20,
  K: 21,
  L: 23,
  M: 24,
  N: 25,
  O: 26,
  P: 27,
  Q: 28,
  R: 29,
  S: 30,
  T: 31,
  U: 32,
  V: 34,
  W: 35,
  X: 36,
  Y: 37,
  Z: 38
};

function stripAlphaNumeric(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function formatPlateForInput(value: string): string {
  const stripped = stripAlphaNumeric(value).slice(0, 7);

  if (stripped.length <= 3) {
    return stripped;
  }

  return `${stripped.slice(0, 3)}-${stripped.slice(3)}`;
}

export function normalizePlate(value: string | null | undefined): string | null {
  if (!value?.trim()) {
    return null;
  }

  const stripped = stripAlphaNumeric(value);

  if (stripped.length !== 7) {
    throw new HttpError(
      400,
      "Placa inválida. Informe 7 caracteres (ex.: AAA1234 ou AAA1A23)."
    );
  }

  const prefix = stripped.slice(0, 3);
  const suffix = stripped.slice(3);

  if (!/^[A-Z]{3}$/.test(prefix)) {
    throw new HttpError(
      400,
      "Placa inválida. Os 3 primeiros caracteres devem ser letras."
    );
  }

  if (!/^\d{4}$/.test(suffix) && !/^\d[A-Z]\d{2}$/.test(suffix)) {
    throw new HttpError(
      400,
      "Placa inválida. Use padrão brasileiro antigo (AAA1234) ou Mercosul (AAA1A23)."
    );
  }

  return `${prefix}-${suffix}`;
}

export function formatContainerForInput(value: string): string {
  const stripped = stripAlphaNumeric(value).slice(0, 11);

  if (stripped.length <= 4) {
    return stripped;
  }

  if (stripped.length <= 10) {
    return `${stripped.slice(0, 4)} ${stripped.slice(4)}`;
  }

  return `${stripped.slice(0, 4)} ${stripped.slice(4, 10)}-${stripped.slice(10)}`;
}

export function calculateContainerCheckDigit(ownerAndSerial: string): number {
  let sum = 0;

  for (let i = 0; i < ownerAndSerial.length; i += 1) {
    const char = ownerAndSerial[i];
    const value = /\d/.test(char) ? Number(char) : LETTER_VALUE_MAP[char];

    if (value === undefined) {
      throw new HttpError(400, "Código de container inválido.");
    }

    sum += value * 2 ** i;
  }

  const remainder = sum % 11;
  return remainder === 10 ? 0 : remainder;
}

export function normalizeContainer(value: string | null | undefined): string | null {
  if (!value?.trim()) {
    return null;
  }

  const stripped = stripAlphaNumeric(value);

  if (stripped.length !== 11) {
    throw new HttpError(
      400,
      "Container inválido. Informe 4 letras + 7 dígitos (ex.: ABCU1234560)."
    );
  }

  const owner = stripped.slice(0, 4);
  const serial = stripped.slice(4, 10);
  const checkDigitText = stripped.slice(10, 11);

  if (!/^[A-Z]{3}[UJZ]$/.test(owner)) {
    throw new HttpError(
      400,
      "Container inválido. Prefixo deve seguir padrão ISO (ex.: ABCU)."
    );
  }

  if (!/^\d{6}$/.test(serial) || !/^\d$/.test(checkDigitText)) {
    throw new HttpError(
      400,
      "Container inválido. Os 7 últimos caracteres devem ser numéricos."
    );
  }

  const expected = calculateContainerCheckDigit(`${owner}${serial}`);
  const informed = Number(checkDigitText);

  if (informed !== expected) {
    throw new HttpError(
      400,
      `Container inválido. Dígito verificador incorreto (esperado ${expected}).`
    );
  }

  return `${owner} ${serial}-${checkDigitText}`;
}
