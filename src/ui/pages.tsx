// Owner pages: rules (list, editor with dry run), drafts from English, decision traces, Fleet teams.
// Everything goes through person ops; agents can only submit drafts (C84).
import { useAgents } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Dialog, Field, Notice, Select, Tag, TextInput } from "@opt2-tealbrick/ui";
import { type CSSProperties, useCallback, useEffect, useMemo, useState } from "react";
import {
  DECISION_TONE,
  type DecisionRow,
  type DraftRow,
  EFFECTS,
  emptySpec,
  errorText,
  joinList,
  list,
  matchText,
  type Out,
  type RuleRow,
  type RuleSpec,
  run,
  type Team,
  when,
} from "./api.ts";

const ul: CSSProperties = { listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.75rem" };
const card: CSSProperties = { border: "1px solid var(--tb-border)", borderRadius: "var(--tb-radius)", padding: "0.75rem", background: "var(--tb-surface)" };
const row: CSSProperties = { display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" };
const muted: CSSProperties = { color: "var(--tb-muted)", fontSize: "0.875rem", overflowWrap: "anywhere" };
const grid: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(14rem, 1fr))", gap: "0.75rem" };

function useNames(teams: Team[]) {
  const { agents } = useAgents();
  const agentName = useCallback((id: string) => agents.find((a) => a.id === id)?.name ?? id, [agents]);
  const teamName = useCallback((id: string) => teams.find((t) => t.id === id)?.name ?? id, [teams]);
  return { agents, agentName, teamName };
}

function useTeams(): Team[] {
  const [teams, setTeams] = useState<Team[]>([]);
  useEffect(() => {
    run("fleet_status", {})
      .then((s) => setTeams(s.teams))
      .catch(() => setTeams([]));
  }, []);
  return teams;
}

function Checks<T extends string>({ label, options, value, onChange }: { label: string; options: { value: T; label: string }[]; value: T[] | undefined; onChange: (v: T[] | undefined) => void }) {
  const set = new Set(value ?? []);
  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
      <legend style={muted}>{label} (none = any)</legend>
      <div style={row}>
        {options.map((o) => (
          <label key={o.value} style={row}>
            <input
              type="checkbox"
              checked={set.has(o.value)}
              onChange={(e) => {
                const next = new Set(set);
                if (e.target.checked) next.add(o.value);
                else next.delete(o.value);
                onChange(next.size ? [...next] : undefined);
              }}
            />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Rule editor (structured form). Saving passes the revision that was edited (stale → revision_conflict). */
function Editor({ initial, teams, onDone }: { initial: RuleRow | null; teams: Team[]; onDone: () => void }) {
  const { agents } = useNames(teams);
  const [s, setS] = useState<RuleSpec>(() => structuredClone(initial?.spec ?? emptySpec()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const m = s.match;
  const setMatch = (patch: Partial<RuleSpec["match"]>) => setS({ ...s, match: { ...m, ...patch } });
  const obo = m.onBehalfOf ?? {};
  const setObo = (patch: Partial<NonNullable<RuleSpec["match"]["onBehalfOf"]>>) => {
    const next = { ...obo, ...patch };
    setMatch({ onBehalfOf: next.teams || next.ids || next.kinds ? next : undefined });
  };
  const tags = s.narrowing?.memoryTags ?? {};
  const setTags = (patch: { anyOf?: string[]; noneOf?: string[] }) => {
    const next = { ...tags, ...patch };
    setS({ ...s, narrowing: next.anyOf || next.noneOf ? { memoryTags: next } : undefined });
  };
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await run("rules_set", { ...(initial ? { id: initial.id, expectedRev: initial.rev } : {}), rule: s });
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title={initial ? `Edit rule (revision ${initial.rev})` : "New rule"}
      onClose={onDone}
      busy={busy}
      size="lg"
      footer={
        <div style={row}>
          <Button variant="primary" disabled={busy || !s.title || !s.outcome.reason} onClick={() => void save()}>
            Save rule
          </Button>
          <Button onClick={onDone}>Cancel</Button>
        </div>
      }
    >
      {error ? (
        <Notice tone="action" role="alert">
          {error}
        </Notice>
      ) : null}
      <div style={grid}>
        <Field label="Title">
          <TextInput value={s.title} maxLength={120} onChange={(e) => setS({ ...s, title: e.target.value })} />
        </Field>
        <Field label="Priority" hint="Lower runs first. The first matching rule decides.">
          <TextInput type="number" min={0} max={1000} value={s.priority} onChange={(e) => setS({ ...s, priority: Number(e.target.value) })} />
        </Field>
        <Field label="Decision">
          <Select
            value={s.outcome.decision}
            options={[
              { value: "allow", label: "Allow" },
              { value: "deny", label: "Refuse" },
              { value: "hold", label: "Hold for my review" },
            ]}
            onChange={(e) => setS({ ...s, outcome: { ...s.outcome, decision: e.target.value as RuleSpec["outcome"]["decision"] }, narrowing: e.target.value === "allow" ? s.narrowing : undefined })}
          />
        </Field>
        <label style={row}>
          <input type="checkbox" checked={s.active} onChange={(e) => setS({ ...s, active: e.target.checked })} /> Active
        </label>
      </div>
      <Field label="Reason" hint="Shown to the agent and recorded with every decision (max 280 characters).">
        <TextInput value={s.outcome.reason} maxLength={280} onChange={(e) => setS({ ...s, outcome: { ...s.outcome, reason: e.target.value } })} />
      </Field>
      <h4>When</h4>
      <Checks
        label="Caller agents"
        options={agents.map((a) => ({ value: a.id, label: a.name }))}
        value={m.agents}
        onChange={(v) => setMatch({ agents: v })}
      />
      <Checks
        label="Agent mode"
        options={[
          { value: "free" as const, label: "Free" },
          { value: "bound" as const, label: "Bound" },
        ]}
        value={m.modes}
        onChange={(v) => setMatch({ modes: v })}
      />
      <Checks label="Effect" options={EFFECTS.map((e) => ({ value: e, label: e }))} value={m.effects} onChange={(v) => setMatch({ effects: v })} />
      <div style={grid}>
        <Field label="Apps (product ids, comma separated)">
          <TextInput value={joinList(m.products)} onChange={(e) => setMatch({ products: list(e.target.value) })} />
        </Field>
        <Field label="Operations (ids, comma separated)" hint="Needs the app above.">
          <TextInput value={joinList(m.operations)} onChange={(e) => setMatch({ operations: list(e.target.value) })} />
        </Field>
      </div>
      <Checks label="On behalf of a member of team (from Fleet)" options={teams.map((t) => ({ value: t.id, label: t.name }))} value={obo.teams} onChange={(v) => setObo({ teams: v })} />
      <Field label="On behalf of (ids or handles such as slack:U123, comma separated)" hint="A claimed requester can only make a decision stricter, never wider.">
        <TextInput value={joinList(obo.ids)} onChange={(e) => setObo({ ids: list(e.target.value) })} />
      </Field>
      {s.outcome.decision === "allow" ? (
        <>
          <h4>Narrow what the agent may read</h4>
          <div style={grid}>
            <Field label="Only memories tagged (any of)">
              <TextInput value={joinList(tags.anyOf)} onChange={(e) => setTags({ anyOf: list(e.target.value) })} />
            </Field>
            <Field label="Never memories tagged">
              <TextInput value={joinList(tags.noneOf)} onChange={(e) => setTags({ noneOf: list(e.target.value) })} />
            </Field>
          </div>
        </>
      ) : null}
      <Preview candidate={s} />
    </Dialog>
  );
}

/** Dry run: which rule would decide a sample call (with the edited rule included). */
function Preview({ candidate }: { candidate?: RuleSpec }) {
  const { agents } = useAgents();
  const [caller, setCaller] = useState("");
  const [mode, setMode] = useState<"free" | "bound">("free");
  const [product, setProduct] = useState("knowledge");
  const [op, setOp] = useState("memory_recall");
  const [effect, setEffect] = useState<(typeof EFFECTS)[number]>("read");
  const [handle, setHandle] = useState("");
  const [result, setResult] = useState<Out<"rules_preview"> | null>(null);
  const [error, setError] = useState("");
  const go = async () => {
    setError("");
    try {
      const id = caller || agents[0]?.id || "agt_preview";
      setResult(
        await run("rules_preview", {
          call: { caller: { type: "agent", id, mode }, target: { product, op, effect }, ...(handle ? { onBehalfOf: { kind: handle.includes(":") || handle.startsWith("npub1") ? "channel_sender" : "person", id: handle } } : {}) },
          ...(candidate?.title && candidate.outcome.reason ? { candidate } : {}),
        }),
      );
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <section style={{ ...card, marginTop: "1rem" }}>
      <h4 style={{ marginTop: 0 }}>Try a call (dry run)</h4>
      <div style={grid}>
        <Field label="Caller">
          <Select value={caller} options={[{ value: "", label: "first agent" }, ...agents.map((a) => ({ value: a.id, label: a.name }))]} onChange={(e) => setCaller(e.target.value)} />
        </Field>
        <Field label="Mode">
          <Select
            value={mode}
            options={[
              { value: "free", label: "Free" },
              { value: "bound", label: "Bound" },
            ]}
            onChange={(e) => setMode(e.target.value as "free" | "bound")}
          />
        </Field>
        <Field label="App">
          <TextInput value={product} onChange={(e) => setProduct(e.target.value)} />
        </Field>
        <Field label="Operation">
          <TextInput value={op} onChange={(e) => setOp(e.target.value)} />
        </Field>
        <Field label="Effect">
          <Select value={effect} options={EFFECTS.map((e) => ({ value: e, label: e }))} onChange={(e) => setEffect(e.target.value as (typeof EFFECTS)[number])} />
        </Field>
        <Field label="On behalf of (optional)">
          <TextInput value={handle} placeholder="slack:U123 or psn_…" onChange={(e) => setHandle(e.target.value)} />
        </Field>
      </div>
      <Button onClick={() => void go()}>Run dry run</Button>
      {error ? <p style={muted}>{error}</p> : null}
      {result ? (
        <div style={{ marginTop: "0.5rem" }}>
          <div style={row}>
            <Tag tone={DECISION_TONE[result.answered]}>{result.answered}</Tag>
            <span>{result.reason}</span>
            {result.ruleTitle ? <span style={muted}>by “{result.ruleTitle}”</span> : null}
          </div>
          {result.narrowing ? <p style={muted}>Narrowed to memories: {JSON.stringify(result.narrowing.memoryTags)}</p> : null}
          {result.decision === "hold" && result.answered === "deny" ? <p style={muted}>Holds from rules arrive with the next platform release; until then a hold rule refuses.</p> : null}
          <ol style={muted}>
            {result.steps.map((st) => (
              <li key={st.ruleId}>
                {st.title}: {st.why}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}

export function RulesPage() {
  const teams = useTeams();
  const { agentName, teamName } = useNames(teams);
  const [data, setData] = useState<Out<"rules_list"> | null>(null);
  const [editing, setEditing] = useState<RuleRow | "new" | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    run("rules_list", {})
      .then(setData)
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);
  const remove = async (r: RuleRow) => {
    if (!globalThis.confirm(`Delete the rule “${r.spec.title}”? Its history stays.`)) return;
    try {
      await run("rules_delete", { id: r.id, expectedRev: r.rev });
      load();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <section>
      <div style={{ ...row, justifyContent: "space-between", marginBottom: "1rem" }}>
        <p style={muted}>The first matching rule decides (lower priority first). No matching rule: allow. Every refusal and hold is recorded with its reason.</p>
        <Button variant="primary" onClick={() => setEditing("new")}>
          New rule
        </Button>
      </div>
      {data && !data.holdSupported ? (
        <Notice tone="ok">“Hold for my review” rules refuse for now: holds from rules arrive with the next platform release (spec 0.1.13).</Notice>
      ) : null}
      {error ? (
        <Notice tone="action" role="alert">
          {error}
        </Notice>
      ) : null}
      {data?.rules.some((r) => r.problem) ? (
        <Notice tone="action" role="alert">
          {data.rules.filter((r) => r.problem).length} rule(s) never match: they name an app or operation that the app does not declare. Edit or delete them; until then they protect nothing.
        </Notice>
      ) : null}
      {data?.catalog.error ? (
        <p style={muted}>
          App catalog: last read failed ({data.catalog.error}); rules are checked against the catalog of {when(data.catalog.syncedAt)}.
        </p>
      ) : null}
      {!data ? <p>Loading rules.</p> : data.rules.length === 0 ? <p>No rules yet. Every call is allowed (within each app's own limits).</p> : null}
      <ul style={ul}>
        {data?.rules.map((r) => (
          <li key={r.id} style={card}>
            <div style={row}>
              <strong>{r.spec.title}</strong>
              <Tag tone={DECISION_TONE[r.spec.outcome.decision]}>{r.spec.outcome.decision}</Tag>
              <Tag>priority {r.spec.priority}</Tag>
              {r.spec.active ? null : <Tag tone="neutral">inactive</Tag>}
              {r.source.startsWith("drf_") ? <Tag tone="progress">from draft</Tag> : null}
              {r.problem ? <Tag tone="blocked">never matches</Tag> : null}
            </div>
            {r.problem ? <p style={muted}>Never matches: {r.problem}</p> : null}
            <p style={muted}>
              {matchText(r.spec, teamName, agentName)} → {r.spec.outcome.reason}
              {r.spec.narrowing?.memoryTags ? ` · memories: ${JSON.stringify(r.spec.narrowing.memoryTags)}` : ""}
            </p>
            <div style={row}>
              <Button size="sm" onClick={() => setEditing(r)}>
                Edit
              </Button>
              <Button size="sm" variant="danger" onClick={() => void remove(r)}>
                Delete
              </Button>
              <span style={muted}>
                revision {r.rev} · {when(r.updatedAt)}
              </span>
            </div>
          </li>
        ))}
      </ul>
      {editing ? (
        <Editor
          initial={editing === "new" ? null : editing}
          teams={teams}
          onDone={() => {
            setEditing(null);
            load();
          }}
        />
      ) : null}
    </section>
  );
}

export function DraftsPage({ onChange }: { onChange: () => void }) {
  const teams = useTeams();
  const { agentName, teamName } = useNames(teams);
  const [drafts, setDrafts] = useState<DraftRow[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    run("drafts_list", {})
      .then((d) => setDrafts(d.drafts))
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);
  const decide = async (d: DraftRow, decision: "approve" | "reject") => {
    try {
      await run("draft_decide", { id: d.id, decision });
      load();
      onChange();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <section>
      <p style={muted}>Ask your agent to write a rule in plain English. It sends its structured version here; nothing applies until you approve it.</p>
      {error ? (
        <Notice tone="action" role="alert">
          {error}
        </Notice>
      ) : null}
      {!drafts ? <p>Loading drafts.</p> : drafts.length === 0 ? <p>No drafts.</p> : null}
      <ul style={ul}>
        {drafts?.map((d) => (
          <li key={d.id} style={card}>
            <div style={row}>
              <Tag tone={d.status === "pending" ? "action" : d.status === "approved" ? "ok" : "neutral"}>{d.status}</Tag>
              <span style={muted}>
                from {d.submittedBy.name} · {when(d.submittedAt)}
              </span>
            </div>
            <blockquote style={{ margin: "0.5rem 0", overflowWrap: "anywhere" }}>“{d.text}”</blockquote>
            {d.note ? <p style={muted}>Agent note: {d.note}</p> : null}
            <ol>
              {d.rules.map((r, i) => (
                <li key={JSON.stringify(r)}>
                  <strong>{r.title}</strong> <Tag tone={DECISION_TONE[r.outcome.decision]}>{r.outcome.decision}</Tag> <Tag>priority {r.priority}</Tag>
                  {d.problems?.[i] ? <Tag tone="blocked">never matches</Tag> : null}
                  <div style={muted}>
                    {matchText(r, teamName, agentName, d.opTitles ?? {})} → {r.outcome.reason}
                    {r.narrowing?.memoryTags ? ` · memories: ${JSON.stringify(r.narrowing.memoryTags)}` : ""}
                  </div>
                  {d.problems?.[i] ? <div style={muted}>Never matches: {d.problems[i]}</div> : null}
                </li>
              ))}
            </ol>
            {d.status === "pending" && d.problems?.some(Boolean) ? (
              <Notice tone="action">This draft cannot be applied: a rule in it would never match, so it would protect nothing. Reject it and ask the agent for a corrected draft.</Notice>
            ) : null}
            {d.status === "pending" ? (
              <div style={row}>
                <Button variant="primary" disabled={d.problems?.some(Boolean)} onClick={() => void decide(d, "approve")}>
                  Approve and apply
                </Button>
                <Button onClick={() => void decide(d, "reject")}>Reject</Button>
              </div>
            ) : (
              <p style={muted}>
                {d.status} {when(d.decidedAt)}
                {d.ruleIds.length ? ` · rules ${d.ruleIds.join(", ")}` : ""}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function DecisionsPage() {
  const [items, setItems] = useState<DecisionRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<{ callId: string; decision: "" | "allow" | "deny" | "hold" }>({ callId: "", decision: "" });
  const [error, setError] = useState("");
  const query = useMemo(() => ({ ...(filter.callId ? { callId: filter.callId } : {}), ...(filter.decision ? { decision: filter.decision } : {}), limit: 50 }), [filter]);
  const load = useCallback(
    (more?: string | null) => {
      run("decisions_list", { ...query, ...(more ? { cursor: more } : {}) })
        .then((r) => {
          setItems((prev) => (more ? [...prev, ...r.items] : r.items));
          setCursor(r.nextCursor);
        })
        .catch((e) => setError(errorText(e)));
    },
    [query],
  );
  useEffect(() => load(), [load]);
  return (
    <section>
      <div style={{ ...row, marginBottom: "1rem" }}>
        <TextInput placeholder="call id" value={filter.callId} onChange={(e) => setFilter({ ...filter, callId: e.target.value.trim() })} />
        <Select
          value={filter.decision}
          options={[
            { value: "", label: "all decisions" },
            { value: "deny", label: "refused" },
            { value: "hold", label: "held" },
            { value: "allow", label: "allowed" },
          ]}
          onChange={(e) => setFilter({ ...filter, decision: e.target.value as typeof filter.decision })}
        />
      </div>
      {error ? (
        <Notice tone="action" role="alert">
          {error}
        </Notice>
      ) : null}
      {items.length === 0 ? <p>No decisions recorded yet. Rules records every outward, destructive or money call, and every call a rule decided.</p> : null}
      <ul style={ul}>
        {items.map((d) => (
          <li key={d.id} style={card}>
            <div style={row}>
              <Tag tone={DECISION_TONE[d.answered]}>{d.answered}</Tag>
              <strong>
                {d.target.product}.{d.target.op}
              </strong>
              <Tag>{d.target.effect}</Tag>
              <span style={muted}>
                {d.caller.type} {d.caller.id}
                {d.caller.mode ? ` (${d.caller.mode})` : ""} · {when(d.at)} · {d.phase} · {Math.round(d.durationUs / 100) / 10} ms
              </span>
            </div>
            <p style={muted}>
              {d.reason}
              {d.ruleTitle ? ` · rule “${d.ruleTitle}” rev ${d.ruleRev}` : ""}
              {d.onBehalfOf ? ` · on behalf of ${JSON.stringify(d.onBehalfOf)}` : ""}
              {d.callId ? ` · call ${d.callId}` : ""}
            </p>
          </li>
        ))}
      </ul>
      {cursor ? <Button onClick={() => load(cursor)}>Load more</Button> : null}
    </section>
  );
}

export function TeamsPage() {
  const [st, setSt] = useState<Out<"fleet_status"> | null>(null);
  const [error, setError] = useState("");
  const load = useCallback((refresh: boolean) => {
    setError("");
    run("fleet_status", { refresh })
      .then(setSt)
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => load(false), [load]);
  return (
    <section>
      <p style={muted}>Rules keeps a copy of your Fleet teams so a rule can name a team without asking Fleet during a call.</p>
      {error ? (
        <Notice tone="action" role="alert">
          {error}
        </Notice>
      ) : null}
      {st ? (
        <>
          <div style={row}>
            <Tag tone={st.source === "fleet" ? "ok" : "neutral"}>{st.source === "fleet" ? "Fleet connected" : "No Fleet"}</Tag>
            <span style={muted}>
              last successful read {when(st.syncedAt)}
              {st.revision != null ? ` · revision ${st.revision}` : ""}
            </span>
            <Button size="sm" onClick={() => load(true)}>
              Refresh now
            </Button>
          </div>
          {st.error ? (
            <Notice tone="action" role="alert">
              {st.error}. When Fleet refuses, Rules clears its team copy at once (team rules match nobody). After a temporary failure it keeps the last teams for at most 10 minutes. It retries every minute.
            </Notice>
          ) : null}
          {st.teams.length === 0 ? <p>No teams. Deploy Fleet and add teams there; team rules match nobody until then.</p> : null}
          <ul style={ul}>
            {st.teams.map((t) => (
              <li key={t.id} style={card}>
                <strong>{t.name}</strong> <span style={muted}>{t.id}</span>
                <div style={muted}>
                  {t.people} people · {t.agents} agents
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p>Loading teams.</p>
      )}
    </section>
  );
}
