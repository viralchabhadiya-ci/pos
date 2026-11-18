import { useState } from "react";
import { aed } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { connectScale, disconnectScale, getScaleConfig, SCALE_REQUESTS, useScale, type ScaleConfig, type ScaleRequest } from "../lib/scaleReader.js";
import { Icon } from "./Icon.js";

const BAUD_RATES = [2400, 4800, 9600, 19200, 38400];
const REQUEST_LABEL: Record<ScaleRequest, string> = {
  none: "Sends by itself",
  W: "Asked with W",
  ENQ: "Asked with ENQ",
  P: "Asked with P",
};

/** The live weight, for the scale setup and the weigh screen. */
export function ScaleWeight({ pricePerKg }: { pricePerKg?: number }) {
  const scale = useScale();
  if (scale.status !== "on") return null;
  const r = scale.reading;
  return (
    <p className={r?.stable ? "scale-live steady" : "scale-live"} aria-live="polite">
      <Icon name="scale" size={20} />
      {r ? (
        <>
          <strong className="tnum">
            <bdi>{r.kg.toFixed(3)} kg</bdi>
          </strong>
          <span className="muted">{r.stable ? t("steady") : t("settling…")}</span>
          {pricePerKg !== undefined && r.kg > 0 && <span className="tnum">{aed(Math.round(pricePerKg * r.kg))}</span>}
        </>
      ) : (
        <span className="muted">{t("Waiting for the scale…")}</span>
      )}
    </p>
  );
}

/** Menu → Scale: pick the port, its speed and how it sends the weight. Kept per till. */
export function ScaleSetup({ onClose }: { onClose: () => void }) {
  const scale = useScale();
  const [config, setConfig] = useState<ScaleConfig>(getScaleConfig);
  if (scale.status === "unsupported") {
    return (
      <div className="scale-setup">
        <h2>{t("Scale")}</h2>
        <p className="error" role="alert">
          <Icon name="alert" size={18} />
          {t("This browser cannot reach a scale. Use Chrome or Edge on the till PC.")}
        </p>
        <p className="muted small">{t("Without a connected scale, type the weight, or scan the label the scale prints.")}</p>
        <div className="actions">
          <button type="button" className="btn primary" onClick={onClose}>
            {t("Done")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="scale-setup">
      <h2>{t("Scale")}</h2>
      <p className="muted small">{t("For a scale on this PC's serial or USB port. Settings are kept on this till.")}</p>
      <label htmlFor="scale-baud">{t("Speed (baud)")}</label>
      <select id="scale-baud" value={config.baudRate} onChange={(e) => setConfig({ ...config, baudRate: Number(e.target.value) })}>
        {BAUD_RATES.map((b) => (
          <option key={b} value={b}>
            {b}
          </option>
        ))}
      </select>
      <label htmlFor="scale-req">{t("How it sends the weight")}</label>
      <select id="scale-req" value={config.request} onChange={(e) => setConfig({ ...config, request: e.target.value as ScaleRequest })}>
        {(Object.keys(SCALE_REQUESTS) as ScaleRequest[]).map((r) => (
          <option key={r} value={r}>
            {t(REQUEST_LABEL[r])}
          </option>
        ))}
      </select>
      <p className="muted small">{t("The scale's manual gives these. Most send by itself at 9600.")}</p>
      <ScaleWeight />
      {scale.status === "error" && (
        <p className="error" role="alert">
          <Icon name="alert" size={18} />
          {t("Scale: {msg}", { msg: scale.error ?? "" })}
        </p>
      )}
      <div className="actions">
        {scale.status === "on" ? (
          <button type="button" className="btn ghost" onClick={() => void disconnectScale()}>
            {t("Disconnect")}
          </button>
        ) : null}
        <button type="button" className="btn outline" disabled={scale.status === "connecting"} onClick={() => void connectScale(config)}>
          <Icon name="scale" size={18} />
          {scale.status === "on" ? t("Connect again") : t("Connect scale")}
        </button>
        <button type="button" className="btn primary" onClick={onClose}>
          {t("Done")}
        </button>
      </div>
    </div>
  );
}
