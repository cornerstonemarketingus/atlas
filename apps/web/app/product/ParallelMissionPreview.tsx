const lanes = [
  {
    agent: "Research child",
    role: "Maps the codebase and constraints",
    status: "Complete",
    tone: "done",
    dependency: "Mission brief",
    progress: "Architecture map and 6 acceptance checks delivered",
  },
  {
    agent: "Builder child",
    role: "Implements in an isolated worktree",
    status: "Running",
    tone: "running",
    dependency: "Research child",
    progress: "Checkout flow · 4 of 7 tasks verified",
  },
  {
    agent: "Operator child",
    role: "Prepares deployment and browser work",
    status: "Ready",
    tone: "ready",
    dependency: "Builder child",
    progress: "Waiting for a verified release candidate",
  },
  {
    agent: "Reviewer child",
    role: "Challenges the integrated result",
    status: "Blocked",
    tone: "blocked",
    dependency: "Builder + operator",
    progress: "Security and regression review queued",
  },
];

const budgets = [
  { label: "Compute", value: "$0.86 / $3.00", fill: "29%" },
  { label: "Context", value: "19k / 90k", fill: "21%" },
  { label: "Elapsed", value: "8m / 30m", fill: "27%" },
];

export function ParallelMissionPreview() {
  return (
    <section className="parallel-preview" aria-labelledby="parallel-preview-title">
      <div className="parallel-intro">
        <p className="eyebrow"><span>PRODUCT PREVIEW</span> Parallel mission control</p>
        <h2 id="parallel-preview-title">Child agents work in parallel.<br />You keep the whole picture.</h2>
        <p>
          Atlas is building a dependency-aware mission view for coordinating specialized
          children without turning autonomy into a black box. This interface is a product
          preview; live orchestration is being connected to the durable mission runtime.
        </p>
        <div className="parallel-principle">
          <span aria-hidden="true">◎</span>
          <p><b>Progress, not private reasoning.</b> Atlas surfaces decisions, actions, blockers, budgets, and evidence—not hidden chain-of-thought.</p>
        </div>
      </div>

      <div className="mission-console" aria-label="Parallel mission preview">
        <header className="mission-console-header">
          <div>
            <small>MISSION 024</small>
            <h3>Launch a production-ready checkout</h3>
          </div>
          <span className="mission-state"><i /> 2 active · 4 children</span>
        </header>

        <div className="mission-summary">
          <div><small>DEPENDENCY GRAPH</small><strong>5 / 9</strong><span>steps complete</span></div>
          <div><small>POLICY</small><strong>Guarded</strong><span>2 approvals reserved</span></div>
          <div><small>INTEGRATION</small><strong>Pending</strong><span>after builder lane</span></div>
        </div>

        <div className="agent-lanes">
          {lanes.map((lane, index) => (
            <article className={`agent-lane ${lane.tone}`} key={lane.agent}>
              <div className="lane-sequence" aria-hidden="true">{String(index + 1).padStart(2, "0")}</div>
              <div className="lane-body">
                <div className="lane-title">
                  <div><h4>{lane.agent}</h4><p>{lane.role}</p></div>
                  <span>{lane.status}</span>
                </div>
                <p className="lane-progress">{lane.progress}</p>
                <small>DEPENDS ON · {lane.dependency}</small>
              </div>
            </article>
          ))}
        </div>

        <div className="mission-bottom">
          <section className="mission-budgets" aria-label="Mission budgets">
            <div className="panel-label"><span>Budget envelope</span><small>hard limits</small></div>
            {budgets.map((budget) => (
              <div className="budget-row" key={budget.label}>
                <div><span>{budget.label}</span><b>{budget.value}</b></div>
                <div className="budget-track"><i style={{ width: budget.fill }} /></div>
              </div>
            ))}
          </section>
          <section className="mission-evidence" aria-label="Mission evidence">
            <div className="panel-label"><span>Evidence stream</span><small>3 receipts</small></div>
            <ul>
              <li><i>✓</i><div><b>Baseline captured</b><small>128 tests · clean build</small></div></li>
              <li><i>✓</i><div><b>Architecture mapped</b><small>6 constraints linked</small></div></li>
              <li><i>↗</i><div><b>Candidate evaluating</b><small>isolated worktree · live</small></div></li>
            </ul>
          </section>
        </div>
      </div>
    </section>
  );
}
