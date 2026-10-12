import { describe, expect, test } from 'claude-code/testing'

import {
  SIGNAL_LINES,
  chunkText,
  compressWords,
  countNegations,
  dropSegments,
  joinChunks,
  pickDrops,
  planSentences,
  sentencesNote,
  splitSentences,
} from './squeeze'

// [name, input, output]; every output is also a fixed point.
const WORDS: [string, string, string][] = [
  ['pleasantry opener and offer to help', "Sure! I'd be happy to help. Let me check the logs and basically see what's going on.", "Sure! I'd be happy to help. Let me check logs and see what's going on."],
  ['closer', 'The migration ran. Hope this helps!', 'The migration ran.'],
  ['closer about further questions', 'It is done. Let me know if you have any further questions.', 'It is done.'],
  ['in order to', 'In order to fix the problem, you simply need to run the migration.', 'To fix problem, you need to run migration.'],
  ['hedge after a full stop keeps the spacing', 'Done. Let me check the logs. Actually, the fix is simple.', 'Done. Let me check logs. The fix is simple.'],
  ['indentation survives', '  Sure! Let me do it.', '  Sure! Let me do it.'],
  ['list markers survive and the item is capitalised', '1. Let me update the file\n2. Hope this helps', '1. Let me update the file'],
  ['bullet', '- Sure! Let me update the file now\n- the plan is fine and we are going ahead with it', '- Sure! Let me update file now\n- plan is fine and we are going ahead with it'],
  ['repeated whitespace', 'The   test   took 5 ms and used 3 MB of the memory in the end.', 'The test took 5 ms and used 3 MB of memory in end.'],
  ['blank lines collapse, code is untouched', 'First para is here and it is fine.\n\n\n\n```\nthe  code  here\n```\nlast one is not changed', 'First para is here and it is fine.\n\n```\nthe  code  here\n```\nlast one is not changed'],
  ['inline code, paths and URLs', 'Run `the cat a file` and see /usr/the/path.txt and https://example.com/the/page for the details of the plan.', 'Run `the cat a file` and see /usr/the/path.txt and https://example.com/the/page for details of plan.'],
  ['numbers with units', 'It took the 250 ms and the 3 MB of the cache in the run.', 'It took the 250 ms and the 3 MB of cache in run.'],
  ['quoted strings', 'He said "the answer is a simple one" and the rest of the team agreed with him.', 'He said "the answer is a simple one" and rest of team agreed with him.'],
  ['article that is part of a name', 'The Hague is the capital of the province, and a Tale of Two Cities is a book that the author wrote.', 'The Hague is capital of province, and a Tale of Two Cities is book that author wrote.'],
  ['a letter or option label is not an article', 'In option a is the cheaper route and plan a is the one we picked after the review.', 'In option a is cheaper route and plan a is one we picked after review.'],
  ['a few and a lot keep their article', 'There are a few files and a lot of the noise in the output of the build here.', 'There are a few files and a lot of noise in output of build here.'],
  ['the line with a failure word is left alone', 'Great question! The build is really failing because the config file is missing.', 'Great question! The build is really failing because the config file is missing.'],
  ['table', '| the | a |\n|---|---|\n| the cat | a dog |', '| the | a |\n|---|---|\n| the cat | a dog |'],
  ['indented code block', 'Do this now:\n\n    the   thing  = a value\n\nthen the rest follows.', 'Do this now:\n\n    the   thing  = a value\n\nthen the rest follows.'],
  ['non-English is unchanged', 'Das ist ein Test und der Hund ist nicht hier, aber just in case.', 'Das ist ein Test und der Hund ist nicht hier, aber just in case.'],
  ['French is unchanged', "Je pense que le fichier est la, mais je n'en suis pas sur du tout, et on verra.", "Je pense que le fichier est la, mais je n'en suis pas sur du tout, et on verra."],
  ['the mod notes are untouched', 'Earlier the output was cut [jev-compaction truncated 900 chars of the tool result; re-run the tool if needed] and then it ended.', 'Earlier output was cut [jev-compaction truncated 900 chars of the tool result; re-run the tool if needed] and then it ended.'],
  ['a stub is untouched', '[earlier assistant message omitted by jev-compaction: 1234 chars]', '[earlier assistant message omitted by jev-compaction: 1234 chars]'],
  ['Let me know is a question to the user', 'Let me know which option you prefer.', 'Let me know which option you prefer.'],
  ['just in case keeps just', 'Keep a copy just in case the deploy goes wrong tonight.', 'Keep copy just in case deploy goes wrong tonight.'],
  ['really after not keeps its force', 'It is not really working, and I do not just want to retry the build.', 'It is not really working, and I do not just want to retry build.'],
  ['empty', '', ''],
  ["review case 1", "You should let me review the diff before you commit anything to the branch.", "You should let me review diff before you commit anything to branch."],
  ["review case 2", "Don't let me push to main by accident, even if I ask you to do it later.", "Don't let me push to main by accident, even if I ask you to do it later."],
  ["review case 3", "Please let me run the migration myself; you only prepare the script for it.", "Please let me run migration myself; you only prepare script for it."],
  ["review case 4", "Let me know if you need anything else, otherwise go ahead and merge the PR now.", "Let me know if you need anything else, otherwise go ahead and merge the PR now."],
  ["review case 5", "Let me know if you have any questions for the infra team before you rotate the key tonight.", "Let me know if you have any questions for infra team before you rotate key tonight."],
  ["review case 6", "Feel free to ask the DB team for access since they own the credentials for prod.", "Feel free to ask the DB team for access since they own credentials for prod."],
  ["review case 7", "I'd be happy to review it tomorrow if you push the branch to the remote first.", "I'd be happy to review it tomorrow if you push branch to remote first."],
  ["review case 8", "I would be glad to pair on the refactor, but do the rename in the parser first.", "I would be glad to pair on refactor, but do rename in parser first."],
  ["review case 9", "I'm not sure, but the cache may be stale after the deploy finished last night.", "I'm not sure, but cache may be stale after deploy finished last night."],
  ["review case 10", "I am sure. The cache is stale after the deploy, so restart the worker pool.", "I am sure. The cache is stale after deploy, so restart worker pool."],
  ["review case 11", "Before you deploy anything to the cluster, make sure. Then restart the queue.", "Before you deploy anything to cluster, make sure. Then restart queue."],
  ["review case 12", "It just checks the header and ignores the body of the request entirely here.", "It just checks header and ignores body of request entirely here."],
  ["review case 13", "Just run the unit tests for the parser and skip the integration suite entirely.", "Just run unit tests for parser and skip integration suite entirely."],
  ["review case 14", "The build just finished, so the artifact in the bucket is the new one now.", "The build just finished, so artifact in bucket is new one now."],
  ["review case 15", "This change actually breaks the public API for every consumer of the package.", "This change breaks public API for every consumer of package."],
  ["review case 16", "Keep the default value and do not change the flag for the release build now.", "Keep default value and do not change flag for release build now."],
  ["review case 17", "Use the [docs](https://example.com/the guide) and the [README](./the README.md) for the setup steps here.", "Use the [docs](https://example.com/the guide) and the [README](./the README.md) for setup steps here."],
  ["review case 18", "Run `git log --oneline` then `the thing` and check the output for a hash today.", "Run `git log --oneline` then `the thing` and check output for hash today."],
  ["review case 19", "Set the value to a string and the key to an integer in the config file today.", "Set value to string and key to integer in config file today."],
  ["review case 20", "The service may restart, and you must keep a backup of the database before it.", "The service may restart, and you must keep backup of database before it."],
  ["review case 21", "Il a un fichier dans le dossier.\nThe parser reads the file and then it writes the output to the cache for the user.\nThe worker reads the queue and then it writes the result to the store for the team.", "Il a un fichier dans le dossier.\nThe parser reads file and then it writes output to cache for user.\nThe worker reads queue and then it writes result to store for team."],
  ["review case 22", "Voy a casa y a la oficina.\nThe parser reads the file and then it writes the output to the cache for the user.", "Voy a casa y a la oficina.\nThe parser reads file and then it writes output to cache for user."],
  ["review case 23", "- the actually important line of the readme is here and it is basically wrong\n+ the really important line of the readme is here and it is simply fixed", "- the actually important line of the readme is here and it is basically wrong\n+ the really important line of the readme is here and it is simply fixed"],
  ["review case 24", "Apply this hunk:\n@@ -3,2 +3,2 @@\n-This is the really old text of the README for the user\n+This is the actually new text of the README for the user", "Apply this hunk:\n@@ -3,2 +3,2 @@\n-This is the really old text of the README for the user\n+This is the actually new text of the README for the user"],
  ["review case 25", "name: the app\ndescription: Just a simple tool that is really useful for the team today\nversion: 1", "name: the app\ndescription: Just a simple tool that is really useful for the team today\nversion: 1"],
  ["review case 26", "    at Object.<anonymous> (the/file.js:10:5)\n  at the really deep call in the module loader of node today", "    at Object.<anonymous> (the/file.js:10:5)\n  at the really deep call in the module loader of node today"],
  ["review case 27", "Sure, I will do it. The answer is a number and the result is a list of the items.", "Sure, I will do it. The answer is a number and result is list of items."],
  ["review case 28", "Rename the field to the_name and the table to a_table in the schema for the app.", "Rename field to the_name and table to a_table in schema for app."],
  ["review case 29", "The option a and the option b are the same, so pick the a variant of the plan.", "The option a and option b are same, so pick the a variant of plan."],
  ["review case 30", "A test of the system and a run of the suite should both pass before the merge today.", "A test of system and run of suite should both pass before merge today."],
  ["review case 31", "Write the word \"the\" in the title, and keep the article a in the heading as well.", "Write word \"the\" in title, and keep article a in heading as well."],
  ["review case 32", "Use the 'a' flag, not the the flag, and set the mode to a value in the config file.", "Use the 'a' flag, not the the flag, and set mode to value in config file."],
  ["review case 33", "The key point: we hardly ever deploy on a Friday, and never without a review from the team.", "The key point: we hardly ever deploy on a Friday, and never without review from team."],
  ["review case 34", "It's important to note that the API returns a 404 for the deleted users, not a 410.", "The API returns a 404 for deleted users, not a 410."],
  ["review case 35", "Really, the fix is in the parser and not in the loader of the module system today.", "The fix is in parser and not in loader of module system today."],
  ["review case 36", "The test just passes now, and the build is simply green on the main branch today.", "The test just passes now, and build is green on main branch today."],
  ["review case 37", "Click the Save button, then the Cancel button, and then the OK button on the dialog.", "Click the Save button, then the Cancel button, and then the OK button on dialog."],
  ["review case 38", "Run npm install the-package and then npm test in the root of the repo for the team.", "Run npm install the-package and then npm test in root of repo for team."],
  ["review case 39", "export FOO=the value and then run make all in the root directory of the project today", "export FOO=the value and then run make all in root directory of project today"],
  ['already short and clean', 'Fix the typo.', 'Fix the typo.'],
]

