// Teams page: Rules keeps a copy of the owner’s Organization Plane teams (fleet_status) so a rule can name a team.
import { Button, EmptyState, Notice, Swatch, Tag } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useState } from "react";
import { errorText, type Out, run, when } from "./api.ts";
import { Head, LoadError, Loading } from "./shared.tsx";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function TeamsPage() {
  const [st, setSt] = useState<Out<"fleet_status"> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback((refresh: boolean) => {
    setError(null);
    setLoading(true);
    run("fleet_status", { refresh })
      .then(setSt)
      .catch((e) => setError(errorText(e)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => load(false), [load]);
  return (
    <section className="app-page" aria-label="Teams">
      <Head title="Teams" />
      <p className="tb-soft rules-intro">Rules keeps a copy of your Organization Plane teams so a rule can name a team without asking during a call.</p>
      {error ? <LoadError message={error} retrying={loading} onRetry={() => load(false)} /> : null}
      {st ? (
        <>
          <div className="tb-row">
            <Tag status={st.source === "fleet" ? "live" : "default"}>{st.source === "fleet" ? "Organization Plane connected" : "No Organization Plane"}</Tag>
            <span className="tb-hint">
              last successful read {when(st.syncedAt)}
              {st.revision != null ? ` · revision ${st.revision}` : ""}
            </span>
            <Button size="sm" onClick={() => load(true)} disabled={loading}>
              Refresh now
            </Button>
          </div>
          {st.error ? (
            <Notice tone="needs-you" role="alert">
              {st.error}. When Organization Plane refuses, Rules clears its team copy at once (team rules match nobody). After a temporary failure it keeps the last teams for at most 10
              minutes. It retries every minute.
            </Notice>
          ) : null}
          {st.teams.length === 0 ? (
            <EmptyState title="No teams">Deploy Organization Plane and add teams there. Team rules match nobody until then.</EmptyState>
          ) : (
            <div className="ruled">
              {st.teams.map((t) => (
                <div className="item" key={t.id}>
                  <Swatch />
                  <h3>{t.name}</h3>
                  <span className="meta">
                    {plural(t.people, "person", "people")} · {plural(t.agents, "agent", "agents")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      ) : error ? null : (
        <Loading what="teams" />
      )}
    </section>
  );
}
