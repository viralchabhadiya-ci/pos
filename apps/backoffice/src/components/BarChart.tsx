import { useState } from "react";

export interface Bar {
  key: string;
  /** Axis label under the bar; leave empty to skip it on crowded axes. */
  label: string;
  value: number;
  /** Full text shown on hover or focus, e.g. "14:00 · AED 120.00 · 6 bills". */
  detail: string;
}

/**
 * A single-series bar chart in the accent colour. Each bar can be hovered or focused for
 * its exact value, and a table with the same numbers sits under it for screen readers
 * and for anyone who prefers figures.
 */
export function BarChart({
  bars,
  title,
  format,
  height = 180,
  tableHead,
}: {
  bars: Bar[];
  title: string;
  format: (v: number) => string;
  height?: number;
  tableHead: [string, string];
}) {
  const [active, setActive] = useState<string | null>(null);
  const max = Math.max(...bars.map((b) => b.value), 0);
  const top = max > 0 ? niceMax(max) : 1;
  const W = 100 / bars.length;
  const shown = bars.find((b) => b.key === active);
  return (
    <figure className="chart">
      <div className="chart-plot" style={{ height }} onMouseLeave={() => setActive(null)}>
        <div className="chart-grid" aria-hidden="true">
          <span>{format(top)}</span>
          <span>{format(top / 2)}</span>
          <span>0</span>
        </div>
        <div className="chart-bars" role="list" aria-label={title}>
          {bars.map((b) => {
            const h = b.value > 0 ? Math.max((b.value / top) * 100, 1.5) : 0;
            return (
              <div
                key={b.key}
                role="listitem"
                className={active === b.key ? "bar-slot active" : "bar-slot"}
                style={{ width: `${W}%` }}
                tabIndex={0}
                aria-label={b.detail}
                onMouseEnter={() => setActive(b.key)}
                onFocus={() => setActive(b.key)}
                onBlur={() => setActive(null)}
              >
                <div className="bar" style={{ height: `${h}%` }} />
              </div>
            );
          })}
        </div>
        {shown && (
          <div
            className="chart-tip"
            style={{ left: `${(bars.indexOf(shown) + 0.5) * W}%` }}
            aria-hidden="true"
          >
            {shown.detail}
          </div>
        )}
      </div>
      <div className="chart-axis" aria-hidden="true">
        {bars.map((b) => (
          <span key={b.key} style={{ width: `${W}%` }}>
            {b.label}
          </span>
        ))}
      </div>
      <details className="chart-table">
        <summary>Show as table</summary>
        <table>
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr>
              <th scope="col">{tableHead[0]}</th>
              <th scope="col" className="num">
                {tableHead[1]}
              </th>
            </tr>
          </thead>
          <tbody>
            {bars.map((b) => (
              <tr key={b.key}>
                <td>{b.detail.split(" · ")[0]}</td>
                <td className="num">{format(b.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

/** Rounds the axis top up to 1, 2 or 5 times a power of ten so gridlines read cleanly. */
function niceMax(v: number) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
