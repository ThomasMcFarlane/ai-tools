import { createSocket } from 'node:dgram';
import { randomInt } from 'node:crypto';
import { isIP } from 'node:net';
import type { DnsAnswer } from './types.js';

const TYPE_NS = 2;
const CLASS_IN = 1;

export function buildNsQuery(domain: string, id: number): Buffer {
  const labels = domain.replace(/\.$/, '').split('.');
  const parts: Buffer[] = [Buffer.alloc(12)];
  parts[0]?.writeUInt16BE(id, 0);
  parts[0]?.writeUInt16BE(0, 2);
  parts[0]?.writeUInt16BE(1, 4);
  for (const label of labels) {
    const bytes = Buffer.from(label, 'ascii');
    if (bytes.length === 0 || bytes.length > 63) {
      throw new Error(`invalid DNS label in "${domain}"`);
    }
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  const tail = Buffer.alloc(5);
  tail.writeUInt16BE(TYPE_NS, 1);
  tail.writeUInt16BE(CLASS_IN, 3);
  parts.push(tail);
  return Buffer.concat(parts);
}

function readName(buf: Buffer, start: number): { name: string; next: number } {
  const labels: string[] = [];
  let pos = start;
  let next = -1;
  for (let hops = 0; hops < 64; hops += 1) {
    const length = buf[pos];
    if (length === undefined) {
      throw new Error('truncated DNS name');
    }
    if (length === 0) {
      return { name: labels.join('.'), next: next === -1 ? pos + 1 : next };
    }
    if ((length & 0xc0) === 0xc0) {
      const low = buf[pos + 1];
      if (low === undefined) {
        throw new Error('truncated DNS pointer');
      }
      if (next === -1) {
        next = pos + 2;
      }
      pos = ((length & 0x3f) << 8) | low;
      continue;
    }
    labels.push(buf.toString('ascii', pos + 1, pos + 1 + length));
    pos += 1 + length;
  }
  throw new Error('DNS name compression loop');
}

export interface NsReferral {
  rcode: number;
  answers: DnsAnswer[];
  authority: DnsAnswer[];
}

export function parseNsResponse(buf: Buffer): NsReferral {
  if (buf.length < 12) {
    throw new Error('short DNS response');
  }
  const rcode = buf.readUInt16BE(2) & 0x0f;
  const questions = buf.readUInt16BE(4);
  const counts = [buf.readUInt16BE(6), buf.readUInt16BE(8)];
  let pos = 12;
  for (let i = 0; i < questions; i += 1) {
    pos = readName(buf, pos).next + 4;
  }
  const sections: DnsAnswer[][] = [[], []];
  counts.forEach((count, section) => {
    for (let i = 0; i < count; i += 1) {
      const owner = readName(buf, pos);
      const type = buf.readUInt16BE(owner.next);
      const ttl = buf.readUInt32BE(owner.next + 4);
      const length = buf.readUInt16BE(owner.next + 8);
      const dataStart = owner.next + 10;
      if (type === TYPE_NS) {
        sections[section]?.push({ value: readName(buf, dataStart).name, ttl });
      }
      pos = dataStart + length;
    }
  });
  return { rcode, answers: sections[0] ?? [], authority: sections[1] ?? [] };
}

export function referralAnswers(response: NsReferral): DnsAnswer[] {
  return response.answers.length > 0 ? response.answers : response.authority;
}

export interface NsReferralOptions {
  port?: number;
  timeoutMs: number;
}

export function queryNsReferral(
  ip: string,
  domain: string,
  opts: NsReferralOptions,
): Promise<DnsAnswer[]> {
  const family = isIP(ip) === 6 ? 'udp6' : 'udp4';
  const id = randomInt(0, 0x10000);
  const query = buildNsQuery(domain, id);
  return new Promise((resolve, reject) => {
    const socket = createSocket(family);
    const finish = (action: () => void): void => {
      clearTimeout(timer);
      socket.close();
      action();
    };
    const timer = setTimeout(() => {
      finish(() =>
        reject(new Error(`NS referral query via ${ip} timed out after ${opts.timeoutMs}ms`)),
      );
    }, opts.timeoutMs);
    socket.on('error', (error) => finish(() => reject(error)));
    socket.on('message', (message) => {
      if (message.length < 2 || message.readUInt16BE(0) !== id) {
        return;
      }
      finish(() => {
        try {
          const response = parseNsResponse(message);
          if (response.rcode !== 0) {
            reject(new Error(`NS referral query via ${ip} returned rcode ${response.rcode}`));
            return;
          }
          resolve(referralAnswers(response));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    socket.send(query, opts.port ?? 53, ip, (error) => {
      if (error) {
        finish(() => reject(error));
      }
    });
  });
}
