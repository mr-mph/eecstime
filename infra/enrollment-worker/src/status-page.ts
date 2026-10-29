/** Dashboard page served by status.ts. Polls /api/status every 5 seconds. */
export const DASHBOARD_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Enrollment Worker</title>
<style>
  :root {
    --bg: #f6f7f9; --card: #ffffff; --text: #16181d; --muted: #667085;
    --line: #e4e7ec; --accent: #2563eb; --ok: #15803d; --bad: #b42318;
    --warn: #b54708; --bar: #e4e7ec;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1115; --card: #171a21; --text: #e6e8ec; --muted: #98a2b3;
      --line: #2a2f3a; --accent: #6ea8fe; --ok: #4ade80; --bad: #f97066;
      --warn: #fdb022; --bar: #2a2f3a;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 1100px; margin: 0 auto; padding: 20px 16px 40px; }
  h1 { font-size: 20px; margin: 0; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em;
    color: var(--muted); margin: 0 0 10px; font-weight: 600; }
  header { display: flex; align-items: center; justify-content: space-between;
    gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
  .pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px;
    border-radius: 999px; font-size: 12px; font-weight: 600; border: 1px solid var(--line); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  .running .dot { background: var(--ok); animation: pulse 1.4s infinite; }
  .paused .dot { background: var(--warn); }
  @keyframes pulse { 50% { opacity: .3; } }
  .muted { color: var(--muted); }
  .grid { display: grid; gap: 12px; }
  .stats { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); margin-bottom: 12px; }
  .two { grid-template-columns: 1fr 1fr; }
  @media (max-width: 760px) { .two { grid-template-columns: 1fr; } }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px;
    padding: 14px; min-width: 0; }
  .stat .v { font-size: 22px; font-weight: 650; font-variant-numeric: tabular-nums; }
  .stat .l { color: var(--muted); font-size: 12px; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 6px 6px; border-bottom: 1px solid var(--line);
    white-space: nowrap; }
  th { color: var(--muted); font-weight: 600; font-size: 12px; }
  td.wrap { white-space: normal; min-width: 150px; }
  tr:last-child td { border-bottom: 0; }
  .scroll { overflow-x: auto; }
  .ok { color: var(--ok); } .bad { color: var(--bad); } .warn { color: var(--warn); }
  .bar { height: 8px; background: var(--bar); border-radius: 4px; overflow: hidden; }
  .bar > span { display: block; height: 100%; background: var(--accent); }
  .progress { position: relative; height: 6px; background: var(--bar); border-radius: 3px;
    overflow: hidden; margin-top: 6px; }
  .progress > span { position: absolute; inset: 0 auto 0 0; background: var(--accent); }
  .empty { color: var(--muted); padding: 8px 0; }
  a.cls { color: inherit; text-decoration: none; border-bottom: 1px dotted var(--muted); }
  a.cls:hover { color: var(--accent); border-bottom-color: var(--accent); }
  .section { margin-top: 12px; }
</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>Enrollment Worker</h1>
      <div class="muted" id="sub">Loading…</div>
    </div>
    <span class="pill" id="state"><span class="dot"></span><span id="stateText">—</span></span>
  </header>

  <div class="grid stats" id="stats"></div>

  <div class="grid two">
    <div class="card">
      <h2>Fetching now</h2>
      <div class="scroll"><table id="inflight"></table></div>
    </div>
    <div class="card">
      <h2>Updated recently</h2>
      <div id="fresh"></div>
    </div>
  </div>

  <div class="card section">
    <h2>Latest fetches</h2>
    <div class="scroll"><table id="recent"></table></div>
  </div>

  <div class="card section">
    <h2>Recent errors <span id="errSummary" style="text-transform:none;letter-spacing:0;font-weight:400"></span></h2>
    <div class="scroll"><table id="errors"></table></div>
  </div>

  <div class="grid two section">
    <div class="card">
      <h2>By popularity tier</h2>
      <div class="scroll"><table id="tiers"></table></div>
    </div>
    <div class="card">
      <h2>Recent runs</h2>
      <div class="scroll"><table id="runs"></table></div>
    </div>
  </div>
