/** Parse Indian-formatted price text ("₹1,29,900.00", "1,299", "Rs. 999") to a number. */
export function parseInrAmount(text: string | null | undefined): number | null {
  if (!text) return null;
  const cleaned = text.replace(/(rs\.?|inr|₹)/gi, '').replace(/[,\s]/g, '');
  const match = cleaned.match(/\d+(?:\.\d{1,2})?/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) && value > 0 ? value : null;
}
