import { Link, Route, Switch } from "wouter";
import { ExplorationPage } from "./pages/ExplorationPage.tsx";
import { CliBanner } from "./components/CliBanner.tsx";
import { EngineBanner } from "./components/EngineBanner.tsx";
import { useServerEvents } from "./events.ts";
import { ChangePage } from "./pages/ChangePage.tsx";
import { NewChangePage } from "./pages/NewChangePage.tsx";
import { NewWorkspacePage } from "./pages/NewWorkspacePage.tsx";
import { OnboardingPage } from "./pages/OnboardingPage.tsx";
import { ProvidersPage } from "./pages/ProvidersPage.tsx";
import { SpecPage } from "./pages/SpecPage.tsx";
import { WorkspacePage } from "./pages/WorkspacePage.tsx";
import { WorkspacesPage } from "./pages/WorkspacesPage.tsx";
import { useEngine, useEngineRetry, useSystem } from "./queries.ts";

export function App() {
  useServerEvents();
  const system = useSystem();
  const engine = useEngine();
  const retry = useEngineRetry();
  return (
    <div className="app">
      <nav className="topbar">
        <a href="/" className="brand">
          OpenSpec Studio
        </a>
        <Link href="/providers">Provedores</Link>
      </nav>
      <CliBanner system={system.data} />
      <EngineBanner status={engine.data} onRetry={() => retry.mutate()} />
      <Switch>
        <Route path="/" component={WorkspacesPage} />
        <Route path="/new" component={NewWorkspacePage} />
        <Route path="/providers" component={ProvidersPage} />
        <Route path="/w/:id">{(p) => <WorkspacePage id={p.id} />}</Route>
        <Route path="/w/:id/onboarding">{(p) => <OnboardingPage id={p.id} />}</Route>
        <Route path="/w/:id/specs/:spec">{(p) => <SpecPage id={p.id} spec={p.spec} />}</Route>
        <Route path="/w/:id/changes/new">{(p) => <NewChangePage id={p.id} />}</Route>
        <Route path="/w/:id/changes/:change">{(p) => <ChangePage id={p.id} change={p.change} />}</Route>
        <Route path="/w/:id/explorations/:x">{(p) => <ExplorationPage id={p.id} x={p.x} />}</Route>
        <Route>
          <main>
            <p>Página não encontrada.</p>
          </main>
        </Route>
      </Switch>
    </div>
  );
}
