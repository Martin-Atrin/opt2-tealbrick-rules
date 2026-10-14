// Decisions page: the log of what Rules decided (newest first), filtered by call id or by decision.
import { Button, EmptyState, Notice, SearchIcon, Select, Swatch, Tag, TextInput } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type DecisionRow, errorText, run, when } from "./api.ts";
import { DecisionTag, Head, LoadError, Loading } from "./shared.tsx";

type DecisionFilter = "" | "allow" | "deny" | "hold";
const SHOW = [
  { value: "", label: "all decisions" },
  { value: "deny", label: "refused" },
  { value: "hold", label: "held" },
  { value: "allow", label: "allowed" },
];

export function DecisionsPage() {
  const [items, setItems] = useState<DecisionRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<{ callId: string; decision: DecisionFilter }>({ callId: "", decision: "" });
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const query = useMemo(() => ({ ...(filter.callId ? { callId: filter.callId } : {}), ...(filter.decision ? { decision: filter.decision } : {}), limit: 50 }), [filter]);
  const load = useCallback(
    (more?: string | null) => {
      const mine = ++seq.current;
      setLoading(true);
      if (more) setMoreError(null);
      else setError(null);
      run("decisions_list", { ...query, ...(more ? { cursor: more } : {}) })
        .then((r) => {
          if (mine !== seq.current) return;
          setItems((prev) => (more ? [...(prev ?? []), ...r.items] : r.items));
          setCursor(r.nextCursor);
        })
        .catch((e) => {
          if (mine !== seq.current) return;
          if (more) setMoreError(errorText(e));
          else setError(errorText(e));
        })
        .finally(() => {
          if (mine === seq.current) setLoading(false);
        });
    },
    [query],
  );
  useEffect(() => load(), [load]);
  return (
    <section className="app-page" aria-label="Decisions">
      <Head title="Decisions" />
      <div className="toolbar">
        <div className="tb-search">
          <SearchIcon />
          <TextInput placeholder="call id" aria-label="call id" value={filter.callId} onChange={(e) => setFilter({ ...filter, callId: e.target.value.trim() })} />
        </div>
        <div className="rules-show">
          <Select aria-label="Show" value={filter.decision} options={SHOW} onValueChange={(v) => setFilter({ ...filter, decision: v as DecisionFilter })} />
        </div>
      </div>
      {error ? <LoadError message={error} retrying={loading} onRetry={() => load()} /> : null}
      {items === null ? (
        error ? null : <Loading what="decisions" />
      ) : items.length === 0 ? (
        <EmptyState title="No decisions recorded yet">Rules records every outward, destructive or money call, and every call a rule decided.</EmptyState>
      ) : (
        <div className="ruled">
          {items.map((d) => (
            <div className="item" key={d.id}>
              <Swatch className={d.answered === "deny" ? "is-needs-you" : undefined} />
              <h3>
                <DecisionTag decision={d.answered} /> {d.target.product}.{d.target.op} <Tag>{d.target.effect}</Tag>
              </h3>
              <p>
                {d.reason}
                {d.ruleTitle ? ` · rule “${d.ruleTitle}” rev ${d.ruleRev}` : ""}
                {d.onBehalfOf ? ` · on behalf of ${JSON.stringify(d.onBehalfOf)}` : ""}
                {d.callId ? ` · call ${d.callId}` : ""}
              </p>
              <span className="meta">
                {d.caller.type} {d.caller.id}
                {d.caller.mode ? ` (${d.caller.mode})` : ""} · {when(d.at)} · {d.phase} · {Math.round(d.durationUs / 100) / 10} ms
              </span>
            </div>
          ))}
        </div>
      )}
      {moreError ? (
        <Notice tone="needs-you" role="alert">
          {moreError}
        </Notice>
      ) : null}
      {cursor ? (
        <div className="tb-ctas">
          <Button onClick={() => load(cursor)} disabled={loading}>
            Load more
          </Button>
        </div>
      ) : null}
    </section>
  );
}
