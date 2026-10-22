import { useMemo } from "react";
import { encode } from "uqr";

/** A scannable QR code, always dark on white so every camera reads it. */
export const QrCode = ({ value }: { value: string }) => {
  const { size, path } = useMemo(() => {
    const qr = encode(value, { ecc: "M", border: 0 });
    let d = "";
    for (const [y, row] of qr.data.entries()) {
      for (const [x, dark] of row.entries()) {
        if (dark) {
          d += `M${x} ${y}h1v1h-1z`;
        }
      }
    }
    return { size: qr.size, path: d };
  }, [value]);
  return (
    <div className="w-full max-w-[16rem] self-center rounded-[18px] bg-white p-4 shadow-[inset_0_0_0_1px_var(--line)] sm:self-start">
      <svg
        aria-hidden="true"
        className="block h-auto w-full"
        shapeRendering="crispEdges"
        viewBox={`-1 -1 ${size + 2} ${size + 2}`}
      >
        <path d={path} fill="#161616" />
      </svg>
    </div>
  );
};
