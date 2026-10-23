// Text shrinking without the engine: deterministic word-level compression (English prose only), sentence
// splitting and dropping, and chunking of long tool output. Everything here is a pure function.

export const SIGNAL_LINES =
  /\b(error|errors|fail|failed|failure|failing|exception|traceback|panic|fatal|denied|refused|warning|warn|assert\w*|expected|received|not found|cannot|unable|segfault|exit code [1-9]|status [45]\d\d)\b/i
export const SIGNAL_MAX_CHARS = 1500

/** Lines of a cut part that look like failures, with one line of context either side, in order. */
export function signalLines(middle: string, maxChars = SIGNAL_MAX_CHARS): string {
  const lines = middle.split('\n')
  const keep = new Set<number>()
  lines.forEach((line, i) => {
    if (!SIGNAL_LINES.test(line)) return
    for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < lines.length) keep.add(j)
  })
  const out: string[] = []
  let used = 0
  for (const i of [...keep].sort((a, b) => a - b)) {
    const line = lines[i] as string
    if (used + line.length + 1 > maxChars) break
    out.push(line)
    used += line.length + 1
  }
  return out.join('\n')
}

/** Every negation or restriction; word compression never lowers their count. */
const NEGATION = /\b(?:not|never|no|nor|neither|none|nothing|nobody|nowhere|cannot|without|only|except|unless|barely|hardly)\b|n['’]t\b/gi
export const countNegations = (text: string) => (text.match(NEGATION) ?? []).length

// ---- line classes and protected spans -----------------------------------------------------------------------

type Kind = 'code' | 'table' | 'signal' | 'blank' | 'rule' | 'heading' | 'prose'
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/

const KEY_VALUE = /^\s*(?:-\s+)?(?:"[^"\n]+"|[A-Za-z_][\w.-]*)\s*:\s*\S/
const BRACE_ONLY = /^\s*[{}[\]],?\s*$/

function classify(text: string): { raw: string; kind: Kind }[] {
  let fence: { ch: string; len: number } | undefined
  let diff = false
  // Indentation of a line ending in `:` (`: |`, `: >`): deeper lines after it are a YAML-like block.
  let block: number | undefined
  const indent = (l: string) => (/^\s*/.exec(l)?.[0] ?? '').length
  const rows = text.split('\n').map((raw) => {
    const t = raw.trim()
    if (fence) {
      const close = /^(`+|~+)$/.exec(t)
      if (close && (close[1] as string)[0] === fence.ch && (close[1] as string).length >= fence.len) fence = undefined
      return { raw, kind: 'code' as Kind }
    }
    const open = /^(`{3,}|~{3,})/.exec(t)
    if (open) {
      fence = { ch: (open[1] as string)[0] as string, len: (open[1] as string).length }
      return { raw, kind: 'code' as Kind }
    }
    if (/^(?:@@|diff --git)/.test(t)) {
      diff = true
      return { raw, kind: 'code' as Kind }
    }
    if (diff) {
      if (t !== '') return { raw, kind: 'code' as Kind }
      diff = false
    }
    if (block !== undefined) {
      if (t === '') return { raw, kind: 'blank' as Kind }
      if (indent(raw) > block) return { raw, kind: 'code' as Kind }
      block = undefined
    }
    if (/:\s*(?:[|>][+-]?)?\s*$/.test(raw) && t !== '') block = indent(raw)
    let kind: Kind = 'prose'
    if (t === '') kind = 'blank'
    else if (t.startsWith('|') || (raw.match(/\|/g)?.length ?? 0) >= 2) kind = 'table'
    else if (/^[-*_=|: ]{3,}$/.test(t)) kind = 'rule'
    else if (/^( {4}|\t)/.test(raw) && !LIST_ITEM.test(raw)) kind = 'code'
    else if (/^\s*\$ /.test(raw) || /^\s+at\s/.test(raw) || BRACE_ONLY.test(raw) || KEY_VALUE.test(raw)) kind = 'code'
    else if (SIGNAL_LINES.test(raw)) kind = 'signal'
    else if (/^#{1,6}\s/.test(t)) kind = 'heading'
    return { raw, kind }
  })
  // A "- " line next to a "+ " line is an unheaded diff.
  rows.forEach((r, i) => {
    const n = rows[i + 1]
    if (n && ((/^- /.test(r.raw) && /^\+ /.test(n.raw)) || (/^\+ /.test(r.raw) && /^- /.test(n.raw)))) {
      r.kind = 'code'
      n.kind = 'code'
    }
  })
  return rows
}

const UNITS =
  '%|°|ms|µs|us|ns|s|secs?|seconds?|min|mins|minutes?|h|hrs?|hours?|days?|weeks?|months?|years?|[kKMGT]i?B|kb|mb|gb|tb|bytes?|bits?|px|pt|rem|em|cm|mm|km|kg|mg|g|lbs?|[kMG]?Hz|chars?|characters?|lines?|tokens?|files?|items?|rows?|requests?|messages?|times|x|k|m'
const NOTE_SPAN = String.raw`\[[^\]\n]*jev-compaction[^\]\n]*\]|\[jev dropped [^\]\n]*\]|\[… \d+ [a-z]+ cut on entry …\]`
const CODE_SPAN = '`[^`\\n]*`'
const TAIL = String.raw`(?=[.,;:!?)\]]*(?:\s|$))`
const URL_SPAN = String.raw`\b(?:https?|ftp|file|ssh|git):\/\/\S+?${TAIL}|\bwww\.\S+?${TAIL}`
const QUOTED = String.raw`“[^”\n]{0,300}”|"[^"\n]{0,300}"|(?<![\w'’])'[^'\n]{1,200}'(?!\w)`
const PATH = String.raw`\S*[\/\\]\S*?${TAIL}|\b[\w-]{2,}(?:\.[\w-]+)*\.[A-Za-z]{1,6}\b`
const DIGITS = String.raw`\S*\d\S*(?:[ \t]+(?:${UNITS})\b)?|\b\w*_\w*\b`
// Spans a sentence must not be cut around (hard) and, for word compression, also numbers with units and identifiers.
const HARD = new RegExp([NOTE_SPAN, CODE_SPAN, URL_SPAN, QUOTED, PATH].join('|'), 'g')
const ALL = new RegExp([NOTE_SPAN, CODE_SPAN, URL_SPAN, QUOTED, PATH, DIGITS].join('|'), 'g')

function mask(line: string, hard: boolean) {
  const spans: string[] = []
  const masked = line.replace(hard ? HARD : ALL, (m) => `\u0001${spans.push(m) - 1}\u0002`)
  return { masked, spans }
}
const unmask = (text: string, spans: readonly string[]) => text.replace(/\u0001(\d+)\u0002/g, (_, i: string) => spans[Number(i)] ?? '')

// ---- English detection -------------------------------------------------------------------------------------

// Words that are English and no other common language's (not is, of, for, at, was, will, we, let, or).
const STRONG = new Set('the and to that this with it you are be have not can your but if from'.split(' '))

/** Plain heuristic: nearly all ASCII letters and enough common English function words. Anything else stays unchanged. */
export function isEnglish(prose: string): boolean {
  const letters = prose.match(/\p{L}/gu) ?? []
  if (letters.length === 0) return false
  if (letters.filter((c) => c < '\u0080').length / letters.length < 0.97) return false
  const words = prose.toLowerCase().match(/[a-z']+/g) ?? []
  const strong = words.filter((w) => STRONG.has(w))
  const distinct = new Set(strong).size
  const ratio = strong.length / Math.max(1, words.length)
  return (ratio >= 0.08 && (distinct >= 2 || strong.includes('the'))) || (words.length <= 8 && distinct >= 1 && ratio >= 0.2)
}

// Common words of French, Spanish, German and Dutch that English lacks; a line with several is left alone.
const FOREIGN = new Set('il elle le la les un une des du est dans que qui pour pas nous vous el los las por con una es del voy casa oficina y der die das und ist nicht ein eine mit auf het een niet ik dat zijn'.split(' '))
const foreignLine = (line: string) => {
  const words = line.toLowerCase().match(/[\p{L}']+/gu) ?? []
  const foreign = words.filter((w) => FOREIGN.has(w)).length
  return foreign >= 2 && foreign > words.filter((w) => STRONG.has(w)).length
}

// ---- word compression --------------------------------------------------------------------------------------

const NEG_BEHIND = String.raw`(?<!(?:\bnot|\bnever|\bno|n['’]t|\bwithout|\bnor|\bhardly|\bbarely|\bonly|\bneither)\s+)`
// A whole sentence made of nothing but the phrase (and a short object): never cut across a comma or a conjunction.
const SENTENCE_START = String.raw`(?<=^|[.!?]["')\]]*[ \t]+)`
const SENTENCE_END = String.raw`(?:[.!?]+(?=\s|$)|(?=$))`
const REMOVALS: string[] = [
  String.raw`(?:that['’]s\s+(?:a\s+)?)?(?:great|good|excellent|fair|interesting)\s+question[!.,]*`,
  String.raw`(?:i\s+)?hope\s+(?:this|that|it)\s+helps(?:\s+you|\s+out)?[!.]*`,
  String.raw`${SENTENCE_START}let\s+me\s+know\s+if\s+you\s+(?:have|need|want|would\s+like)\s+(?:any\s+)?(?:more\s+|further\s+|other\s+|additional\s+)?(?:questions|help|changes|assistance|anything(?:\s+else)?)(?:\s+(?:about|with|on)\s+(?:this|that|it))?${SENTENCE_END}`,
  String.raw`${SENTENCE_START}feel\s+free\s+to\s+(?:ask|reach\s+out)(?:\s+(?:me|us))?(?:\s+(?:any|more|further)\s+questions)?(?:\s+if\s+(?:you\s+(?:have|need|want)\s+(?:any\s+)?(?:more\s+|further\s+)?(?:questions|help)|(?:anything|something)\s+is\s+unclear))?${SENTENCE_END}`,
  String.raw`thanks\s+for\s+(?:asking|your\s+patience|waiting)[!.,]*`,
  String.raw`(?:it['’]s|it\s+is)\s+(?:worth|important)\s+(?:noting|to\s+note)\s+that,?|please\s+note\s+that,?|needless\s+to\s+say,?`,
  String.raw`${NEG_BEHIND}(?:basically|actually|simply|really|essentially|obviously|honestly|literally),?`,
]
const REMOVAL_RES = REMOVALS.map((body) => new RegExp(String.raw`([ \t]*)\b(?:${body})(?!\w)([ \t]*)(\S?)`, 'gi'))

function strip(line: string, re: RegExp): string {
  return line.replace(re, (_m, lead: string, _trail: string, next: string, offset: number, whole: string) => {
    const before = whole.slice(0, offset)
    const start = before.trim() === '' || /[.!?]["')\]]*\s*$/.test(before)
    if (next === '' || /[.,;:!?)\]]/.test(next)) return next
    return `${lead || (before.trim() === '' ? '' : ' ')}${start ? next.toUpperCase() : next}`
  })
}

const FUNCTION_WORDS = new Set('is are was were and or to as has have will would should can could does did vs then if in on of at by for from with but not it that this'.split(' '))
const LETTER_CONTEXT = /^(?:option|case|plan|variant|step|point|type|section|part|branch|choice|phase|version|key|variable|var|letter|label|group|class|grade|level|scenario|mode|stage|item|block|vitamin|figure|fig|appendix|chapter|table|row|column|line)$/i
const QUANTIFIERS = new Set(['few', 'lot', 'bit', 'little', 'couple', 'number', 'handful'])

function dropArticles(line: string): string {
  return line.replace(/(?<=^|[\s(,;:])\b(a|an|the)[ \t]+([a-z][a-z'-]*)\b/g, (m, article: string, next: string, offset: number, whole: string) => {
    if (next.length === 1 || next === 'the' || next === 'an' || next === 'a' || FUNCTION_WORDS.has(next) || (article !== 'the' && QUANTIFIERS.has(next))) return m
    const prev = /([A-Za-z]+)\W*$/.exec(whole.slice(0, offset))?.[1]
    if (article === 'a' && prev && LETTER_CONTEXT.test(prev)) return m
    return next
  })
}

function plainProse(masked: string): boolean {
  const words = masked.trim().split(/\s+/).filter(Boolean)
  if (words.length < 6 || /^\s*#/.test(masked)) return false
  return words.filter((w) => w.includes('\u0001')).length / words.length <= 0.35
}

function pass(text: string, user: boolean): string {
  const lines = classify(text)
  // English is judged per paragraph (a run of non-blank lines), so one foreign paragraph does not block the rest.
  const english: boolean[] = []
  for (let i = 0; i < lines.length; ) {
    if (lines[i]?.kind === 'blank') {
      english[i++] = false
      continue
    }
    let j = i
    while (j < lines.length && lines[j]?.kind !== 'blank') j++
    const prose = lines.slice(i, j).filter((l) => l.kind === 'prose')
    const ok = isEnglish(prose.map((l) => mask(l.raw, false).masked).join('\n'))
    for (let k = i; k < j; k++) english[k] = ok && !foreignLine(lines[k]?.raw ?? '')
    i = j
  }
  const out: string[] = []
  let previous: Kind | undefined
  for (const [at, { raw, kind }] of lines.entries()) {
    if (kind === 'blank' && previous === 'blank') continue
    previous = kind
    if (kind !== 'prose' || !english[at]) {
      out.push(raw)
      continue
    }
    const prefix = /^\s*(?:(?:[-*+>]+|\d+[.)])\s+)?/.exec(raw)?.[0] ?? ''
    const { masked, spans } = mask(raw.slice(prefix.length), false)
    let s = masked.replace(/(?<=\S)[ \t]{2,}(?=\S)/g, ' ')
    if (!user) {
      for (const re of REMOVAL_RES) s = strip(s, re)
      s = s.replace(/\bin order to\b/gi, (m) => (m.startsWith('I') ? 'To' : 'to')).replace(/\bdue to the fact that\b/gi, 'because')
    }
    if (plainProse(s)) s = dropArticles(s)
    s = unmask(s, spans)
    if (prefix + s !== raw) {
      s = s.replace(/[ \t]+$/, '')
      if (s.trim() === '') continue
    }
    out.push(prefix + s)
  }
  return out.join('\n')
}

/**
 * Cuts pleasantries, hedges and joining words, drops a/an/the in plain English prose and collapses repeated
 * whitespace. Code, paths, URLs, numbers with units, quoted strings, failure lines, tables and the mod's own
 * notes are left alone, and so is non-English text. A negation is never lost. Idempotent. With `user`, nothing
 * is removed: only articles in plain prose and whitespace. Text with CRLF line ends, or that would become empty,
 * is returned unchanged.
 */
export function compressWords(text: string, options: { user?: boolean } = {}): string {
  if (text.trim().length === 0 || text.includes('\r') || /[\u0001\u0002]/.test(text)) return text
  let current = text
  for (let i = 0; i < 6; i++) {
    const next = pass(current, options.user === true)
    if (next === current) break
    current = next
  }
  return current.trim() !== '' && countNegations(current) === countNegations(text) ? current : text
}

// ---- sentences ---------------------------------------------------------------------------------------------

export type Segment = { text: string; atomic: boolean }
const ABBREVIATION = /(?:^|\W)(?:e\.g|i\.e|etc|vs|mr|mrs|ms|dr|cf|approx|fig)\.$/i

function splitMasked(masked: string): string[] {
  const out: string[] = []
  let last = 0
  for (const m of masked.matchAll(/[.!?]["')\]]*[ \t]+(?=["'(\[]*[A-Z0-9\u0001])/g)) {
    if (ABBREVIATION.test(masked.slice(0, m.index + 1))) continue
    const end = m.index + m[0].length
    out.push(masked.slice(last, end))
    last = end
  }
  out.push(masked.slice(last))
  return out.filter((p) => p !== '')
}

/**
 * Splits text into sentences and bullet lines; the pieces join back to the exact input. Code, tables, headings,
 * failure lines, questions and anything holding inline code, a URL, a path or a quoted string are atomic.
 */
const MODAL = /\b(must|should|never|always|required?|do not|don't)\b/i

export function splitSentences(text: string): Segment[] {
  const out: Segment[] = []
  const lines = classify(text)
  lines.forEach(({ raw, kind }, i) => {
    const nl = i < lines.length - 1 ? '\n' : ''
    if (kind !== 'prose') {
      if (raw + nl !== '') out.push({ text: raw + nl, atomic: true })
      return
    }
    const { masked, spans } = mask(raw, true)
    const pieces = LIST_ITEM.test(raw) ? [masked] : splitMasked(masked)
    pieces.forEach((piece, j) => {
      const sentence = unmask(piece, spans)
      out.push({
        text: sentence + (j === pieces.length - 1 ? nl : ''),
        atomic:
          piece.includes('\u0001') ||
          SIGNAL_LINES.test(sentence) ||
          /\?["')\]]*\s*$/.test(sentence) ||
          countNegations(sentence) > 0 ||
          MODAL.test(sentence) ||
          /^\s*\d+[.)]\s/.test(sentence),
      })
    })
  })
  return out
}

export const SENTENCE_MIN_CHARS = 600
const SENTENCE_ASK_MAX = 40
const SENTENCE_ASK_MIN = 15

export type SentencePlan = { segments: Segment[]; total: number; ask: { segment: number; text: string }[] }

/** The sentences worth a Jev question (not atomic, not tiny, at most 40 per message) and the count of all sentences. */
export function planSentences(text: string): SentencePlan {
  const segments = splitSentences(text)
  const ask: SentencePlan['ask'] = []
  const total = segments.filter((s) => s.text.trim() !== '').length
  // With fewer than three sentences the drop cap leaves nothing droppable, so nothing is asked.
  segments.forEach((s, segment) => {
    if (total >= 3 && !s.atomic && s.text.trim().length >= SENTENCE_ASK_MIN && ask.length < SENTENCE_ASK_MAX) ask.push({ segment, text: s.text.trim() })
  })
  return { segments, total, ask }
}

export const sentenceQuestion = (where: string, text: string) =>
  `This sentence of ${where} carries information still needed (a fact, decision, result, constraint, path, command or next step), not padding, a recap or a pleasantry: ${JSON.stringify(text.length > 240 ? `${text.slice(0, 239)}…` : text)}`

/** Segments scoring below the threshold, lowest first, never more than `ratio` of all the message's sentences. */
export function pickDrops(plan: Pick<SentencePlan, 'total'>, scored: readonly { segment: number; p: number }[], threshold: number, ratio: number): Set<number> {
  const max = Math.floor(Math.min(1, Math.max(0, ratio)) * plan.total)
  return new Set(
    scored
      .filter((s) => s.p < threshold)
      .sort((a, b) => a.p - b.p || a.segment - b.segment)
      .slice(0, max)
      .map((s) => s.segment),
  )
}

/** The compaction's note pins a message against another cut; the entry's does not, so a compaction may still judge it. */
export const sentencesNote = (n: number, entry = false) => `[… ${n} sentence${n === 1 ? '' : 's'} ${entry ? 'cut on entry' : 'omitted by jev-compaction'} …]`

/** Joins the kept segments; the note stands where the first sentence was cut, and a dropped line end stays. */
export function dropSegments(segments: readonly Segment[], drop: ReadonlySet<number>, note?: (n: number) => string): { text: string; dropped: number } {
  const counted = (i: number) => drop.has(i) && (segments[i]?.text.trim() ?? '') !== ''
  const dropped = segments.filter((_, i) => counted(i)).length
  let out = ''
  let runCount = 0
  segments.forEach((s, i) => {
    if (!drop.has(i)) {
      out += s.text
      return
    }
    const nl = /\n*$/.exec(s.text)?.[0] ?? ''
    if (note && !drop.has(i - 1)) {
      // One note per run of consecutive cuts, with that run's own count.
      runCount = 0
      for (let j = i; drop.has(j); j++) if (counted(j)) runCount++
      if (out !== '' && !/\s$/.test(out)) out += ' '
      out += note(runCount) + (nl || ' ')
    } else if (nl && out !== '' && !out.endsWith('\n')) out = out.replace(/[ \t]+$/, '') + nl
  })
  return { text: out.replace(/ +$/, ''), dropped }
}

// ---- long tool output ---------------------------------------------------------------------------------------

export const RESULT_MIN_CHARS = 12_000
const RESULT_HEAD = 1500
const RESULT_TAIL = 1500
const RESULT_CHUNK = 1200
const RESULT_CHUNKS_MAX = 60

export type Chunk = { text: string; forced: boolean }

/** Splits long output into line-aligned chunks of about 1200 characters (at most 60); the first and last stay. */
export function chunkText(text: string): Chunk[] {
  const target = Math.max(RESULT_CHUNK, Math.ceil(text.length / RESULT_CHUNKS_MAX))
  const chunks: Chunk[] = []
  let current = ''
  let start = 0
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    current += i < lines.length - 1 ? `${line}\n` : line
    if (current.length >= target || i === lines.length - 1) {
      const end = start + current.length
      chunks.push({ text: current, forced: start < RESULT_HEAD || end > text.length - RESULT_TAIL })
      start = end
      current = ''
    }
  })
  return chunks
}

export const chunkQuestion = (tool: string, from: number, to: number, total: number, text: string) =>
  `This chunk (characters ${from} to ${to} of ${total}) of the output of a ${tool} tool call carries information still needed (a result, value, error, name or path), not repeated listing, boilerplate or progress noise: ${JSON.stringify(text.length > 320 ? `${text.slice(0, 220)} … ${text.slice(-100)}` : text)}`

/** Joins the kept chunks; each run of dropped ones leaves its failure lines and one omission note. */
export function joinChunks(chunks: readonly Chunk[], keep: readonly boolean[], entry = false): string {
  let out = ''
  let gone = ''
  const flush = () => {
    if (gone === '') return
    const signals = signalLines(gone)
    out += `${signals ? `${signals}\n` : ''}[… ${gone.length} chars ${entry ? 'cut on entry' : 'omitted by jev-compaction'} …]\n`
    gone = ''
  }
  chunks.forEach((c, i) => {
    if (keep[i] || c.forced) {
      flush()
      out += c.text
    } else gone += c.text
  })
  flush()
  return out
}
