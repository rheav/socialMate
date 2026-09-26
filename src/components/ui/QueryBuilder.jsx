import { useState } from "react";
import { ChevronDown, ChevronRight, Plus, X, ArrowDown, ArrowUp } from "lucide-react";
import { QUERY_OPS, isSortableField } from "@/lib/shared/feedQuery";
import { cn } from "@/lib/utils";

// Rule builder for the feed query: filters (field / operator / value, joined by
// E or OU) and tie-break sorts after the toolbar's primary "Ordenar por". The
// query is the same object the page's grid sorter reads, so every rule here also
// hides/reorders tiles on instagram.com / tiktok.com.

const OP_LABEL = {
  gte: "≥ pelo menos",
  lte: "≤ no máximo",
  gt: "> maior que",
  lt: "< menor que",
  between: "entre",
  eq: "= igual a",
  neq: "≠ diferente de",
  contains: "contém",
  notContains: "não contém",
  isAnyOf: "é um de",
  notEmpty: "tem valor",
};

const ctl =
  "h-7 rounded-md border border-border bg-background px-1.5 text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring";

// A date rule stores unix SECONDS (what the records carry); the input speaks
// yyyy-mm-dd in local time.
const toDateInput = (sec) => {
  if (sec == null || sec === "") return "";
  const d = new Date(Number(sec) * 1000);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const fromDateInput = (s, endOfDay) => {
  if (!s) return null;
  const [y, m, d] = s.split("-").map(Number);
  const t = endOfDay ? new Date(y, m - 1, d, 23, 59, 59) : new Date(y, m - 1, d);
  return Math.floor(t.getTime() / 1000);
};

function ValueInput({ def, value, onChange, endOfDay }) {
  if (def.kind === "date")
    return (
      <input type="date" className={cn(ctl, "w-[118px]")} value={toDateInput(value)} onChange={(e) => onChange(fromDateInput(e.target.value, endOfDay))} />
    );
  if (def.kind === "text")
    return <input type="text" className={cn(ctl, "min-w-0 flex-1")} placeholder="texto" value={value ?? ""} onChange={(e) => onChange(e.target.value)} />;
  return (
    <input
      type="number"
      step="any"
      className={cn(ctl, "w-20 tabular-nums")}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
    />
  );
}

function EnumChips({ def, value, onChange }) {
  const picked = new Set(Array.isArray(value) ? value : []);
  return (
    <div className="flex flex-wrap gap-1">
      {def.values.map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => {
            const next = new Set(picked);
            next.has(v) ? next.delete(v) : next.add(v);
            onChange([...next]);
          }}
          className={cn(
            "h-6 rounded-full border px-2 text-[11px]",
            picked.has(v) ? "border-primary bg-primary/15 text-foreground" : "border-border text-muted-foreground",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export default function QueryBuilder({ query, setQuery, fields, primaryKey }) {
  const [open, setOpen] = useState(false);
  const keys = Object.keys(fields);
  const sortableKeys = keys.filter((k) => isSortableField(fields[k]));
  const n = query.filters.length + Math.max(0, query.sorts.length - 1);

  const setFilter = (i, patch) =>
    setQuery((q) => ({ ...q, filters: q.filters.map((f, j) => (j === i ? { ...f, ...patch } : f)) }));
  const addFilter = () => {
    const field = keys.find((k) => fields[k].kind === "number") || keys[0];
    setQuery((q) => ({ ...q, filters: [...q.filters, { field, op: QUERY_OPS[fields[field].kind][0], value: null, valueTo: null }] }));
  };
  const removeFilter = (i) => setQuery((q) => ({ ...q, filters: q.filters.filter((_, j) => j !== i) }));
  const changeField = (i, field) => {
    // A new field may be a different kind — reset the operator and the value.
    const op = QUERY_OPS[fields[field].kind][0];
    setFilter(i, { field, op, value: null, valueTo: null });
  };

  // Tie-breakers are sorts[1..]; sorts[0] is the toolbar's "Ordenar por".
  const extra = query.sorts.slice(1);
  const setExtra = (list) => setQuery((q) => ({ ...q, sorts: [...q.sorts.slice(0, 1), ...list] }));
  const usedSortKeys = new Set(query.sorts.map((s) => s.key));
  const addExtra = () => {
    const key = sortableKeys.find((k) => !usedSortKeys.has(k));
    if (key) setExtra([...extra, { key, dir: "desc" }]);
  };

  return (
    <div className="rounded-lg border border-border/70">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-[11.5px] font-medium text-foreground/85"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        Filtros e desempate
        {n > 0 && (
          <span className="ml-1 rounded-full bg-primary/15 px-1.5 text-[10.5px] font-semibold text-primary">{n}</span>
        )}
        {query.filters.length > 0 && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); setQuery((q) => ({ ...q, filters: [] })); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); setQuery((q) => ({ ...q, filters: [] })); } }}
            className="ml-auto text-[10.5px] text-muted-foreground hover:text-foreground"
          >
            limpar filtros
          </span>
        )}
      </button>

      {open && (
        <div className="space-y-3 border-t border-border/70 px-2.5 py-2.5">
          <p className="text-[10.5px] leading-snug text-muted-foreground">
            Vale para esta lista e para a grade na página do site (os posts que não passam somem de lá também).
          </p>

          <div className="space-y-1.5">
            {query.filters.length > 1 && (
              <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                Mostrar posts que atendem
                {[["all", "todas"], ["any", "qualquer uma"]].map(([v, l]) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setQuery((q) => ({ ...q, join: v }))}
                    className={cn(
                      "h-6 rounded-full border px-2",
                      query.join === v ? "border-primary bg-primary/15 text-foreground" : "border-border",
                    )}
                  >
                    {l}
                  </button>
                ))}
                as regras
              </div>
            )}
            {query.filters.map((f, i) => {
              const def = fields[f.field];
              return (
                <div key={i} className="flex flex-wrap items-center gap-1">
                  <select className={cn(ctl, "max-w-[132px]")} value={f.field} onChange={(e) => changeField(i, e.target.value)}>
                    {keys.map((k) => (
                      <option key={k} value={k}>{fields[k].label}</option>
                    ))}
                  </select>
                  <select className={ctl} value={f.op} onChange={(e) => setFilter(i, { op: e.target.value })}>
                    {QUERY_OPS[def.kind].map((op) => (
                      <option key={op} value={op}>{OP_LABEL[op]}</option>
                    ))}
                  </select>
                  {f.op !== "notEmpty" &&
                    (def.kind === "enum" ? (
                      <EnumChips def={def} value={f.value} onChange={(v) => setFilter(i, { value: v })} />
                    ) : (
                      <ValueInput def={def} value={f.value} onChange={(v) => setFilter(i, { value: v })} />
                    ))}
                  {f.op === "between" && (
                    <>
                      <span className="text-[11px] text-muted-foreground">e</span>
                      <ValueInput def={def} value={f.valueTo} endOfDay onChange={(v) => setFilter(i, { valueTo: v })} />
                    </>
                  )}
                  <button type="button" onClick={() => removeFilter(i)} className="ml-auto grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted" aria-label="Remover regra">
                    <X className="size-3.5" />
                  </button>
                </div>
              );
            })}
            <button type="button" onClick={addFilter} className="flex items-center gap-1 text-[11px] font-medium text-primary">
              <Plus className="size-3.5" /> Regra de filtro
            </button>
          </div>

          <div className="space-y-1.5">
            <div className="text-[11px] text-muted-foreground">
              {primaryKey === "default"
                ? "Escolha um “Ordenar por” para usar desempate."
                : `Depois de ${fields[primaryKey]?.label || primaryKey}, desempatar por:`}
            </div>
            {primaryKey !== "default" &&
              extra.map((s, i) => (
                <div key={s.key} className="flex items-center gap-1">
                  <select
                    className={cn(ctl, "max-w-[160px]")}
                    value={s.key}
                    onChange={(e) => setExtra(extra.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
                  >
                    {sortableKeys
                      .filter((k) => k === s.key || !usedSortKeys.has(k))
                      .map((k) => (
                        <option key={k} value={k}>{fields[k].label}</option>
                      ))}
                  </select>
                  <button
                    type="button"
                    className={cn(ctl, "flex items-center gap-1")}
                    onClick={() => setExtra(extra.map((x, j) => (j === i ? { ...x, dir: x.dir === "desc" ? "asc" : "desc" } : x)))}
                  >
                    {s.dir === "desc" ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />}
                    {s.dir === "desc" ? "maior → menor" : "menor → maior"}
                  </button>
                  <button type="button" onClick={() => setExtra(extra.filter((_, j) => j !== i))} className="ml-auto grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted" aria-label="Remover critério">
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
            {primaryKey !== "default" && sortableKeys.some((k) => !usedSortKeys.has(k)) && (
              <button type="button" onClick={addExtra} className="flex items-center gap-1 text-[11px] font-medium text-primary">
                <Plus className="size-3.5" /> Critério de desempate
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
