/** Exact scope of the on-chain verifier; other calculator expressions remain supported off chain. */
export function additionOperands(input: string): { a: number; b: number } | undefined {
  const match = input.trim().match(/^(?:(?:calculate|calc|計算)\s*[:：]?\s*)?(-?\d+)\s*\+\s*(-?\d+)$/i);
  if (!match) return undefined;
  const a = Number(match[1]);
  const b = Number(match[2]);
  return Number.isSafeInteger(a) && Number.isSafeInteger(b) && Math.abs(a) <= 1000000 && Math.abs(b) <= 1000000
    ? { a, b } : undefined;
}

export function additionClaim(output: string, operands: { a: number; b: number }): number {
  const match = output.trim().match(/^(-?\d+)\s*\+\s*(-?\d+)\s*=\s*(-?\d+)$/);
  if (!match || Number(match[1]) !== operands.a || Number(match[2]) !== operands.b)
    throw new Error('Calculator output does not match the requested addition');
  const result = Number(match[3]);
  if (!Number.isSafeInteger(result) || Math.abs(result) > 2000001)
    throw new Error('Calculator result is outside the integer verifier range');
  return result;
}
