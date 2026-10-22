import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { Icon } from "../components/Icon.js";
import { Modal } from "../components/Modal.js";
import { db, type DeviceSetup, type LocalOrder, type User } from "../lib/db.js";
import { money, qtyText } from "../lib/format.js";
import { needsDrawer, printOnHub, receiptDoc } from "../lib/print.js";
import { useSyncStatus } from "../lib/useSync.js";

/** Orders already sent to the printer, so a re-render (or React's dev double effect) never prints twice. */
const autoPrinted = new Set<string>();

/**
 * Bilingual simplified tax invoice (or tax credit note for refunds) with the fields UAE
 * VAT rules ask for: seller name, address and TRN, date, sequential number, items, VAT
 * amount and the total including VAT. With a store hub that has a printer, the receipt
 * prints there by itself and a cash sale opens the drawer; otherwise the browser prints.
 */
export function ReceiptView({ setup, order, cashier, onClose }: { setup: DeviceSetup; order: LocalOrder; cashier: User; onClose: () => void }) {
  const original = useLiveQuery(
    () => (order.refundOfOrderId ? db.orders.get(order.refundOfOrderId) : undefined),
    [order.refundOfOrderId],
  );
  const methods = useLiveQuery(() => db.paymentMethods.toArray(), []) ?? [];
  const refund = order.refundOfOrderId !== null;
  const date = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: setup.store.timezone,
  }).format(new Date(order.createdAt));
  const uomOf = (qty: number) => (Number.isInteger(qty) ? "unit" : "kg");
  const hubPrinter = useSyncStatus().hub?.printer ?? null;
  const [printError, setPrintError] = useState<string | null>(null);

  const printHere = async (first: boolean) => {
    const methodRows = await db.paymentMethods.toArray();
    const originalNumber = order.refundOfOrderId ? (await db.orders.get(order.refundOfOrderId))?.number : undefined;
    const doc = receiptDoc(setup, order, {
      cashierName: cashier.name,
      methods: methodRows,
      originalNumber,
      openDrawer: first && needsDrawer(order),
    });
    try {
      await printOnHub(doc);
      setPrintError(null);
    } catch (err) {
      setPrintError(`Printer: ${(err as Error).message}`);
    }
  };

  useEffect(() => {
    if (!hubPrinter || autoPrinted.has(order.id)) return;
    autoPrinted.add(order.id);
    void printHere(true);
    // Printing once per order is the point; later changes must not reprint.
  }, [hubPrinter, order.id]);

  return (
    <Modal onClose={onClose} label={refund ? "Refund complete" : "Sale complete"}>
      <div className="done-head noprint">
        <span className="tick" aria-hidden="true">
          <Icon name="check" size={24} />
        </span>
        <div>
          <h2>{refund ? "Refund complete" : "Sale complete"}</h2>
          {order.payment.change > 0 ? (
            <p className="good" style={{ margin: 0, fontWeight: 700 }}>
              Give change {money(order.payment.change)} AED
            </p>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              {hubPrinter ? "Receipt sent to the printer." : order.number}
            </p>
          )}
        </div>
      </div>
      <div className="receipt" id="receipt">
        <div className="r-center">
          <strong>{setup.store.name}</strong>
          {setup.store.nameAr && <div dir="rtl" lang="ar">{setup.store.nameAr}</div>}
          {setup.store.address && <div>{setup.store.address}</div>}
          {setup.store.trn && <div>TRN / الرقم الضريبي: {setup.store.trn}</div>}
          <div className="r-title">{refund ? "Tax Credit Note / إشعار دائن ضريبي" : "Tax Invoice / فاتورة ضريبية"}</div>
        </div>
        <div className="r-row">
          <span>No. {order.number}</span>
          <span>{date}</span>
        </div>
        {refund && <div>Ref. invoice: {original?.number ?? order.refundOfOrderId}</div>}
        <div>Cashier: {cashier.name}</div>
        <hr />
        {order.totals.lines.map((l) => (
          <div key={l.id} className="r-line">
            <div>{l.name}</div>
            <div className="r-row">
              <span>
                {qtyText(Math.abs(l.qty), uomOf(l.qty))} × {money(l.unitPrice)}
                {l.lineDiscount ? ` (-${money(Math.abs(l.lineDiscount))})` : ""}
              </span>
              <span>{money(l.gross)}</span>
            </div>
          </div>
        ))}
        <hr />
        <div className="r-row">
          <span>Total excl. VAT / المجموع بدون الضريبة</span>
          <span>{money(order.totals.subtotalNet)}</span>
        </div>
        {order.totals.taxes.map((t) => (
          <div key={t.taxId} className="r-row">
            <span>VAT {t.rateBp / 100}% / ضريبة القيمة المضافة</span>
            <span>{money(t.tax)}</span>
          </div>
        ))}
        <div className="r-row r-total">
          <span>Total AED / الإجمالي</span>
          <span>{money(order.totals.total)}</span>
        </div>
        {order.payment.cashRounding !== 0 && (
          <>
            <div className="r-row">
              <span>Cash rounding</span>
              <span>{money(order.payment.cashRounding)}</span>
            </div>
            <div className="r-row r-total">
              <span>Payable / المبلغ المستحق</span>
              <span>{money(order.payment.due)}</span>
            </div>
          </>
        )}
        <hr />
        {order.payments.map((p) => (
          <div key={p.id} className="r-row">
            <span>{methods.find((m) => m.id === p.methodId)?.name ?? p.kind}</span>
            <span>{money(p.tendered ?? p.amount)}</span>
          </div>
        ))}
        {order.payment.change > 0 && (
          <div className="r-row">
            <span>Change / الباقي</span>
            <span>{money(order.payment.change)}</span>
          </div>
        )}
        {setup.store.receiptFooter && <p className="r-center">{setup.store.receiptFooter}</p>}
      </div>
      {printError && (
        <p className="error noprint" role="alert">
          <Icon name="alert" size={18} />
          {printError}
        </p>
      )}
      <div className="actions noprint">
        <button type="button" className="btn outline" onClick={() => (hubPrinter ? void printHere(false) : window.print())}>
          <Icon name="printer" />
          {hubPrinter ? "Print again" : "Print"}
        </button>
        <button type="button" className="btn primary lg" onClick={onClose} autoFocus>
          New sale
        </button>
      </div>
    </Modal>
  );
}
