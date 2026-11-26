import qrcode from "qrcode-generator";
import { useMemo } from "react";

/** A QR code drawn as SVG in the page, so it prints sharp at any size. */
export function Qr({ text, size = 160, label }: { text: string; size?: number; label: string }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [text]);
  return <div className="qr" role="img" aria-label={label} style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} />;
}