describe('word compression', () => {
  for (const [name, input, output] of WORDS) {
    test(name, () => {
      expect(compressWords(input)).toBe(output)
    })
  }

  test('every output is a fixed point (a second pass changes nothing)', () => {
    for (const [, input] of WORDS) {
      const once = compressWords(input)
      expect(compressWords(once)).toBe(once)
    }
  })

  test('a failure line is never touched', () => {
    const line = 'Error: the build of the thing failed in order to run basically  twice'
    expect(SIGNAL_LINES.test(line)).toBe(true)
    expect(compressWords(`Sure! Let me look at it for you.\n${line}\nLet me fix it for you.`)).toBe(`Sure! Let me look at it for you.\n${line}\nLet me fix it for you.`)
  })

  test('a negation is never lost', () => {
    const negations = ['not', 'never', 'no', 'nor', 'neither', 'none', 'nothing', 'nobody', 'nowhere', 'cannot', 'without', 'only', 'except', 'unless', "don't", "doesn't", "isn't", "can't", "won't", "shouldn't", 'hardly', 'barely']
    const fillers = ['basically', 'actually', 'just', 'really', 'simply', 'Sure!', 'Let me', 'in order to', 'the', 'a', 'Hope this helps!']
    const corpus: string[] = [...WORDS.map(([, input]) => input)]
    for (const n of negations) {
      for (const f of fillers) {
        corpus.push(`Sure! I think we should ${f} ${n} run the build for the user in the repo.`)
        corpus.push(`The team will ${n} ${f} touch the config file, and ${f} ${n} the cache either way.`)
        corpus.push(`Let me say that it is ${f} ${n} a good idea to delete the branch ${f} now. ${f} ${n} so.`)
      }
    }
    expect(corpus.length).toBeGreaterThan(500)
    let changed = 0
    for (const text of corpus) {
      const out = compressWords(text)
      expect(countNegations(out)).toBe(countNegations(text))
      if (out !== text) changed++
    }
    expect(changed).toBeGreaterThan(300)
  })

  test('not-sensitive hedges stay next to a negation', () => {
    expect(compressWords('That is not really the problem here, and it does not simply go away.')).toContain('not really')
    expect(compressWords("It doesn't just fail on the first run of the suite, it fails on every run.")).toContain("doesn't just fail")
  })

  test('markers in the text are left to the caller', () => {
    expect(compressWords('A \u0001 b the \u0002 c the plan is the one to follow in the end.')).toBe('A \u0001 b the \u0002 c the plan is the one to follow in the end.')
  })
})