</main>
<script>
let data = null, fetchedAt = 0, offset = 0;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmtNum = (n) => (n ?? 0).toLocaleString();
const dur = (ms) => {
  if (ms == null) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + (s % 60) + "s";
  const h = Math.floor(m / 60);
  if (h < 48) return h + "h " + (m % 60) + "m";
  return Math.floor(h / 24) + "d " + (h % 24) + "h";
};
const ago = (t) => (t ? dur(now() - t) + " ago" : "—");
const now = () => Date.now() + offset;
// Class name linking to its classes.berkeley.edu page (opens in a new tab).
const classLink = (label, url) =>
  String(url ?? "").startsWith("https://classes.berkeley.edu/")
    ? '<a class="cls" href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(label) + "</a>"
    : esc(label);
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });

function render() {
  if (!data) return;
  const { live, summary } = data;
  const run = live?.run;
  const t = now();
  const liveFresh = live && t - live.updatedAt < 30_000;
  let state = "idle", text = "Idle";
  if (run?.state === "paused" || (summary.pausedUntil && summary.pausedUntil > t)) {
    state = "paused"; text = "Paused (throttled) until " + clock(run?.pausedUntil ?? summary.pausedUntil);
  } else if (run?.state === "running" && liveFresh) {
    state = "running"; text = "Running";
  } else if (run) {
    text = "Idle · next run ~" + dur(Math.max(0, run.startedAt + 300_000 - t));
  }
  $("state").className = "pill " + state;
  $("stateText").textContent = text;
  $("sub").textContent = "Updated " + ago(fetchedAt) + (live ? " · last status write " + ago(live.updatedAt) : "");

  const pct = summary.totalClasses ? Math.round(100 * (summary.totalClasses - summary.neverFetched) / summary.totalClasses) : 0;
  const elapsed = run ? Math.min((run.finishedAt ?? t) - run.startedAt, run.budgetEndsAt - run.startedAt) : 0;
  const stats = [
    ["Classes tracked", fmtNum(summary.totalClasses)],
    ["Fetched at least once", fmtNum(summary.totalClasses - summary.neverFetched) + " (" + pct + "%)"],
    ["Never fetched yet", fmtNum(summary.neverFetched)],
    ["This run", run ? fmtNum(run.fetched) + " ok · " + fmtNum(run.failed) + " failed" : "—"],
    ["Requests this run", run ? fmtNum(run.requests) + " (" + (elapsed ? (run.requests / (elapsed / 1000)).toFixed(2) : "0") + "/s)" : "—"],
    ["Cross-listings riding along", fmtNum(summary.followers)],
    ["Concurrency (adaptive)", run ? run.concurrency + " in flight · ≤" + run.maxRequestsPerSecond + "/s" : "—"],
  ];
  $("stats").innerHTML = stats.map(([l, v]) => '<div class="card stat"><div class="v">' + esc(v) + '</div><div class="l">' + esc(l) + "</div></div>").join("");

  const inflight = liveFresh && run?.state === "running" ? live.inFlight : [];
  $("inflight").innerHTML = inflight.length
    ? "<tr><th>Class</th><th>Waiting</th><th>Timeout</th></tr>" + inflight
        .sort((a, b) => a.startedAt - b.startedAt)
        .map((f) => {
          const w = t - f.startedAt;
          return "<tr><td>" + classLink(f.label, f.url) + '</td><td class="' + (w > f.timeoutMs * 0.75 ? "warn" : "") + '">' + dur(w) +
            '</td><td class="muted">' + dur(f.timeoutMs) + "</td></tr>";
        }).join("")
    : '<tr><td class="empty">' + (state === "running" ? "Between classes…" : "Nothing in flight; the worker runs every 5 minutes.") + "</td></tr>";

  const total = summary.totalClasses || 1;
  $("fresh").innerHTML = summary.updatedWithin.map((w) =>
    '<div style="margin-bottom:10px"><div style="display:flex;justify-content:space-between"><span>Within ' + esc(w.label) +
    "</span><span>" + fmtNum(w.count) + ' <span class="muted">/ ' + fmtNum(summary.totalClasses) + '</span></span></div><div class="bar"><span style="width:' +
    (100 * w.count / total).toFixed(2) + '%"></span></div></div>').join("") +
    (summary.retryPending ? '<div class="warn">' + fmtNum(summary.retryPending) + " class(es) queued to retry first next run (couldn't reach the page)</div>" : "") +
    (run && run.state === "running" ? '<div class="muted" style="margin-top:6px">Run progress</div><div class="progress"><span style="width:' +
      Math.min(100, 100 * elapsed / (run.budgetEndsAt - run.startedAt)).toFixed(1) + '%"></span></div>' : "");

  const recent = live?.recent ?? [];
  $("recent").innerHTML = recent.length
    ? "<tr><th>Class</th><th>Result</th><th>Enrolled</th><th>Waitlist</th><th>Took</th><th>Finished</th></tr>" + recent.slice(0, 30).map((r) =>
        "<tr><td>" + classLink(r.label, r.url) + (r.followers ? ' <span class="muted">+' + r.followers + " cross-listing" + (r.followers > 1 ? "s" : "") + "</span>" : "") +
        "</td><td class=\\"" + (r.ok ? (r.changed ? "ok" : "") : "bad") + ' wrap">' +
        (r.ok ? (r.changed ? "changed" : "no change") : esc(r.error ?? "failed")) + "</td><td>" +
        (r.ok ? fmtNum(r.enrolled) + " / " + fmtNum(r.max) : "—") + "</td><td>" + (r.ok ? fmtNum(r.waitlisted) : "—") +
        "</td><td>" + dur(r.ms) + '</td><td class="muted">' + ago(r.at) + "</td></tr>").join("")
    : '<tr><td class="empty">No fetches recorded yet.</td></tr>';

  const errs = live?.errors ?? [];
  const lastHour = errs.filter((e) => t - e.at <= 3600_000).length;
  $("errSummary").textContent = errs.length ? "· " + lastHour + " in the last hour" : "";
  $("errors").innerHTML = errs.length
    ? "<tr><th>Class</th><th>Error</th><th>Took</th><th>When</th></tr>" + errs.slice(0, 50).map((e) =>
        "<tr><td>" + classLink(e.label, e.url) + '</td><td class="bad wrap">' + esc(e.error ?? "failed") +
        "</td><td>" + dur(e.ms) + '</td><td class="muted">' + ago(e.at) + "</td></tr>").join("")
    : '<tr><td class="empty">No errors recorded.</td></tr>';

  $("tiers").innerHTML = "<tr><th>Tier</th><th>Classes</th><th>Fetched</th><th>Median age</th><th title="Older than the tier's slowest refresh">Overdue</th></tr>" +
    summary.tiers.map((tr) => '<tr><td class="wrap">' + esc(tr.name) + "</td><td>" + fmtNum(tr.total) + "</td><td>" + fmtNum(tr.fetched) +
      "</td><td>" + dur(tr.medianAgeMs) + '</td><td class="' + (tr.overdue ? "warn" : "") + '">' + fmtNum(tr.overdue) + "</td></tr>").join("");

  $("runs").innerHTML = summary.runs.length
    ? "<tr><th>Started</th><th>Fetched</th><th>Failed</th><th>Requests</th><th>Req/s</th></tr>" + summary.runs.map((r) =>
        "<tr><td>" + clock(Date.parse(r.startedAt)) + "</td><td>" + fmtNum(r.fetched) + (r.followerUpdates ? ' <span class="muted">+' + r.followerUpdates + "</span>" : "") +
        '</td><td class="' + (r.failed ? "bad" : "") + '">' + fmtNum(r.failed) + "</td><td>" + fmtNum(r.requests) + "</td><td>" + r.requestsPerSecond.toFixed(2) +
        (r.throttled ? ' <span class="warn">throttled</span>' : "") + "</td></tr>").join("")
    : '<tr><td class="empty">No completed runs recorded yet.</td></tr>';
}

async function load() {
  try {
    const res = await fetch("api/status", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    data = await res.json();
    offset = data.now - Date.now();
    fetchedAt = now();
  } catch (e) {
    $("sub").textContent = "Couldn't load status (" + e.message + "), retrying…";
  }
  render();
}
load();
setInterval(load, 5000);
setInterval(render, 1000);
</script>
</body>
</html>`;
