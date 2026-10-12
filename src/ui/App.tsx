// The Rules UI inside the ONE app shell, <AppShell> from @opt2-tealbrick/ui (SDK-API §14): rules, drafts from
// English, decision traces, Fleet teams, plus the standard holds and agents pages.
import { useAgents, useHolds, useSession } from "@opt2-tealbrick/miniapp-sdk/client";
import { AppShell, Button, Notice, STANDARD_PAGES, Tag } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useState } from "react";
import { run } from "./api.ts";
import { DecisionsPage, DraftsPage, RulesPage, TeamsPage } from "./pages.tsx";

const NAME = "Rules and Approvals";

/** Shell page id → path under the base `/a/rules/` (manifest `ui.launchPath` "/", `ui.configurePath` "/configure"). */
const PATHS: Record<string, string> = { rules: "./", drafts: "./drafts", decisions: "./decisions", teams: "./teams", holds: "./holds", agents: "./configure" };
const OWN_PAGES = [
  { id: "rules", label: "Rules" },
  { id: "drafts", label: "Drafts" },
  { id: "decisions", label: "Decisions" },
  { id: "teams", label: "Teams" },
];
const pageOf = (pathname: string): string => {
  const last = pathname.replace(/\/+$/, "").split("/").pop() ?? "";
  if (last === "configure") return "agents";
  return Object.keys(PATHS).includes(last) ? last : "rules";
};

function Holds() {
  const { holds, loading, decide } = useHolds({ status: "held" });
  if (loading) return <p>Loading holds.</p>;
  if (holds.length === 0) return <p>No calls to Rules wait for your approval.</p>;
  return (
    <ul>
      {holds.map((h) => (
        <li key={h.id}>
          <strong>{h.caller.name}</strong> {h.summary} <Tag tone="action">{h.op}</Tag>
          {h.view ? <pre>{h.view}</pre> : null}
          <Button variant="primary" onClick={() => void decide(h.id as Parameters<typeof decide>[0], "approve")}>
            Approve
          </Button>{" "}
          <Button onClick={() => void decide(h.id as Parameters<typeof decide>[0], "deny")}>Deny</Button>
        </li>
      ))}
    </ul>
  );
}

function Agents() {
  const { agents, loading } = useAgents();
  if (loading) return <p>Loading agents.</p>;
  if (agents.length === 0) return <p>No agents in this workspace yet.</p>;
  return (
    <ul>
      {agents.map((a) => (
        <li key={a.id}>
          {a.name} <Tag>{a.mode}</Tag> <span>{a.id}</span>
        </li>
      ))}
    </ul>
  );
}

export function App() {
  const { principal, status, signOut } = useSession();
  const [page, setPage] = useState(() => pageOf(globalThis.location.pathname));
  const [pending, setPending] = useState(0);
  const refreshPending = useCallback(() => {
    run("drafts_list", { status: "pending", limit: 100 })
      .then((d) => setPending(d.drafts.length))
      .catch(() => setPending(0));
  }, []);
  useEffect(() => {
    if (status === "signed_in") refreshPending();
  }, [status, refreshPending]);
  useEffect(() => {
    const onPop = () => setPage(pageOf(globalThis.location.pathname));
    globalThis.addEventListener("popstate", onPop);
    return () => globalThis.removeEventListener("popstate", onPop);
  }, []);
  const navigate = (id: string) => {
    globalThis.history.pushState(null, "", PATHS[id]);
    setPage(id);
  };
  const pages = [...OWN_PAGES.map((p) => (p.id === "drafts" ? { ...p, badge: pending || null } : p)), ...STANDARD_PAGES.filter((p) => p.id in PATHS)];
  const body = (() => {
    switch (page) {
      case "drafts":
        return <DraftsPage onChange={refreshPending} />;
      case "decisions":
        return <DecisionsPage />;
      case "teams":
        return <TeamsPage />;
      case "holds":
        return <Holds />;
      case "agents":
        return <Agents />;
      default:
        return <RulesPage />;
    }
  })();
  return (
    <AppShell
      title={NAME}
      pages={pages}
      current={page}
      onNavigate={navigate}
      actions={
        status === "signed_in" && principal ? (
          <Button onClick={() => void signOut()}>Sign out</Button>
        ) : (
          <Tag tone={status === "loading" ? "progress" : "action"}>{status === "loading" ? "Loading" : "Signed out"}</Tag>
        )
      }
      banner={
        status === "signed_out" ? (
          <Notice tone="action" role="alert">
            Open this app from Portal to sign in.
          </Notice>
        ) : null
      }
    >
      {status === "signed_in" ? body : null}
    </AppShell>
  );
}