describe('sentences', () => {
  const prose =
    'I read the config. It sets two flags, one per mode. The first flag is on by default. Next I will run the tests?\n\n- fix the loader in `src/load.ts`\n- tidy up\n\n```ts\nconst a = 1. 2\n```\nFAIL src/a.test.ts: expected 1 received 2\nSee https://example.com/a.b for details. Done.'

  test('the pieces join back to the exact text', () => {
    for (const text of [prose, '', 'one', 'a. B. c. D.\n', 'x\r\ny. Z.']) {
      expect(
        splitSentences(text)
          .map((s) => s.text)
          .join(''),
      ).toBe(text)
    }
  })

  test('code, failure lines, questions, paths and URLs are atomic', () => {
    const segs = splitSentences(prose)
    const atomic = (needle: string) => segs.find((s) => s.text.includes(needle))?.atomic
    expect(atomic('const a = 1. 2')).toBe(true)
    expect(atomic('FAIL src/a.test.ts')).toBe(true)
    expect(atomic('Next I will run the tests?')).toBe(true)
    expect(atomic('src/load.ts')).toBe(true)
    expect(atomic('https://example.com/a.b')).toBe(true)
    expect(atomic('I read the config.')).toBe(false)
    expect(atomic('It sets two flags, one per mode.')).toBe(false)
  })

  test('a full stop inside a path, a URL or an abbreviation does not split', () => {
    const segs = splitSentences('Edit src/a.b.ts then e.g. The thing. Visit https://x.io/a. B and go on.')
    expect(segs.map((s) => s.text)).toEqual(['Edit src/a.b.ts then e.g. The thing. ', 'Visit https://x.io/a. ', 'B and go on.'])
  })

  test('fewer than three sentences ask nothing; short and atomic ones are not asked', () => {
    expect(planSentences('One sentence only. And a second one.').ask).toEqual([])
    const plan = planSentences('I read the config today. Ok. See `a.ts` for it. It sets two flags here.')
    expect(plan.total).toBe(4)
    expect(plan.ask.map((a) => a.text)).toEqual(['I read the config today.', 'It sets two flags here.'])
  })

  test('at most 40 sentences per message are asked', () => {
    const plan = planSentences(Array.from({ length: 60 }, (_, i) => `This is the sentence number ${i} here.`).join(' '))
    expect(plan.total).toBe(60)
    expect(plan.ask.length).toBe(40)
  })

  test('never more than the ratio is dropped, lowest scores first', () => {
    const plan = { total: 10 }
    const scored = Array.from({ length: 10 }, (_, i) => ({ segment: i, p: i / 100 }))
    expect([...pickDrops(plan, scored, 0.35, 0.7)].sort()).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(pickDrops(plan, scored, 0.05, 0.7).size).toBe(5)
    expect(pickDrops(plan, scored, 0.35, 0).size).toBe(0)
    expect(pickDrops({ total: 3 }, scored.slice(0, 3), 0.35, 0.7).size).toBe(2)
    expect(pickDrops({ total: 1 }, scored.slice(0, 1), 0.35, 0.7).size).toBe(0)
  })

  test('dropping keeps the line breaks', () => {
    const segs = splitSentences('Alpha is here today. Beta is there today.\nGamma is next today.\n')
    expect(segs.length).toBe(3)
    expect(dropSegments(segs, new Set([1])).text).toBe('Alpha is here today.\nGamma is next today.\n')
    expect(dropSegments(segs, new Set([0, 2])).text).toBe('Beta is there today.\n')
    expect(sentencesNote(1)).toBe('[… 1 sentence omitted by jev-compaction …]')
    expect(sentencesNote(3)).toBe('[… 3 sentences omitted by jev-compaction …]')
  })
})

