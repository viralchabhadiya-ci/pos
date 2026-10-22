import { useLiveQuery } from "dexie-react-hooks";
import { Modal } from "../components/Modal.js";
import { db, type DeviceSetup, type LocalOrder, type User } from "../lib/db.js";
import { money, qtyText } from "../lib/format.js";

/**
 * Bilingual simplified tax invoice (or tax credit note for refunds) with the fields UAE
 * VAT rules ask for: seller name, address and TRN, date, sequential number, items, VAT
 * amount and the total including VAT. Printing goes through the browser for now; the
 * store hub will send the same content to ESC/POS printers.
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

  return (
    <Modal onClose={onClose}>
      <div className="receipt" id="receipt">
        <div className="r-center">
          <strong>{setup.store.name}</strong>
          {setup.store.nameAr && <div dir="rtl">{setup.store.nameAr}</div>}
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
      <div className="actions noprint">
        <button type="button" className="btn ghost" onClick={() => window.print()}>
          Print
        </button>
        <button type="button" className="btn primary" onClick={onClose} autoFocus>
          New sale
        </button>
      </div>
    </Modal>
  );
}
