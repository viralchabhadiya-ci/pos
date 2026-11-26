import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";

const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf", "qr_code"];

interface Detector {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

let detector: Promise<Detector> | null = null;

/**
 * The phone's own barcode reader when it has one (Chrome on Android), otherwise ZXing in
 * WebAssembly (iPhone, Firefox). The .wasm file is bundled with the app, so scanning works
 * on a shop network that blocks outside sites.
 */
export function getDetector(): Promise<Detector> {
  detector ??= (async () => {
    const native = (globalThis as { BarcodeDetector?: { new (o: { formats: string[] }): Detector; getSupportedFormats(): Promise<string[]> } }).BarcodeDetector;
    if (native) {
      try {
        const supported = await native.getSupportedFormats();
        const formats = FORMATS.filter((f) => supported.includes(f));
        if (formats.length) return new native({ formats });
      } catch {
        // Fall through to the WebAssembly reader.
      }
    }
    const { BarcodeDetector, prepareZXingModule } = await import("barcode-detector/ponyfill");
    prepareZXingModule({ overrides: { locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path) } });
    return new BarcodeDetector({ formats: FORMATS as never });
  })();
  return detector;
}

export const cameraAvailable = () => typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
