// West's normal tail approximation. Work in the smaller tail to avoid 1 - CDF cancellation.
export function normalTail(z: number): number {
  if (z < 0) return 1 - normalTail(-z);
  const densityFactor = Math.exp(-z * z / 2);
  if (z >= 7.0710678118654755) {
    const denominator = z + 1 / (z + 2 / (z + 3 / (z + 4 / (z + 0.65))));
    return densityFactor / (Math.sqrt(2 * Math.PI) * denominator);
  }
  const numerator = ((((((0.0352624965998911 * z + 0.700383064443688) * z + 6.37396220353165)
    * z + 33.912866078383) * z + 112.079291497871) * z + 221.213596169931) * z + 220.206867912376);
  const denominator = (((((((0.0883883476483184 * z + 1.75566716318264) * z + 16.064177579207)
    * z + 86.7807322029461) * z + 296.564248779674) * z + 637.333633378831)
    * z + 793.826512519948) * z + 440.413735824752);
  return densityFactor * numerator / denominator;
}

export function normalInterval(low: number, high: number) {
  if (low >= high) return 0;
  return low >= 0 ? normalTail(low) - normalTail(high) : normalTail(-high) - normalTail(-low);
}

export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError('Normal quantile requires 0 < p < 1.');
  const target = Math.min(p, 1 - p);
  let low = 0;
  let high = 40;
  for (let i = 0; i < 56; i++) {
    const midpoint = (low + high) / 2;
    if (normalTail(midpoint) > target) low = midpoint;
    else high = midpoint;
  }
  return (p < 0.5 ? -1 : 1) * (low + high) / 2;
}
