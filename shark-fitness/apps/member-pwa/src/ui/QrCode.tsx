import { useMemo } from 'react';
import { encode } from 'uqr';

/**
 * A scannable QR code (ISO/IEC 18004) drawn as one SVG path.
 *
 * Error correction M (15 % recovery: survives a scratched screen protector or
 * a thumb over a corner) and the standard four-module quiet zone, so phone
 * cameras, the console's BarcodeDetector and USB scanners all lock on. The
 * colours are fixed rather than themed: scanners need dark modules on a light
 * field, and a light-theme token swap must never invert that.
 */
export const QR_DARK = '#04080b';
export const QR_LIGHT = '#ffffff';
const QUIET_ZONE = 4;

export function qrPath(value: string): { size: number; d: string } {
  const qr = encode(value, { ecc: 'M', border: QUIET_ZONE });
  let d = '';
  qr.data.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < row.length && row[x]) x += 1;
      d += `M${start} ${y}h${x - start}v1h-${x - start}z`;
    }
  });
  return { size: qr.size, d };
}

export function QrCode({ value, label, sizePx = 264 }: { value: string; label: string; sizePx?: number }) {
  const { size, d } = useMemo(() => qrPath(value), [value]);
  return (
    <svg
      role="img"
      aria-label={label}
      data-qr-value={value}
      viewBox={`0 0 ${size} ${size}`}
      width={sizePx}
      height={sizePx}
      shapeRendering="crispEdges"
      className="block h-auto w-full max-w-[320px]"
      style={{ minWidth: 240, background: QR_LIGHT }}
    >
      <rect width={size} height={size} fill={QR_LIGHT} />
      <path d={d} fill={QR_DARK} />
    </svg>
  );
}
