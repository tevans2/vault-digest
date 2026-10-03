// A stand-in for `claude -p` that prints scripted stream-json.
// FAKE_MODE: ok | socket | invalid | hang | flaky (fails FAKE_FAILS times, counted in FAKE_COUNTER file)
import fs from "node:fs";

const mode = process.env.FAKE_MODE ?? "ok";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
let prompt = "";
process.stdin.on("data", (c) => (prompt += c));
process.stdin.on("end", () => {
  if (process.env.FAKE_PROMPT_FILE) fs.appendFileSync(process.env.FAKE_PROMPT_FILE, prompt + "\n=====\n");
  run();
});

const good = {
  announcements: [{ id: "DS346 A1!", level: "urgent", text: "A1 due tomorrow" }],
  priorities: ["Finish A1"],
  timeline: [{ start: "09:00", title: "Lecture" }, { start: "all-day", title: "Recess" }],
  notes: "Blunt notes.",
  missing: [],
  carriedForward: "",
  radar: [],
  taskOps: [],
  messages: [],
};

function toolUse(name, input) {
  out({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
}
function result(extra) {
  out({ type: "result", subtype: "success", is_error: false, session_id: "sess-1", total_cost_usd: 0.1, duration_ms: 5, ...extra });
}

function run() {
  out({ type: "system", subtype: "init", session_id: "sess-1" });
  if (mode === "hang") return setInterval(() => {}, 1000);
  if (mode === "socket") {
    out({ type: "result", subtype: "success", is_error: true, result: "API Error: socket closed", api_error_status: null, session_id: "sess-1", total_cost_usd: 0 });
    process.exit(1);
  }
  if (mode === "flaky") {
    const f = process.env.FAKE_COUNTER;
    const n = fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8")) : 0;
    fs.writeFileSync(f, String(n + 1));
    if (n < Number(process.env.FAKE_FAILS ?? 1)) {
      out({ type: "result", subtype: "success", is_error: true, result: "API Error: socket closed", session_id: "s", total_cost_usd: 0 });
      process.exit(1);
    }
  }
  if (mode === "budget") {
    out({ type: "result", subtype: "error_max_budget_usd", is_error: true, session_id: "s", total_cost_usd: 0.5 });
    process.exit(1);
  }
  toolUse("mcp__claude_ai_Google_Calendar__list_events", {});
  toolUse("Read", { file_path: "/v/.agents/google-calendar.md" });
  if (mode === "invalid" || (mode === "invalid-once" && !fs.existsSync(process.env.FAKE_COUNTER))) {
    if (mode === "invalid-once") fs.writeFileSync(process.env.FAKE_COUNTER, "1");
    return result({ structured_output: { announcements: "nope" } });
  }
  result({ structured_output: good, result: JSON.stringify(good) });
}