describe('long output', () => {
  const body = Array.from({ length: 400 }, (_, i) => `line ${i} of the output with some padding text`).join('\n')

  test('chunks are line-aligned, at most 60, and the first and last stay', () => {
    const chunks = chunkText(body)
    expect(chunks.map((c) => c.text).join('')).toBe(body)
    expect(chunks.length).toBeLessThanOrEqual(60)
    expect(chunks[0]?.forced).toBe(true)
    expect(chunks[chunks.length - 1]?.forced).toBe(true)
    expect(chunks.some((c) => !c.forced)).toBe(true)
  })

  test('dropped runs leave failure lines and one note', () => {
    const text = body.replace('line 200 of', 'ERROR line 200 of')
    const chunks = chunkText(text)
    const out = joinChunks(chunks, chunks.map(() => false))
    expect(out.startsWith('line 0 of')).toBe(true)
    expect(out.endsWith('line 399 of the output with some padding text')).toBe(true)
    expect(out).toContain('ERROR line 200 of')
    expect(out.match(/omitted by jev-compaction/g)?.length).toBe(1)
    expect(out.length).toBeLessThan(text.length / 2)
    expect(joinChunks(chunks, chunks.map(() => true))).toBe(text)
  })
})

describe('word filter safety', () => {
  test('user text: no removals, only articles in plain prose and whitespace', () => {
    const t = 'Sure! Let me know if you can just look at the build in order to fix the thing for the team.'
    expect(compressWords(t, { user: true })).toBe('Sure! Let me know if you can just look at build in order to fix thing for team.')
    expect(compressWords('Please let me run the migration myself, I only want  the script.', { user: true })).toBe('Please let me run migration myself, I only want script.')
  })

  test('let me know if / feel free to go only as a whole sentence, never across a comma or conjunction', () => {
    expect(compressWords('The job ran. Let me know if you have any questions.')).toBe('The job ran.')
    expect(compressWords('Feel free to ask if something is unclear.')).toBe('Feel free to ask if something is unclear.')
    expect(compressWords('The build is green now. Feel free to ask if something is unclear.')).toBe('The build is green now.')
    for (const t of [
      'Let me know if you need anything else, otherwise go ahead and merge the PR now.',
      'Let me know if you have questions and then merge the pull request into the main branch.',
      'Let me know if you have any questions for the infra team before you rotate the key tonight.',
    ]) {
      expect(compressWords(t)).toContain('Let me know if')
      expect(compressWords(t)).toContain(t.split(' ').slice(-2).join(' '))
    }
  })

  test('let me, sure, I would be happy to and just are never removed', () => {
    for (const w of ['let me', 'Sure', "I'd be happy to", 'just']) {
      const t = `You should ${w} review the diff of the work before the team commits it to the branch.`
      expect(compressWords(t)).toContain(w)
    }
  })

  test('nothing becomes empty and CRLF text is left alone', () => {
    for (const t of ['Hope this helps!', 'Thanks for waiting!', 'Great question!', '  \n']) expect(compressWords(t)).toBe(t)
    expect(compressWords('The worker is really just the default one.\r\nThe parser reads the file.\r\n')).toBe('The worker is really just the default one.\r\nThe parser reads the file.\r\n')
  })

  test('English is judged per paragraph and per line', () => {
    const t = 'Der Parser liest die Datei und dann schreibt er die Ausgabe in den Cache.\n\nThe parser reads the file and then it writes the output to the cache for the user.'
    expect(compressWords(t)).toBe('Der Parser liest die Datei und dann schreibt er die Ausgabe in den Cache.\n\nThe parser reads file and then it writes output to cache for user.')
    const mixed = 'Il a un fichier dans le dossier.\nThe parser reads the file and then it writes the output to the cache for the user.'
    expect(compressWords(mixed)).toBe('Il a un fichier dans le dossier.\nThe parser reads file and then it writes output to cache for user.')
  })

  test('a fence closes only on a bare line of the same character and at least the opening length', () => {
    const t = 'Here is the doc for the readme file of the project today:\n````md\nthe intro text of the file is here\n```ts\nthe value is just the default\n```\nthe value is really the default\n````\nThat is the whole file for the team today.'
    const out = compressWords(t)
    expect(out.split('\n').slice(1, 8)).toEqual(t.split('\n').slice(1, 8))
    expect(compressWords('~~~\nthe really odd  code\n```\nthe really odd  code\n~~~\nWe went to the shop to buy the milk for the team.')).toBe('~~~\nthe really odd  code\n```\nthe really odd  code\n~~~\nWe went to shop to buy milk for team.')
  })

  test('diff hunks, shell prompts, key: value lines and stack frames are code', () => {
    for (const t of [
      'Apply this hunk:\n@@ -3,2 +3,2 @@\n-This is the really old text of the README for the user\n+This is the actually new text of the README for the user',
      '$ git checkout -b the fix && git commit -am the actually final tweak to the parser',
      'description: Just a simple tool that is really useful for the team today',
      '"desc": the really basic value for the app that is just fine,',
      '  at the really deep call in the module loader of node today',
      '- the actually important line of the readme is here and it is basically wrong\n+ the really important line of the readme is here and it is simply fixed',
    ]) {
      expect(compressWords(t)).toBe(t)
      expect(splitSentences(t).filter((s) => !s.text.startsWith('Apply')).every((s) => s.atomic)).toBe(true)
    }
  })
})

