import { useState } from "react";
import { Icon } from "../components/Icon.js";
import { ManagerPin } from "../components/ManagerPin.js";
import { Modal } from "../components/Modal.js";
import type { DeviceSetup, Session, User } from "../lib/db.js";
import { tryParseMoney } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { getReceiptLang, openDrawerOnHub, printOnHub, setReceiptLang, shiftReportDoc, type ReceiptLang } from "../lib/print.js";
import { addCashMove, shiftSummary } from "../lib/till.js";
import { useSyncStatus } from "../lib/useSync.js";

interface Props {
  setup: DeviceSetup;
  session: Session;
  user: User;
  onCloseShift: () => void;
  onLogout: () => void;
  onClose: () => void;
}

export function MenuDialog({ setup, session, user, onCloseShift, onLogout, onClose }: Props) {
  const [cash, setCash] = useState<"in" | "out" | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawerPin, setDrawerPin] = useState(false);
  const hasDrawer = !!useSyncStatus().hub?.printer;
  const [receiptLang, setReceiptLangState] = useState<ReceiptLang>(getReceiptLang);
  const changeReceiptLang = (lang: ReceiptLang) => {
    setReceiptLang(lang);
    setReceiptLangState(lang);
    setDone(lang === "bilingual" ? t("Receipts print in English and Arabic") : t("Receipts print in English only"));
  };

  const openDrawer = async () => {
    setDrawerPin(false);
    try {
      await openDrawerOnHub();
      setDone(t("Drawer opened"));
      setError(null);
    } catch (err) {
      setError(t("Drawer: {msg}", { msg: (err as Error).message }));
    }
  };

  const printX = async () => {
    try {
      await printOnHub(shiftReportDoc(setup, session, await shiftSummary(session), { kind: "X", userName: user.name }));
      setDone(t("X report sent to the printer"));
      setError(null);
    } catch (err) {
      setError(t("Printer: {msg}", { msg: (err as Error).message }));
    }
  };

  const openCustomerScreen = () => {
    // Drag this window to the customer-facing screen and make it full screen.
    window.open(`${window.location.pathname}#display`, "pos-customer-display", "popup,width=1024,height=640");
    setDone(t("Customer screen opened in a new window"));
  };

  if (drawerPin) {
    return <ManagerPin reason={t("Open the cash drawer without a sale")} onApprove={() => void openDrawer()} onCancel={() => setDrawerPin(false)} />;
  }

  const saveCash = async () => {
    const minor = tryParseMoney(amount);
    if (!cash) return;
    if (minor === null || minor <= 0) return setError(t("Enter an amount, e.g. 200.00"));
    if (!reason.trim()) return setError(t("Add a reason so the manager can match it later"));
    setError(null);
    await addCashMove(session.id, user.id, cash, minor, reason.trim());
    setDone(t(cash === "in" ? "Recorded cash in of {amount}" : "Recorded cash out of {amount}", { amount }));
    setCash(null);
    setAmount("");
    setReason("");
  };

  return (
    <Modal onClose={onClose} label={cash ? t(cash === "in" ? "Cash in" : "Cash out") : t("Menu")}>
      {cash ? (
        <>
          <h2>{t(cash === "in" ? "Cash in" : "Cash out")}</h2>
          <label htmlFor="cm-amount">{t("Amount (AED)")}</label>
          <input id="cm-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
          <label htmlFor="cm-reason">{t("Reason")}</label>
          <input id="cm-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={cash === "out" ? t("Bank drop, supplier payment…") : t("Change top-up…")} />
          {error && (
            <p className="error" role="alert">
              <Icon name="alert" size={18} />
              {error}
            </p>
          )}
          <div className="actions">
            <button type="button" className="btn ghost" onClick={() => { setCash(null); setError(null); }}>
              {t("Back")}
            </button>
            <button type="button" className="btn primary" onClick={saveCash}>
              {t("Save")}
            </button>
          </div>
        </>
      ) : (
        <div className="menu">
          <h2>{t("Menu")}</h2>
          <div role="status" aria-live="polite">
            {done && (
              <p className="good" style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 600 }}>
                <Icon name="check" size={18} />
                {done}
              </p>
            )}
          </div>
          {error && (
            <p className="error" role="alert">
              <Icon name="alert" size={18} />
              {error}
            </p>
          )}
          <button type="button" className="btn block" onClick={() => setCash("in")}>
            <Icon name="cash" />
            {t("Cash in")}
          </button>
          <button type="button" className="btn block" onClick={() => setCash("out")}>
            <Icon name="cash" />
            {t("Cash out")}
          </button>
          {hasDrawer && (
            <button type="button" className="btn block" onClick={() => setDrawerPin(true)}>
              <Icon name="drawer" />
              {t("Open drawer")}
            </button>
          )}
          {hasDrawer && (
            <button type="button" className="btn block" onClick={() => void printX()}>
              <Icon name="printer" />
              {t("Print X report")}
            </button>
          )}
          <button type="button" className="btn block" onClick={openCustomerScreen}>
            <Icon name="monitor" />
            {t("Customer screen on this PC")}
          </button>
          <fieldset className="segmented">
            <legend>{t("Printed receipts")}</legend>
            {(["bilingual", "en"] as const).map((lang) => (
              <button key={lang} type="button" className={receiptLang === lang ? "chip on" : "chip"} aria-pressed={receiptLang === lang} onClick={() => changeReceiptLang(lang)}>
                {lang === "bilingual" ? t("English + Arabic") : t("English only")}
              </button>
            ))}
          </fieldset>
          <hr />
          <button type="button" className="btn block ghost" onClick={onLogout}>
            <Icon name="logout" />
            {t("Switch cashier")}
          </button>
          <button type="button" className="btn block outline danger" onClick={onCloseShift}>
            <Icon name="lock" />
            {t("Close shift")}
          </button>
        </div>
      )}
    </Modal>
  );
}
