import { describe, expect, it } from "vitest";
import { maskGiftCard, maxRedeemablePoints, newGiftCardCode, pointsEarned, pointsEligible, pointsForRefund, pointsValue } from "./loyalty.js";

const s = { enabled: true, pointsPerAed: 1, pointValueFils: 1, minRedeemPoints: 100 };

describe("loyalty", () => {
  it("earns on goods, not on gift cards bought or what points paid", () => {
    const lines = [{ gross: 2900 }, { gross: 10000, giftCardCode: "GIFT-1" }];
    expect(pointsEligible(lines, [{ kind: "card", amount: 12900 }])).toBe(2900);
    expect(pointsEligible(lines, [{ kind: "points", amount: 400 }, { kind: "card", amount: 12500 }])).toBe(2500);
    expect(pointsEligible([{ gross: 300 }], [{ kind: "points", amount: 300 }])).toBe(0);
    expect(pointsEligible([{ gross: -1450 }], [{ kind: "cash", amount: -1450 }])).toBe(-1450);
    expect(pointsEarned(2999, s)).toBe(29);
    expect(pointsEarned(2999, { pointsPerAed: 3 })).toBe(89);
  });

  it("limits a spend by balance, what is due and the minimum", () => {
    expect(maxRedeemablePoints(2500, 1450, s)).toBe(1450);
    expect(maxRedeemablePoints(500, 1450, s)).toBe(500);
    expect(maxRedeemablePoints(99, 1450, s)).toBe(0);
    expect(maxRedeemablePoints(1000, 99, s)).toBe(0);
    expect(maxRedeemablePoints(1000, 1001, { pointValueFils: 5, minRedeemPoints: 0 })).toBe(200);
    expect(pointsValue(400, s)).toBe(400);
    expect(pointsForRefund(-1001, { pointValueFils: 5 })).toBe(201);
  });

  it("makes 16-digit card numbers and masks them", () => {
    const code = newGiftCardCode();
    expect(code).toMatch(/^[1-9]\d{15}$/);
    expect(newGiftCardCode()).not.toBe(code);
    expect(maskGiftCard("1234567890123456")).toBe("•••• 3456");
    expect(maskGiftCard("ABC")).toBe("ABC");
    expect(maskGiftCard("GIFT-DEMO-100")).toBe("•••• O100");
  });
});
