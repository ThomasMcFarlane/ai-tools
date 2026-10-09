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
var ID = /^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+|\d+(?:\.\d+)+|\d+[a-z]?)$/;
var normaliseStatus = (s) => {
  const bare = s.replace(/\*\*|~~|`/g, "").trim().replace(/^[*_]+|[*_]+$/g, "");
  const lead = bare.split(/\s*(?:\(|—|–|,|:|;|\s-\s)/)[0];
  const k = lead.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (/^(in_progress|in_review|review|partly|doing|in_pr$|in_pr_|pr_(#?\d+_)?open)/.test(k)) return "in_progress";
  if (k.startsWith("blocked") || k.startsWith("waiting_on") || k.startsWith("on_hold")) return "blocked";
  if (DONE_WORDS.includes(k.split("_")[0]) || DONE_PHRASES.some((p) => k === p || k.startsWith(`${p}_`))) return "done";
  return "todo";
};
var DONE_PHRASES = ["not_applicable", "n/a", "client_side_done", "root_cause_fixed", "runtime_validated", "re_landed"];
var DONE_WORDS = ["rejected", "declined", "deployed", "configured", "done", "complete", "completed", "closed", "merged", "recorded", "published", "accepted", "fixed", "shipped", "released", "resolved", "superseded", "implemented", "dropped", "cancelled", "canceled", "won't"];
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
  const tasks2 = [];
  let epic = "";
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
    const h = /^#{2,3}\s+(.*)$/.exec(line);
    if (h) {
      flush();
      epic = h[1].trim().replace(/^Active:\s*/, "").replace(/(?:,\s*|\s*\()\d{4}-\d{2}-\d{2}\)?$/, "");
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
    const status = normaliseStatus(c[col.status] ?? "");
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
      ...isOwnerGate(c[col.status] ?? "", status, notes, gate, names.includes(owner.split(" (")[0].trim().toLowerCase())) ? { onOwner: true } : {}
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
var isOwnerGate = (rawStatus, status, notes, gate, isNamed) => /^blocked[\s_-]+on[\s_-]+owner/i.test(rawStatus) || status === "blocked" && (isNamed || gate.test(`${rawStatus} ${notes}`));
var ACTIVE_MS = 30 * 60 * 1e3;
var FORMAT_STATUSES = ["todo", "in_progress", "in_review", "blocked", "blocked_on_owner", "done"];
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
  const raw = text2.split("\n");
  raw.forEach((line, i) => {
    if (line.startsWith("|") && (/ {2,}\|/.test(line) || /\| {2,}/.test(line))) add(i + 1, "padded-cell", "two or more spaces next to a pipe: cells must not be padded");
  });
  for (const { text: line, no } of joinRowsNumbered(raw)) {
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
      canonicalTable = col !== void 0 && c.join("|") === CANON_HEADER.join("|");
      if (col && !canonicalTable) add(no, "header", `non-canonical header: | ${c.join(" | ")} |`);
      continue;
    }
    if (col && ID.test(c[col.id] ?? "")) {
      if (seenIds.has(c[col.id])) add(no, "duplicate-id", `duplicate ID ${c[col.id]}`);
      seenIds.add(c[col.id]);
    }
    if (!col || !canonicalTable || !ID.test(c[col.id] ?? "")) continue;
    if (!FORMAT_STATUSES.includes(c[col.status] ?? "")) add(no, "status", `status outside the vocabulary: "${c[col.status]}"`);
    const eta = c[col.eta] ?? "";
    if (eta !== "" && !ETA_FORMAT.test(eta)) add(no, "eta", `ETA not YYYY-MM-DD HH:MM <timezone>: "${eta}"`);
  }
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
