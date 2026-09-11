/* Shared by the audio Worker and Node regression tests. Mixed-radix FFT supports
 * the model's exact 7680-point transform (power-of-two padding would be wrong). */
(function (scope) {
  const N = 7680,
    HOP = 1024,
    BINS = 3072,
    FRAMES = 256,
    CHUNK = 261120;
  function plan(n) {
    if (n === 1) return { n };
    let radix = 2;
    while (n % radix) radix++;
    const m = n / radix,
      cos = new Float64Array(n),
      sin = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    return {
      n,
      radix,
      m,
      cos,
      sin,
      real: new Float64Array(n),
      imag: new Float64Array(n),
      child: plan(m),
    };
  }
  const fftPlan = plan(N);
  function transform(
    p,
    real,
    imag,
    offset,
    stride,
    outR,
    outI,
    outOffset,
    inverse,
  ) {
    if (p.n === 1) {
      outR[outOffset] = real[offset];
      outI[outOffset] = imag[offset];
      return;
    }
    for (let j = 0; j < p.radix; j++)
      transform(
        p.child,
        real,
        imag,
        offset + j * stride,
        stride * p.radix,
        p.real,
        p.imag,
        j * p.m,
        inverse,
      );
    for (let k = 0; k < p.n; k++) {
      let r = 0,
        im = 0;
      for (let j = 0; j < p.radix; j++) {
        const at = j * p.m + (k % p.m),
          tw = (j * k) % p.n,
          s = p.sin[tw] * (inverse ? 1 : -1),
          c = p.cos[tw];
        r += p.real[at] * c - p.imag[at] * s;
        im += p.real[at] * s + p.imag[at] * c;
      }
      outR[outOffset + k] = r;
      outI[outOffset + k] = im;
    }
  }
  const window = Float64Array.from(
    { length: N },
    (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N),
  );
  function reflect(i, length) {
    if (length <= 1) return 0;
    const period = 2 * (length - 1);
    const x = ((i % period) + period) % period;
    return x < length ? x : period - x;
  }
  function stft(left, right) {
    const result = new Float32Array(4 * BINS * FRAMES),
      r = new Float64Array(N),
      im = new Float64Array(N),
      outR = new Float64Array(N),
      outI = new Float64Array(N);
    for (const [channel, input] of [left, right].entries())
      for (let frame = 0; frame < FRAMES; frame++) {
        for (let i = 0; i < N; i++)
          r[i] =
            (input[reflect(frame * HOP + i - N / 2, input.length)] || 0) *
            window[i];
        transform(fftPlan, r, im, 0, 1, outR, outI, 0, false);
        const base = channel * 2 * BINS * FRAMES;
        for (let bin = 0; bin < BINS; bin++) {
          result[base + bin * FRAMES + frame] = outR[bin];
          result[base + BINS * FRAMES + bin * FRAMES + frame] = outI[bin];
        }
      }
    return result;
  }
  function istft(spectrum) {
    const result = [];
    for (let channel = 0; channel < 2; channel++) {
      const signal = new Float64Array(CHUNK + N),
        weights = new Float64Array(CHUNK + N),
        r = new Float64Array(N),
        im = new Float64Array(N),
        outR = new Float64Array(N),
        outI = new Float64Array(N);
      for (let frame = 0; frame < FRAMES; frame++) {
        r.fill(0);
        im.fill(0);
        const base = channel * 2 * BINS * FRAMES;
        for (let bin = 0; bin < BINS; bin++) {
          r[bin] = spectrum[base + bin * FRAMES + frame];
          im[bin] = spectrum[base + BINS * FRAMES + bin * FRAMES + frame];
          if (bin) {
            r[N - bin] = r[bin];
            im[N - bin] = -im[bin];
          }
        }
        transform(fftPlan, r, im, 0, 1, outR, outI, 0, true);
        for (let i = 0; i < N; i++) {
          const at = frame * HOP + i;
          signal[at] += (outR[i] / N) * window[i];
          weights[at] += window[i] ** 2;
        }
      }
      result.push(
        Float32Array.from(
          { length: CHUNK },
          (_, i) => signal[i + N / 2] / Math.max(1e-10, weights[i + N / 2]),
        ),
      );
    }
    return result;
  }
  function wav(left, right) {
    // Attenuate toward the true peak instead of hard-clamping each sample:
    // clamping distorts only the handful of samples that exceed [-1, 1] and
    // sounds like clipping, while a single uniform scale keeps the whole
    // signal's shape intact. peak starts at 1 so audio that never approaches
    // full scale is written unchanged — this can only reduce gain, never add it.
    let peak = 1;
    for (let i = 0; i < left.length; i++) {
      const a = Math.abs(left[i]),
        b = Math.abs(right[i]);
      if (a > peak) peak = a;
      if (b > peak) peak = b;
    }
    const scale = 32767 / peak;
    if (peak > 1)
      console.warn(
        `AudioDSP.wav: attenuating by ${(20 * Math.log10(scale / 32767)).toFixed(2)} dB to avoid clipping (peak ${peak.toFixed(3)}).`,
      );
    const buffer = new ArrayBuffer(44 + left.length * 4),
      view = new DataView(buffer);
    const string = (offset, s) => {
      for (let i = 0; i < s.length; i++)
        view.setUint8(offset + i, s.charCodeAt(i));
    };
    string(0, "RIFF");
    view.setUint32(4, buffer.byteLength - 8, true);
    string(8, "WAVE");
    string(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 2, true);
    view.setUint32(24, 44100, true);
    view.setUint32(28, 176400, true);
    view.setUint16(32, 4, true);
    view.setUint16(34, 16, true);
    string(36, "data");
    view.setUint32(40, buffer.byteLength - 44, true);
    for (let i = 0; i < left.length; i++)
      for (let c = 0; c < 2; c++)
        view.setInt16(
          44 + i * 4 + c * 2,
          Math.max(-32768, Math.min(32767, Math.round((c ? right[i] : left[i]) * scale))),
          true,
        );
    return buffer;
  }
  scope.AudioDSP = {
    N,
    HOP,
    BINS,
    FRAMES,
    CHUNK,
    plan,
    transform,
    stft,
    istft,
    wav,
  };
})(globalThis);
