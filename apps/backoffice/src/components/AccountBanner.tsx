import { dateTime, time } from "../lib/format.js";
import type { Me } from "../lib/types.js";
import { Icon } from "./Icon.js";

const DAY = 86_400_000;

/**
 * One line above every page when something about the account needs attention: a support
 * session in progress, a trial that is ending, or a payment that is overdue.
 */
export function AccountBanner({ me, onEndSupport }: { me: Me; onEndSupport: () => void }) {
  if (me.support) {
    return (
      <div className="account-banner support" role="status">
        <Icon name="user" />
        <span>
          <strong>Support session</strong> by {me.support.by} until {time(me.support.endsAt)}. {me.support.reason}
        </span>
        <button type="button" className="btn sm" onClick={onEndSupport}>
          End session
        </button>
      </div>
    );
  }
  const a = me.account;
  if (a.status === "trial" && a.trialEndsAt) {
    const days = Math.ceil((Date.parse(a.trialEndsAt) - Date.now()) / DAY);
    if (days > 7) return null;
    return (
      <div className={days <= 2 ? "account-banner warn" : "account-banner"} role="status">
        <Icon name="history" />
        <span>
          {days > 0
            ? `Your free trial ends in ${days} day${days === 1 ? "" : "s"} (${dateTime(a.trialEndsAt)}).`
            : "Your free trial has ended."}{" "}
          Your tills keep selling; contact us to choose a plan.
        </span>
      </div>
    );
  }
  if (a.status === "past_due") {
    return (
      <div className="account-banner warn" role="status">
        <Icon name="alert" />
        <span>Your subscription payment is overdue. Your tills keep selling; contact us to settle it.</span>
      </div>
    );
  }
  return null;
}
