import { describe, expect, it } from "vitest";
import { splitCart } from "../screens/SplitDialog.js";
import { addItem, emptyCart, repriceCart, type Cart, type SellableItem } from "./cart.js";
import { kitchenLines, markSent, voidSent } from "./tabs.js";

const burger: SellableItem = { variantId: "bg", name: "Burger", price: 3000, taxId: null, uom: "unit" };
const tea: SellableItem = { variantId: "tea", name: "Tea", price: 500, taxId: null, uom: "unit" };
let n = 0;
const id = () => `l${++n}`;
const cheese = { groupId: "g", optionId: "c", name: "Cheese", price: 300 };

describe("restaurant cart", () => {
  it("prices modifiers into the line and keeps each made-to-order item on its own line", () => {
    let cart = addItem(emptyCart(), burger, 1, id, [cheese]);
    cart = addItem(cart, burger, 1, id, [cheese]);
    cart = addItem(cart, burger, 1, id);
    cart = addItem(cart, burger, 1, id);
    expect(cart.lines.map((l) => [l.qty, l.unitPrice, l.modifiers?.length ?? 0])).toEqual([
      [1, 3300, 1],
      [1, 3300, 1],
      [2, 3000, 0],
    ]);
    // A price list change keeps the modifiers on top.
    const repriced = repriceCart(cart, () => 2500);
    expect(repriced.lines.map((l) => l.unitPrice)).toEqual([2800, 2800, 2500]);
  });

  it("sends the kitchen only what is new, and cancels what was taken off", () => {
    let cart: Cart = addItem(addItem(emptyCart(), burger, 2, id), tea, 1, id);
    expect(kitchenLines(cart).map((l) => [l.name, l.qty])).toEqual([
      ["Burger", 2],
      ["Tea", 1],
    ]);
    cart = markSent(cart);
    expect(kitchenLines(cart)).toEqual([]);
    const b = cart.lines[0]!;
    cart = { ...voidSent(cart, b, 1), lines: cart.lines.map((l) => (l.id === b.id ? { ...l, qty: 1, sentQty: 1 } : l)) };
    cart = addItem(cart, tea, 2, id);
    expect(kitchenLines(cart).map((l) => [l.name, l.qty])).toEqual([
      ["Tea", 2],
      ["Burger", -1],
    ]);
    expect(markSent(cart).kitchenVoids).toEqual([]);
  });

  it("splits a bill: this guest's part is a sale of its own, the rest stays on the tab", () => {
    const base = markSent(addItem(addItem(emptyCart(), burger, 3, id), tea, 2, id));
    const cart: Cart = { ...base, tabId: "tab1", tabVersion: 4, tableId: "t1", tableName: "5", codes: ["X"], kitchenVoids: [] };
    const [b, t] = cart.lines;
    const { now, rest } = splitCart(cart, { [b!.id]: 1, [t!.id]: 2 }, () => "new");
    expect(now.tabId).toBeUndefined();
    expect(now.tabVersion).toBeUndefined();
    expect(now.codes).toEqual([]);
    expect(now.lines.map((l) => [l.id, l.name, l.qty, l.sentQty])).toEqual([
      ["new", "Burger", 1, 1],
      [t!.id, "Tea", 2, 2],
    ]);
    expect(rest.tabId).toBe("tab1");
    expect(rest.lines.map((l) => [l.id, l.qty, l.sentQty])).toEqual([[b!.id, 2, 2]]);
    // Nothing goes to the kitchen again because of a split.
    expect(kitchenLines(rest)).toEqual([]);
  });
});

describe("kitchen screen timers", () => {
  it("shows minutes and seconds and turns amber at 10 minutes, red at 20", async () => {
    const { ageClass, clock } = await import("../screens/KitchenScreen.js");
    expect(clock(65)).toBe("1:05");
    expect(clock(-3)).toBe("0:00");
    expect([ageClass(599), ageClass(600), ageClass(1200)]).toEqual(["", "warn", "late"]);
  });
});