describe('key: value blocks', () => {
  test('a dash item and an indented block under a key line are code', () => {
    for (const t of [
      '- name: the app\n- description: Just the really basic tool that is useful for the team in the repo today',
      'description: |\n  The tool is really the default one for the team in the repo and it is basically fine today.',
      'items:\n  - the really first item of the list for the team in the repo today\n  - the really second item of the list for the team in the repo today',
      'steps: >\n  Do the really big thing first for the team in the repo today.',
    ]) expect(compressWords(t)).toBe(t)
  })

  test('the block ends where the indentation returns', () => {
    expect(compressWords('items:\n  - the really first item of the list for the team in the repo today\nThe parser reads the file and then it writes the output to the cache for the user.')).toBe('items:\n  - the really first item of the list for the team in the repo today\nThe parser reads file and then it writes output to cache for user.')
  })
})

describe('sentence safety', () => {
  test('one note per run of consecutive cuts, each with its own count', () => {
    const segs = splitSentences('Alpha is here today. Beta is there today. Gamma is next today. Delta is last today. Epsilon ends it today.')
    const note = (n: number) => sentencesNote(n, true)
    expect(dropSegments(segs, new Set([1, 3]), note).text).toBe('Alpha is here today. [… 1 sentence cut on entry …] Gamma is next today. [… 1 sentence cut on entry …] Epsilon ends it today.')
    expect(dropSegments(segs, new Set([1, 2, 4]), note).text).toBe('Alpha is here today. [… 2 sentences cut on entry …] Delta is last today. [… 1 sentence cut on entry …]')
    expect(dropSegments(segs, new Set([1, 2, 4]), note).dropped).toBe(3)
    const lines = splitSentences('- step one is the first one\n- step two is the next one\n- step three is the last one\n')
    expect(dropSegments(lines, new Set([1]), note).text).toBe('- step one is the first one\n[… 1 sentence cut on entry …]\n- step three is the last one\n')
  })

  test('negations, modals and numbered steps are atomic, so never dropped', () => {
    const t = '1. Rename the config key to the new name.\nYou must keep the old key for two releases. The cache may be stale after it. We should bump the version to three. Do not run the migration on prod. Never skip the review step. It is only a draft of the plan.'
    const asked = planSentences(t).ask.map((a) => a.text)
    expect(asked).toEqual(['The cache may be stale after it.'])
  })

  test('the note stands where the first sentence was cut', () => {
    const segs = splitSentences('Alpha is here today. Beta is there today. Gamma is next today. Delta is last today.')
    const out = dropSegments(segs, new Set([1, 2]), (n) => sentencesNote(n, true))
    expect(out.text).toBe('Alpha is here today. [… 2 sentences cut on entry …] Delta is last today.')
    expect(out.dropped).toBe(2)
    expect(sentencesNote(2, true)).not.toContain('jev-compaction')
  })
})
