import { useEffect, useState } from "react";
import { RunsListPage } from "./pages/RunsListPage";
import { RunDetailPage } from "./pages/RunDetailPage";
import { ConfigPage } from "./pages/ConfigPage";

type Route =
  | { name: "runs" }
  | { name: "run"; id: string }
  | { name: "config" };

function parseHash(): Route {
  const h = window.location.hash.replace(/^#\/?/, "");
  if (h.startsWith("runs/")) return { name: "run", id: h.slice(5) };
  if (h === "config") return { name: "config" };
  return { name: "runs" };
}

export default function App() {
  const [route, setRoute] = useState<Route>(parseHash());
  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Trade Agent</span>
        <nav>
          <a href="#/" className={route.name === "runs" || route.name === "run" ? "active" : ""}>
            Runs
          </a>
          <a href="#/config" className={route.name === "config" ? "active" : ""}>
            Config
          </a>
        </nav>
      </header>
      <main className="content">
        {route.name === "runs" && <RunsListPage />}
        {route.name === "run" && <RunDetailPage runId={route.id} />}
        {route.name === "config" && <ConfigPage />}
      </main>
    </div>
  );
}
