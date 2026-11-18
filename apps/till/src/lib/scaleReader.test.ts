import { describe, expect, it, vi } from "vitest";
import { connectScale, disconnectScale, getScaleState, parseScaleReading, readScaleLines, type ScaleReading } from "./scaleReader.js";

describe("parseScaleReading", () => {
  it("reads the common formats", () => {
    expect(parseScaleReading("ST,GS,+  1.234kg")).toEqual({ kg: 1.234, stable: true });
    expect(parseScaleReading("US,GS,+  1.230kg")).toEqual({ kg: 1.23, stable: false });
    expect(parseScaleReading("S S     1.234 kg")).toEqual({ kg: 1.234, stable: true });
    expect(parseScaleReading("S D     1.200 kg")).toEqual({ kg: 1.2, stable: false });
    expect(parseScaleReading("  0.500 kg")).toEqual({ kg: 0.5, stable: true });
    expect(parseScaleReading("1234 g")).toEqual({ kg: 1.234, stable: true });
    expect(parseScaleReading("\x02+001.250\x03")).toEqual({ kg: 1.25, stable: true });
  });

  it("treats an empty or negative scale as nothing on it", () => {
    expect(parseScaleReading("ST,GS,+  0.000kg")).toEqual({ kg: 0, stable: true });
    expect(parseScaleReading("ST,NT,-  0.020kg")).toEqual({ kg: 0, stable: false });
  });

  it("ignores pounds and noise", () => {
    expect(parseScaleReading("  2.50 lb")).toBeNull();
    expect(parseScaleReading("ERR")).toBeNull();
    expect(parseScaleReading("")).toBeNull();
  });
});

describe("readScaleLines", () => {
  it("splits a stream into readings, across chunks", async () => {
    const chunks = ["ST,GS,+  1.2", "34kg\r\nUS,GS,+  0.9", "00kg\r\n", "garbage\r\n"];
    const stream = new ReadableStream<string>({
      start(c) {
        chunks.forEach((x) => c.enqueue(x));
        c.close();
      },
    });
    const got: ScaleReading[] = [];
    await readScaleLines(stream, (r) => got.push(r));
    expect(got).toEqual([
      { kg: 1.234, stable: true },
      { kg: 0.9, stable: false },
    ]);
  });
});

/** A port that behaves like Web Serial: it will not close while its streams are in use. */
function fakePort(lines: string[]) {
  let push: ReadableStreamDefaultController<Uint8Array> | null = null;
  const written: string[] = [];
  const port = {
    readable: null as ReadableStream<Uint8Array> | null,
    writable: null as WritableStream<Uint8Array> | null,
    open: vi.fn(async () => {
      if (port.readable) throw new Error("The port is already open.");
      port.readable = new ReadableStream<Uint8Array>({
        start(c) {
          push = c;
          for (const l of lines) c.enqueue(new TextEncoder().encode(l));
        },
      });
      port.writable = new WritableStream<Uint8Array>({ write: (b) => void written.push(new TextDecoder().decode(b)) });
    }),
    close: vi.fn(async () => {
      if (port.readable?.locked || port.writable?.locked) throw new Error("Cannot close a locked stream");
      port.readable = null;
      port.writable = null;
    }),
  };
  return { port, written, send: (l: string) => push?.enqueue(new TextEncoder().encode(l)) };
}

describe("scale connection", () => {
  it("reads, lets go of the port on disconnect, and connects again", async () => {
    const fake = fakePort(["ST,GS,+  1.250kg\r\n"]);
    Object.defineProperty(globalThis.navigator, "serial", {
      configurable: true,
      value: { requestPort: async () => fake.port, getPorts: async () => [fake.port] },
    });
    const wait = () => new Promise((r) => setTimeout(r, 20));

    await connectScale({ baudRate: 9600, request: "W" });
    await wait();
    expect(getScaleState()).toMatchObject({ status: "on", reading: { kg: 1.25, stable: true } });
    fake.send("US,GS,+  0.500kg\r\n");
    await wait();
    expect(getScaleState().reading).toEqual({ kg: 0.5, stable: false });

    await disconnectScale();
    expect(fake.port.readable).toBeNull(); // really closed
    expect(getScaleState()).toMatchObject({ status: "off", reading: null });

    await connectScale({ baudRate: 9600, request: "none" });
    await wait();
    expect(getScaleState()).toMatchObject({ status: "on", error: null, reading: { kg: 1.25 } });
    await disconnectScale();
    expect(fake.port.close).toHaveBeenCalledTimes(2);
  });
});
