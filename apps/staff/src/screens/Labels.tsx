import { Empty, ErrorState, Skeleton } from "../components/States.js";
import { api } from "../lib/api.js";
import { shortDate } from "../lib/format.js";
import { useLoad } from "../lib/useLoad.js";

interface Request {
  id: string;
  name: string;
  copies: number;
  createdAt: string;
  requestedBy: string | null;
}

/** Labels asked for in this store that the back office has not printed yet. */
export function Labels() {
  const list = useLoad(() => api<{ requests: Request[] }>("/staff/labels"), []);
  if (list.error) return <ErrorState message={list.error} onRetry={list.reload} />;
  if (!list.data) return <Skeleton />;
  return (
    <>
      <p className="muted">
        Ask for a label from the price check. The back office prints the list from Scales &amp; labels, on an A4 sheet or the label printer.
      </p>
      {list.data.requests.length === 0 ? (
        <Empty title="No labels waiting" text="Everything asked for has been printed." />
      ) : (
        <div className="card">
          <h2>Waiting to print</h2>
          <ul className="list">
            {list.data.requests.map((r) => (
              <li key={r.id}>
                <span className="grow">
                  <span className="title">{r.name}</span>
                  <span className="sub">
                    {r.requestedBy ?? "Someone"} · {shortDate(r.createdAt)}
                  </span>
                </span>
                <span className="amount">× {r.copies}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
