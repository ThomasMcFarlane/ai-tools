#!/usr/bin/env node

// src/cli.ts
import { readFileSync } from "node:fs";

// ../../mods/tasks-board/hooks/board.ts
var ETA = /(?<![-_/.A-Za-z])ETA(?:\s*[:=]\s*|\s+(?=[\d~]))((?:[\d~]|[Tt]oday|[Tt]omorrow|Mon|Tue|Wed|Thu|Fri|Sat|Sun)[^.;|]{0,39})/;
var extractEta = (notes) => ETA.exec(notes)?.[1]?.trim() ?? "";
var escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
var gateCache = /* @__PURE__ */ new Map();
function ownerGate(names) {
  const key = names.join("|");
  let re = gateCache.get(key);
  if (!re) {
    const who = ["owner", ...names.map(escapeRe)].join("|");
    const named = names.length > 0 ? `|(${names.map(escapeRe).join("|")}) (to|must|needs to) (decide|approve|confirm|choose)` : "";
    re = new RegExp(
      `owner action|owner decision|owner approval|owner\\/user[- ]choice|needs (the )?owner|waiting (on|for) (the )?(${who})|awaiting (${who}|approval from)|blocked on (the )?(${who})|user[- ]choice gate${named}`,
      "i"
    );
    gateCache.set(key, re);
  }
  return re;
}
var ID = /^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+|[A-Z]{1,4}\d+[a-z]?|\d+(?:\.\d+)+|\d+[a-z]?)$/;
var normaliseStatus = (s, ownerPaused2 = false) => {
  const bare = s.replace(/\*\*|~~|`/g, "").trim().replace(/^[*_]+|[*_]+$/g, "");
  const lead = bare.split(/\s*(?:\(|—|–|,|:|;|\s-\s)/)[0];
  const k = lead.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (/^(in_progress|in_review|review|partly|doing|in_pr$|in_pr_|pr_(#?\d+_)?open)/.test(k)) return "in_progress";
  if (k === "parked") return "parked";
  if (/^(deferred|on_hold|later|postponed|backlog)(_|$)/.test(k)) return ownerPaused2 ? "parked" : "todo";
  if (k.startsWith("blocked") || k.startsWith("waiting_on")) return "blocked";
  if (DONE_WORDS.includes(k.split("_")[0]) || DONE_PHRASES.some((p) => k === p || k.startsWith(`${p}_`))) return "done";
  return "todo";
};
var DONE_PHRASES = ["client_side_done", "root_cause_fixed", "runtime_validated", "re_landed"];
var DONE_WORDS = ["rejected", "declined", "deployed", "configured", "done", "complete", "completed", "closed", "merged", "recorded", "published", "accepted", "fixed", "shipped", "released", "resolved", "superseded", "implemented", "dropped", "cancelled", "canceled", "wontfix", "abandoned", "obsolete", "won't"];
var cells = (line) => line.trim().replace(/^\|/, "").replace(/(?<!\\)\|\s*$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
function joinRowsNumbered(lines) {
  const out = [];
  let buf;
  lines.forEach((line, i) => {
    if (buf !== void 0) {
      if (line.trim() !== "" && !line.startsWith("|") && !/^#{1,6}\s/.test(line)) {
        buf.text += ` ${line.trim()}`;
        if (/(?<!\\)\|\s*$/.test(line)) {
          out.push(buf);
          buf = void 0;
        }
        return;
      }
      out.push(buf);
      buf = void 0;
    }
    if (line.startsWith("|") && !/(?<!\\)\|\s*$/.test(line)) buf = { text: line, no: i + 1 };
    else out.push({ text: line, no: i + 1 });
  });
  if (buf !== void 0) out.push(buf);
  return out;
}
var joinRows = (lines) => joinRowsNumbered(lines).map((l) => l.text);
function columnsOf(c) {
  const at = (re) => c.findIndex((x) => re.test(x));
  const id = at(/^(#|id)$/i);
  const task = at(/^(task|title|workstream)/i);
  const status = at(/^status/i);
  if (id < 0 || task < 0 || status < 0) return void 0;
  const notes = at(/^(notes|acceptance)/i);
  return { id, task, status, owner: at(/^(owner|picked up by|assignee|agent)/i), depends: at(/^depend/i), eta: at(/^eta/i), branch: at(/^branch/i), notes: notes < 0 ? c.length - 1 : notes };
}
var PROGRESS_ITEM = /Pending: live|pending live|in progress|\bPR #\d+/i;
var ITEM_ID = /^(#\d+|[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+|P\d+)(?::|\s|$)/;
function checklistTask(isDone, text2, epic, section, item, taken, gate) {
  const m = ITEM_ID.exec(text2);
  const token = m && !taken.has(m[1]) ? m[1] : "";
  const id = token || `${section}.${item}`;
  taken.add(id);
  const body = token ? text2.slice(token.length).replace(/^[:\s]+/, "") : text2;
  const cut = body.slice(20).search(/[.:]\s/);
  const title = (cut < 0 ? body : body.slice(0, 20 + cut)).slice(0, 120);
  const ownerItem = !isDone && gate.test(text2);
  const status = isDone ? "done" : ownerItem ? "blocked" : PROGRESS_ITEM.test(text2) ? "in_progress" : "todo";
  return {
    id,
    key: id,
    n: Number(/(\d+)$/.exec(id)?.[1] ?? item),
    title,
    status,
    owner: "",
    agent: "",
    depends: "",
    notes: text2,
    epic,
    eta: extractEta(text2),
    line: text2,
    ...ownerItem ? { onOwner: true } : {}
  };
}
function parseBoard(text2, opts = {}) {
  const names = (opts.ownerNames ?? []).map((n) => n.toLowerCase());
  const gate = ownerGate(opts.ownerNames ?? []);
  const canonical = /\|\s*blocked_on_owner\s*\|/.test(text2) || lintBoard(text2).canonical;
  const tasks2 = [];
  let epic = "";
  let parent = "";
  let col;
  let section = 0;
  let item = 0;
  let pending;
  const taken = /* @__PURE__ */ new Set();
  const flush = () => {
    if (pending) tasks2.push(checklistTask(pending.isDone, pending.text, epic, section, item, taken, gate));
    pending = void 0;
  };
  let prev = [];
  for (const line of joinRows(text2.split("\n"))) {
    const h = /^(#{2,3})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      const name = h[2].trim().replace(/^Active:\s*/, "").replace(/(?:,\s*|\s*\()\d{4}-\d{2}-\d{2}\)?$/, "");
      if (h[1] === "##") parent = epic = name;
      else epic = /^\d+\.\s+\S/.test(parent) ? `${parent} \u203A ${name}` : name;
      section += 1;
      item = 0;
      continue;
    }
    const box = /^- \[( |x|X)\]\s*(.*)$/.exec(line);
    if (box) {
      flush();
      item += 1;
      pending = { isDone: box[1] !== " ", text: box[2].trim() };
      continue;
    }
    if (pending) {
      if (/^\s+\S/.test(line)) {
        pending.text += ` ${line.trim()}`;
        continue;
      }
      flush();
    }
    if (!line.startsWith("|")) continue;
    const c = cells(line);
    const before = prev;
    prev = c;
    if (/^(#|id)$/i.test(c[0] ?? "")) {
      col = columnsOf(c);
      continue;
    }
    if (c.length > 0 && c.every((x) => /^:?-{2,}:?$/.test(x))) {
      if (!/^(#|id)$/i.test(before[0] ?? "")) col = void 0;
      continue;
    }
    const id = c[col?.id ?? 0] ?? "";
    if (!col || !ID.test(id)) continue;
    const owner = col.owner < 0 ? "" : c[col.owner] ?? "";
    const notes = c.slice(col.notes).join(" | ");
    const status = normaliseStatus(c[col.status] ?? "", ownerPaused(`${c[col.status] ?? ""} ${notes}`, names));
    tasks2.push({
      id,
      key: id,
      n: Number(/(\d+)[a-z]?$/.exec(id)?.[1] ?? 0),
      title: c[col.task] ?? "",
      status,
      owner,
      agent: owner.split(" (")[0].trim(),
      depends: col.depends < 0 ? "" : c[col.depends] ?? "",
      notes,
      epic,
      eta: (col.eta >= 0 ? c[col.eta] : "") || extractEta(notes),
      line,
      ...col.branch >= 0 && c[col.branch] ? { branch: c[col.branch] } : {},
      ...isOwnerGate(c[col.status] ?? "", status, notes, gate, canonical, names.includes(owner.split(" (")[0].trim().toLowerCase())) ? { onOwner: true } : {}
    });
  }
  flush();
  const seen = /* @__PURE__ */ new Map();
  for (const t of tasks2) {
    const n = (seen.get(t.id) ?? 0) + 1;
    seen.set(t.id, n);
    t.key = n === 1 ? t.id : `${t.id}#${n}`;
  }
  return tasks2;
}
var ownerPaused = (text2, names) => {
  const who = ["owner", ...names.map(escapeRe)].join("|");
  return new RegExp(`\\b(${who})\\b[^.;|]{0,30}\\b(paused|parked|held|deferred|postponed|decision)|\\b(paused|parked|held|deferred|postponed|put on hold) (by|per) (the )?(${who})\\b|\\b(${who})[ -](decision|paused)`, "i").test(text2);
};
var isOwnerGate = (rawStatus, status, notes, gate, canonical, isNamed) => /^blocked[\s_-]+on[\s_-]+owner/i.test(rawStatus) || !canonical && status === "blocked" && (isNamed || gate.test(`${rawStatus} ${latestUpdate(notes)}`));
function latestUpdate(notes) {
  const ds = [...notes.matchAll(/\d{4}-\d{2}-\d{2}/g)];
  if (ds.length === 0) return notes;
  let best = 0;
  ds.forEach((d, i) => {
    if (d[0] >= ds[best][0]) best = i;
  });
  return notes.slice(ds[best].index, ds[best + 1]?.index);
}
var ACTIVE_MS = 30 * 60 * 1e3;
var FORMAT_STATUSES = ["todo", "in_progress", "in_review", "blocked", "blocked_on_owner", "parked", "done", "dropped", "superseded"];
var CANON_HEADER = ["ID", "Task", "Status", "Owner", "Branch", "Depends", "ETA", "Notes"];
var ETA_FORMAT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} (?:[A-Z]{2,5}|UTC[+-]\d{2}(?::?\d{2})?|[+-]\d{2}:\d{2})$/;
function lintBoard(text2) {
  const findings = [];
  const add = (line, rule, message) => findings.push({ line, rule, message });
  let canonicalTable = false;
  let col;
  let items = 0;
  let firstItem = 0;
  const seenIds = /* @__PURE__ */ new Set();
  let prev = [];
  const epics = [];
  const refs = /* @__PURE__ */ new Set();
  const deps = [];
  const superseders = [];
  const raw = text2.split("\n");
  raw.forEach((line, i) => {
    if (line.startsWith("|") && (/ {2,}\|/.test(line) || /\| {2,}/.test(line))) add(i + 1, "padded-cell", "two or more spaces next to a pipe: cells must not be padded");
  });
  for (const { text: line, no } of joinRowsNumbered(raw)) {
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading) epics.push({ no, num: /^(\d+)\.\s+\S/.exec(heading[1].trim())?.[1], hasTable: false });
    if (/^- \[( |x|X)\]/.test(line)) {
      items += 1;
      firstItem ||= no;
    }
    if (!line.startsWith("|")) continue;
    const c = cells(line);
    const before = prev;
    prev = c;
    if (c.length > 0 && c.every((x) => /^:?-{2,}:?$/.test(x))) {
      if (!/^(#|id)$/i.test(before[0] ?? "")) col = void 0;
      continue;
    }
    if (/^(#|id)$/i.test(c[0] ?? "")) {
      col = columnsOf(c);
      if (col && epics.length > 0) epics[epics.length - 1].hasTable = true;
      canonicalTable = col !== void 0 && c.join("|") === CANON_HEADER.join("|");
      if (col && !canonicalTable) add(no, "header", `non-canonical header: | ${c.join(" | ")} |`);
      continue;
    }
    if (col && ID.test(c[col.id] ?? "")) {
      if (seenIds.has(c[col.id])) add(no, "duplicate-id", `duplicate ID ${c[col.id]}`);
      seenIds.add(c[col.id]);
    }
    if (!col || !canonicalTable || !ID.test(c[col.id] ?? "")) continue;
    if (!FORMAT_STATUSES.includes(c[col.status] ?? "")) add(no, "status", `status "${c[col.status]}" is not one of ${FORMAT_STATUSES.join(", ")}; see FORMAT.md, Legacy statuses`);
    else if (c[col.status] === "dropped" && !/^Dropped: \S/.test(c.slice(col.notes).join(" | "))) add(no, "dropped", 'dropped row needs Notes starting "Dropped: <reason>."');
    else if (c[col.status] === "superseded") {
      const ref = /^Superseded by (\d+\.[^\s,;]*[^\s,;.])/.exec(c.slice(col.notes).join(" | "))?.[1];
      if (ref === void 0) add(no, "superseded", 'superseded row needs Notes starting "Superseded by <epic>.<task>."');
      else superseders.push({ no, ref });
    }
    const epicNum = epics[epics.length - 1]?.num;
    if (epicNum !== void 0) refs.add(`${epicNum}.${c[col.id]}`);
    if (col.depends >= 0 && (c[col.depends] ?? "") !== "") deps.push({ no, value: c[col.depends] });
    const eta = c[col.eta] ?? "";
    if (eta !== "" && !ETA_FORMAT.test(eta)) add(no, "eta", `ETA not YYYY-MM-DD HH:MM <timezone>: "${eta}"`);
  }
  const seenNums = /* @__PURE__ */ new Set();
  for (const e of epics.filter((x) => x.hasTable)) {
    if (e.num === void 0) add(e.no, "epic-number", 'epic heading without a number: expected "## <N>. <name>"');
    else if (seenNums.has(e.num)) add(e.no, "epic-unique", `duplicate epic number ${e.num}`);
    if (e.num !== void 0) seenNums.add(e.num);
  }
  for (const d of deps)
    for (const ref of d.value.split(",").map((x) => x.trim())) {
      if (!/^\d+\..+$/.test(ref)) add(d.no, "depends", `Depends entry not an <epic>.<task> reference: "${ref}"`);
      else if (!refs.has(ref)) add(d.no, "depends", `Depends reference ${ref} matches no row`);
    }
  for (const s of superseders) if (!refs.has(s.ref)) add(s.no, "superseded", `Superseded by reference ${s.ref} matches no row`);
  if (items > 0) add(firstItem, "checklist", `${items} checklist items instead of table rows`);
  findings.sort((a, b) => a.line - b.line);
  return { canonical: findings.length === 0, issues: [...new Set(findings.map((f) => f.message))], findings };
}
var checkBoard = (text2, mode) => lintBoard(text2).findings.filter((f) => mode === "canonical" || f.rule === "duplicate-id" || f.rule === "padded-cell");
var FIX_WINDOW_MS = 24 * 60 * 60 * 1e3;

// src/check.ts
function check(text2, format2 = "canonical") {
  const problems2 = checkBoard(text2, "canonical");
  const failing = checkBoard(text2, format2);
  return { problems: problems2, tasks: parseBoard(text2).length, failed: failing.length > 0 };
}

// src/cli.ts
var args = process.argv.slice(2);
var path = "TASKS.md";
var format = "canonical";
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--format" || a.startsWith("--format=")) {
    const v = a === "--format" ? args[++i] : a.slice(9);
    if (v !== "canonical" && v !== "lenient") {
      console.error(`unknown --format "${v}" (canonical or lenient)`);
      process.exit(2);
    }
    format = v;
  } else path = a;
}
var text;
try {
  text = readFileSync(path, "utf8");
} catch (e) {
  console.error(`cannot read ${path}: ${e.message}`);
  process.exit(2);
}
var { problems, tasks, failed } = check(text, format);
for (const p of problems) console.log(`${path}:${p.line}: [${p.rule}] ${p.message}`);
console.log(
  `${path}: ${tasks} tasks, ${problems.length} problems (${format}) - ${failed ? "FAIL" : "ok"}`
);
process.exit(failed ? 1 : 0);
