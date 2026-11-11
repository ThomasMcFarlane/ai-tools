import { describe, expect, it } from 'vitest';
import { areaMarks } from '../src/core/format.js';
import { buildModel } from '../src/core/model.js';
import { LogBuilder, holdLevel, sampleMap } from './helpers.js';

describe('areaMarks', () => {
  it('does not call a stale area untested', () => {
    const log = new LogBuilder().session();
    holdLevel(log, 'a', 'read');
    log.raise('a');
    const area = buildModel(sampleMap(), log.events).areas.find((a) => a.id === 'a');
    expect(area).toMatchObject({ level: 'none', stale: true, untested: true });
    if (area === undefined) throw new Error('area a missing');
    expect(areaMarks(area)).toBe('stale (was read: Ready to be interviewed on it)');
  });

  it('marks an area with no answers as untested', () => {
    const log = new LogBuilder().session();
    const area = buildModel(sampleMap(), log.events).areas.find((a) => a.id === 'b');
    if (area === undefined) throw new Error('area b missing');
    expect(areaMarks(area)).toBe('untested');
  });
});
