import { useState } from "react";
import { Icon } from "../components/Icon.js";
import { Modal } from "../components/Modal.js";
import type { LineModifier } from "../lib/cart.js";
import type { ModifierGroup } from "../lib/db.js";
import { money } from "../lib/format.js";
import { t } from "../lib/i18n.js";

function rule(g: ModifierGroup): string {
  if (g.maxChoices === 1) return g.minChoices ? t("Pick 1") : t("Optional, pick 1");
  if (g.maxChoices === 0) return g.minChoices ? t("Pick at least {n}", { n: g.minChoices }) : t("Optional, pick any");
  return g.minChoices ? t("Pick {min} to {max}", { min: g.minChoices, max: g.maxChoices }) : t("Optional, up to {n}", { n: g.maxChoices });
}

/** Choices for an item before it goes on the sale: size, extras, "no onion". */
export function ModifierDialog({
  name,
  basePrice,
  groups,
  onAdd,
  onClose,
}: {
  name: string;
  basePrice: number;
  groups: ModifierGroup[];
  onAdd: (mods: LineModifier[]) => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [tried, setTried] = useState(false);

  const toggle = (g: ModifierGroup, optionId: string) =>
    setPicked((p) => {
      const now = p[g.id] ?? [];
      if (now.includes(optionId)) return { ...p, [g.id]: now.filter((x) => x !== optionId) };
      if (g.maxChoices === 1) return { ...p, [g.id]: [optionId] };
      if (g.maxChoices && now.length >= g.maxChoices) return p;
      return { ...p, [g.id]: [...now, optionId] };
    });

  const missing = groups.filter((g) => (picked[g.id]?.length ?? 0) < g.minChoices);
  const mods: LineModifier[] = groups.flatMap((g) =>
    g.options.filter((o) => picked[g.id]?.includes(o.id)).map((o) => ({ groupId: g.id, optionId: o.id, name: o.name, price: o.price })),
  );
  const price = basePrice + mods.reduce((s, m) => s + m.price, 0);

  return (
    <Modal onClose={onClose} label={name} wide>
      <h2>{name}</h2>
      <div className="mod-groups">
        {groups.map((g) => {
          const short = tried && missing.includes(g);
          return (
            <fieldset key={g.id} className={short ? "mod-group short" : "mod-group"}>
              <legend>
                <strong>{g.name}</strong>
                {g.nameAr && (
                  <span className="muted" dir="rtl" lang="ar">
                    {" "}
                    {g.nameAr}
                  </span>
                )}
                <span className={short ? "mod-rule error-text" : "mod-rule muted"}>{rule(g)}</span>
              </legend>
              <div className="mod-options">
                {g.options.map((o) => {
                  const on = !!picked[g.id]?.includes(o.id);
                  return (
                    <button key={o.id} type="button" className={on ? "mod on" : "mod"} aria-pressed={on} onClick={() => toggle(g, o.id)}>
                      {on && <Icon name="check" size={18} />}
                      <span className="mod-name">{o.name}</span>
                      {o.price > 0 && <span className="mod-price tnum">+{money(o.price)}</span>}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          );
        })}
      </div>
      {tried && missing.length > 0 && (
        <p className="error" role="alert">
          <Icon name="alert" size={18} />
          {t("Choose {name} first.", { name: missing.map((g) => g.name).join(", ") })}
        </p>
      )}
      <div className="actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          {t("Cancel")}
        </button>
        <button
          type="button"
          className="btn primary"
          onClick={() => {
            setTried(true);
            if (!missing.length) onAdd(mods);
          }}
        >
          {t("Add")} · <bdi className="tnum">{money(price)}</bdi>
        </button>
      </div>
    </Modal>
  );
}
