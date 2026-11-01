import type { DisplayState } from "@pos/core";
import { useEffect, useRef, useState } from "react";
import { Qr } from "../components/Qr.js";
import type { DeviceSetup } from "../lib/db.js";
import { onLocalDisplay, pollDisplay } from "../lib/display.js";
import { money, qtyText } from "../lib/format.js";

/**
 * The customer-facing screen: welcome, then the cart as it is scanned, then thank you with
 * the change and a QR to the digital receipt. `remote` is a separately paired display that
 * follows its register through the hub or cloud; otherwise it is a second window on the till.
 */
export function DisplayScreen({ setup, remote }: { setup: DeviceSetup; remote: boolean }) {
  const [state, setState] = useState<DisplayState | null>(null);
  const [connected, setConnected] = useState(true);
  const list = useRef<HTMLOListElement>(null);

  useEffect(() => onLocalDisplay(setState), []);

  useEffect(() => {
    if (!remote) return;
    let stop = false;
    let version = 0;
    void (async () => {
      while (!stop) {
        try {
          const res = await pollDisplay(version);
          setConnected(true);
          if (res.version !== version && res.state) setState(res.state);
          version = res.version;
        } catch {
          setConnected(false);
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    })();
    return () => {
      stop = true;
    };
  }, [remote]);

  useEffect(() => {
    list.current?.lastElementChild?.scrollIntoView({ block: "end" });
  }, [state?.lines.length]);

  const storeName = state?.storeName ?? setup.store.name;
  const storeNameAr = state?.storeNameAr ?? setup.store.nameAr;

  return (
    <main className="cdisplay">
      <header className="cd-head">
        <span className="cd-store">{storeName}</span>
        {storeNameAr && (
          <span className="cd-store" dir="rtl" lang="ar">
            {storeNameAr}
          </span>
        )}
      </header>
      {!state || state.kind === "idle" ? (
        <section className="cd-welcome">
          <p className="cd-big">Welcome</p>
          <p className="cd-big" dir="rtl" lang="ar">
            أهلاً وسهلاً
          </p>
        </section>
      ) : state.kind === "paid" && state.paid ? (
        <section className="cd-thanks" aria-live="polite">
          <p className="cd-big">Thank you · شكراً لكم</p>
          <dl className="cd-paid">
            <dt>Total</dt>
            <dd>AED {money(state.paid.due)}</dd>
            {state.paid.change > 0 && (
              <>
                <dt>Change · الباقي</dt>
                <dd className="cd-change">AED {money(state.paid.change)}</dd>
              </>
            )}
          </dl>
          {state.paid.receiptUrl && (
            <div className="cd-qr">
              <Qr text={state.paid.receiptUrl} size={220} label="QR code for your digital receipt" />
              <p>Scan for your receipt · امسح للحصول على الإيصال</p>
            </div>
          )}
        </section>
      ) : (
        <section className="cd-cart" aria-live="polite">
          {state.refund && <p className="cd-refund">Refund · استرداد</p>}
          <ol className="cd-lines" ref={list}>
            {state.lines.map((l, i) => (
              <li key={i}>
                <span className="cd-name">
                  {l.name}
                  {l.nameAr && (
                    <span dir="rtl" lang="ar">
                      {l.nameAr}
                    </span>
                  )}
                </span>
                <span className="cd-qty">{qtyText(Math.abs(l.qty), l.uom)}</span>
                <span className="cd-amt">{money(l.gross)}</span>
              </li>
            ))}
          </ol>
          <dl className="cd-totals">
            {state.discountTotal !== 0 && (
              <>
                <dt>Discount · خصم</dt>
                <dd>-{money(state.discountTotal)}</dd>
              </>
            )}
            <dt>VAT · ضريبة القيمة المضافة</dt>
            <dd>{money(state.taxTotal)}</dd>
            <dt className="cd-grand">Total · الإجمالي</dt>
            <dd className="cd-grand">AED {money(state.total)}</dd>
          </dl>
        </section>
      )}
      {remote && !connected && <p className="cd-offline">Reconnecting to the till…</p>}
    </main>
  );
}
