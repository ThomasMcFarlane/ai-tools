import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireHook, summarizeEvent, type HookEvent } from '../src/index.js';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'ai-tools-hooks-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function sampleEvent(): HookEvent {
  return { watch: 'example-watch', summary: 'something changed', values: ['192.0.2.1'] };
}

interface CapturedInvocation {
  stdin: string;
  event: string;
  summary: string;
  extra: string;
}

function startWebhookServer(status: number): Promise<{ server: Server; url: string; bodies: string[] }> {
  return new Promise((resolve) => {
    const bodies: string[] = [];
    const server = createServer((request, response) => {
      let data = '';
      request.on('data', (chunk: string) => {
        data += chunk;
      });
      request.on('end', () => {
        bodies.push(data);
        response.statusCode = status;
        response.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/hook`, bodies });
    });
  });
}

describe('summarizeEvent', () => {
  it('uses the summary property when present', () => {
    expect(summarizeEvent(sampleEvent())).toBe('something changed');
  });

  it('falls back to compact one-line JSON without a summary', () => {
    const event = { watch: 'example-watch', values: ['192.0.2.1'] };
    expect(summarizeEvent(event)).toBe(JSON.stringify(event));
  });
});

describe('fireHook', () => {
  it('none hook succeeds without side effects', async () => {
    const result = await fireHook({ kind: 'none' }, sampleEvent());
    expect(result).toEqual({ ok: true });
  });

  it('exec hook receives the event on stdin and through environment variables', async () => {
    const capturedPath = join(workDir, 'captured.json');
    const command =
      "node -e 'let data=\"\";process.stdin.on(\"data\",(c)=>{data+=c;});process.stdin.on(\"end\",()=>{require(\"node:fs\").writeFileSync(process.env[\"OUT_PATH\"],JSON.stringify({stdin:data,event:process.env[\"EVENT\"],summary:process.env[\"EVENT_SUMMARY\"],extra:process.env[\"MY_EXTRA\"]}));});'";
    const result = await fireHook({ kind: 'exec', command }, sampleEvent(), {
      envExtras: { OUT_PATH: capturedPath, MY_EXTRA: 'hello' },
    });
    expect(result).toEqual({ ok: true });
    const captured = JSON.parse(await readFile(capturedPath, 'utf8')) as CapturedInvocation;
    expect(JSON.parse(captured.stdin)).toEqual(sampleEvent());
    expect(captured.event).toBe(JSON.stringify(sampleEvent()));
    expect(captured.summary).toBe('something changed');
    expect(captured.extra).toBe('hello');
  });

  it('exec hook exposes a compact JSON summary when the event has none', async () => {
    const event = { watch: 'plain', values: ['a'] };
    const command =
      'node -e \'if (process.env["EVENT_SUMMARY"] === JSON.stringify({watch:"plain",values:["a"]})) { process.exit(0); } process.exit(1);\'';
    const result = await fireHook({ kind: 'exec', command }, event);
    expect(result).toEqual({ ok: true });
  });

  it('exec hook reports failure for a non-zero exit', async () => {
    const result = await fireHook(
      { kind: 'exec', command: 'cat > /dev/null && echo boom >&2 && exit 3' },
      sampleEvent(),
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('3');
    expect(result.detail).toContain('boom');
  });

  it('file hook appends the event as a JSON line', async () => {
    const path = join(workDir, 'events', 'hook.jsonl');
    const result = await fireHook({ kind: 'file', path }, sampleEvent());
    expect(result).toEqual({ ok: true });
    const raw = await readFile(path, 'utf8');
    const lines = raw.split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toEqual(sampleEvent());
  });

  it('webhook hook posts the event as JSON and succeeds on 2xx', async () => {
    const { server, url, bodies } = await startWebhookServer(200);
    try {
      const result = await fireHook({ kind: 'webhook', url }, sampleEvent());
      expect(result).toEqual({ ok: true });
      expect(bodies).toHaveLength(1);
      expect(JSON.parse(bodies[0] ?? '{}')).toEqual(sampleEvent());
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it('webhook hook reports failure for non-2xx responses', async () => {
    const { server, url } = await startWebhookServer(500);
    try {
      const result = await fireHook({ kind: 'webhook', url }, sampleEvent());
      expect(result.ok).toBe(false);
      expect(result.detail).toContain('500');
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
