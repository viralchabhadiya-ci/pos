import { useState, type FormEvent } from "react";
import { Field } from "../components/Field.js";
import { Icon } from "../components/Icon.js";
import { Modal } from "../components/Modal.js";
import { EmptyState, ErrorState, SkeletonRows } from "../components/States.js";
import { useToast } from "../components/Toast.js";
import { api, errorText } from "../lib/api.js";
import type { Category } from "../lib/types.js";
import { useLoad } from "../lib/useLoad.js";

export function Categories() {
  const list = useLoad(() => api<{ categories: Category[] }>("/categories"), []);
  const [editing, setEditing] = useState<Category | "new" | null>(null);
  const cats = list.data?.categories ?? [];

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Categories</h1>
          <p className="muted">Categories become the quick buttons on the till, in this order.</p>
        </div>
        <button type="button" className="btn primary" onClick={() => setEditing("new")}>
          <Icon name="plus" /> Add category
        </button>
      </header>
      {list.error ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : list.loading && !list.data ? (
        <SkeletonRows rows={4} />
      ) : cats.length === 0 ? (
        <EmptyState icon="tag" title="No categories yet">
          <button type="button" className="btn primary" onClick={() => setEditing("new")}>
            <Icon name="plus" /> Add your first category
          </button>
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Categories</caption>
            <thead>
              <tr>
                <th scope="col" className="num">Order</th>
                <th scope="col">Category</th>
                <th scope="col" className="num">Products</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {cats.map((c) => (
                <tr key={c.id} className={c.active ? undefined : "dim"}>
                  <td className="num muted">{c.sort}</td>
                  <td>
                    <span className="cell-main">{c.name}</span>
                    {c.nameAr && (
                      <span className="cell-sub" dir="rtl" lang="ar">
                        {c.nameAr}
                      </span>
                    )}
                    {!c.active && <span className="badge">Hidden</span>}
                  </td>
                  <td className="num">{c.productCount}</td>
                  <td className="actions">
                    <button type="button" className="btn ghost sm" onClick={() => setEditing(c)} aria-label={`Edit ${c.name}`}>
                      <Icon name="edit" size={18} /> <span className="hide-xs">Edit</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <CategoryDialog
          category={editing === "new" ? null : editing}
          nextSort={cats.length ? Math.max(...cats.map((c) => c.sort)) + 1 : 0}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void list.reload();
          }}
        />
      )}
    </div>
  );
}

function CategoryDialog({
  category,
  nextSort,
  onClose,
  onSaved,
}: {
  category: Category | null;
  nextSort: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(category?.name ?? "");
  const [nameAr, setNameAr] = useState(category?.nameAr ?? "");
  const [sort, setSort] = useState(String(category?.sort ?? nextSort));
  const [active, setActive] = useState(category?.active ?? true);
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setNameError("Enter a name, like Beverages");
      document.getElementById("cf-name")?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    const body = { name, nameAr: nameAr || null, sort: Math.max(0, Math.round(Number(sort) || 0)), active };
    try {
      if (category) await api(`/categories/${category.id}`, { method: "PUT", body });
      else await api("/categories", { body });
      toast(category ? `${name} saved` : `${name} added`);
      onSaved();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label={category ? `Edit ${category.name}` : "Add category"}>
      <h2>{category ? "Edit category" : "Add category"}</h2>
      <form onSubmit={submit} noValidate>
        <Field id="cf-name" label="Name" required error={nameError}>
          {(p) => <input {...p} value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={80} />}
        </Field>
        <Field label="Arabic name">
          {(p) => <input {...p} dir="rtl" lang="ar" value={nameAr} onChange={(e) => setNameAr(e.target.value)} maxLength={80} />}
        </Field>
        <Field label="Order on the till" hint="Lower numbers show first.">
          {(p) => <input {...p} type="number" min={0} inputMode="numeric" value={sort} onChange={(e) => setSort(e.target.value)} />}
        </Field>
        <label className="check">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span>
            Show on the till
            {category && category.productCount > 0 && !active && (
              <span className="hint">Its {category.productCount} products stay on sale and can still be found by search.</span>
            )}
          </span>
        </label>
        {error && (
          <p className="form-error" role="alert">
            <Icon name="alert" /> {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {busy ? "Saving…" : category ? "Save changes" : "Add category"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
