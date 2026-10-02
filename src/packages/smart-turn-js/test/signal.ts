/** 2.5 seconds of two tones and seeded noise at 16 kHz: the input the reference values were computed from. */
export function deterministicSignal(): Float32Array {
  const signal = new Float32Array(40_000);
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648 - 0.5;
  };
  for (let i = 0; i < signal.length; i++) {
    const t = i / 16000;
    signal[i] = 0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * Math.sin(2 * Math.PI * (300 + 900 * t) * t) + 0.05 * rand();
  }
  return signal;
}
