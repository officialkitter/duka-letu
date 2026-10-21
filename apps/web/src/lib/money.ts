/** Integer minor units everywhere; formatting is the only place we divide. */
export function formatMoney(cents: number, currency: string): string {
  const cur = currency.toUpperCase();
  const digits =
    new Intl.NumberFormat('en', { style: 'currency', currency: cur }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(
    cents / 10 ** digits,
  );
}

/** Tax for one line in minor units, rounded half up. rateBps: 800 = 8.00%. */
export function lineTax(lineTotalCents: number, rateBps: number): number {
  return Math.round((lineTotalCents * rateBps) / 10_000);
}
