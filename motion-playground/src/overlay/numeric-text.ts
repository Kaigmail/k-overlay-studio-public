export type NumericText = { value: number; decimals: number; text: string; sign: "" | "+" | "-" };

const NUMBER = /^([+\-−]?)(?:(\d+|\d{1,3}(?:[,， \u00a0\u202f]\d{3})+)(?:\.(\d+))?|\.(\d+))$/;

export function parseNumericText(input: unknown): NumericText | undefined {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return;
    const [mantissa, exponent = "0"] = String(input).split("e");
    const decimals = Math.max(0, (mantissa.split(".")[1]?.length ?? 0) - Number(exponent));
    return { value: input, decimals, text: formatNumericText(input, decimals), sign: input < 0 ? "-" : "" };
  }
  if (typeof input !== "string") return;
  const match = NUMBER.exec(input.trim());
  if (!match) return;
  const [, rawSign, integer = "0", fraction, leadingFraction] = match;
  const sign = rawSign === "−" ? "-" : rawSign as NumericText["sign"];
  const digits = fraction ?? leadingFraction;
  const text = sign + integer.replace(/[,， \u00a0\u202f]/g, "") + (digits ? "." + digits : "");
  const value = Number(text);
  if (Number.isFinite(value)) return { value, decimals: digits?.length ?? 0, text, sign };
}

export function formatNumericText(value: number, decimals: number, sign: NumericText["sign"] = "") {
  const precision = Math.min(20, Math.max(0, Math.trunc(decimals || 0)));
  const digits = Math.abs(value).toLocaleString("en-US", {
    useGrouping: false, minimumFractionDigits: precision, maximumFractionDigits: precision,
  });
  return (value < 0 || sign === "-" ? "-" : sign) + digits;
}

/** Preserve the historical last-comma rule, including commas inside names. */
export function splitRankRow(row: string) {
  const separator = Math.max(row.lastIndexOf(","), row.lastIndexOf("，"));
  return {
    name: (separator < 0 ? row : row.slice(0, separator)).trim(),
    raw: separator < 0 ? "" : row.slice(separator + 1),
    head: separator < 0 ? row + "," : row.slice(0, separator + 1),
  };
}

const CURVE_POINT = /^(.*?)\s*([+\-−]?(?:\d[\d,，]*(?:\.\d+)?|\.\d+))$/;

export function splitCurvePoint(point: string) {
  const row = point.trimEnd();
  const match = CURVE_POINT.exec(row);
  const numeric = match && parseNumericText(match[2]);
  return {
    label: (match?.[1] ?? row).trim(),
    numeric: numeric || undefined,
    text: numeric ? row.slice(0, -match[2].length) + numeric.text + point.slice(row.length) : point,
  };
}

export function normalizeCurvePoints(points: string, requireNumbers: boolean): string | undefined {
  const rows = points.split("|");
  const parsed = rows.map(splitCurvePoint);
  if (requireNumbers && parsed.some(({ numeric }, index) => !numeric && rows[index].trim())) return;
  return parsed.map(({ text }) => text).join("|");
}
