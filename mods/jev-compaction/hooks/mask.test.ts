import { describe, expect, test } from 'claude-code/testing'

import { buildRequest } from './jev'
import { maskDeep, maskSecrets } from './mask'

// Secret-shaped fixtures are assembled at runtime so no literal matches a real token format.
const S = { SKL: ['sk', 'live', ''].join('_'), SKT: ['sk', 'test', ''].join('_'), RKL: ['rk', 'live', ''].join('_'), GHP: ['gh', 'p_'].join(''), PAT: ['github', 'pat', ''].join('_'), GLP: ['glp', 'at-'].join(''), XOX: ['xo', 'xb-'].join(''), AIZ: ['AI', 'za'].join(''), AKI: ['AK', 'IA'].join(''), NPM: ['np', 'm_'].join(''), HF: ['h', 'f_'].join(''), JWT: ['ey', 'J'].join(''), PEM: ['-----BE', 'GIN'].join('') }

const SECRETS: [string, string][] = [
  ['env assignment', 'export API_KEY=abc123def456ghi789'],
  ['token assignment', 'GITHUB_TOKEN="s3cr3t-value-here"'],
  ['password in json', '{"db_password": "hunter2hunter2"}'],
  ['secret with colon', 'client_secret: 9f8e7d6c5b4a'],
  ['bearer', 'curl -H "Authorization: Bearer abcdef1234567890abcdef" https://x.io'],
  ['jwt', `token ${S.JWT}hbGciOiJIUzI1NiJ9.${S.JWT}zdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk here`],
  ['openai style', 'key sk-proj-AbCdEfGhIjKlMnOpQrStUv here'],
  ['github token', `use ${S.GHP}abcdefghijklmnopqrstuvwxyz0123456789 now`],
  ['fine grained github token', `use ${S.PAT}11ABCDEFG0abcdefghijklmnopqrst now`],
  ['aws key id', `${S.AKI}IOSFODNN7EXAMPLE is the id`],
  ['pem block', `${S.PEM} RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234567890abcdef\n-----END RSA PRIVATE KEY-----`],
  ['pem begin only', `head ${S.PEM} OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk`],
  ['k8s secret', 'apiVersion: v1\nkind: Secret\ndata:\n  tls.crt: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSUJrVENDQVRlZ0F3SUJBZ0lVQ'],
  ['url credentials', 'DATABASE_URL=postgres://admin:hunter2pass@db.internal:5432/app'],
  ['basic auth', 'Authorization: Basic dXNlcjpodW50ZXIycGFzcw=='],
  ['cookie', 'Cookie: session=8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c'],
  ['set-cookie', 'Set-Cookie: sid=8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c; HttpOnly'],
  ['stripe live', `STRIPE=${S.SKL}51HxYzAbCdEfGhIjKlMnOpQr`],
  ['stripe test', `use ${S.SKT}51HxYzAbCdEfGhIjKlMnOpQr`],
  ['restricted stripe', `use ${S.RKL}51HxYzAbCdEfGhIjKlMnOpQr`],
  ['google api key', `${S.AIZ}SyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvW`],
  ['gitlab', `${S.GLP}AbCdEfGhIjKlMnOpQrSt`],
  ['npm', `${S.NPM}AbCdEfGhIjKlMnOpQrStUvWxYz0123456789`],
  ['hugging face', `${S.HF}AbCdEfGhIjKlMnOpQrStUvWxYz012345`],
  ['slack bot', `${S.XOX}1234567890-abcdefghij`],
  ['pwd name', 'MYSQL_PWD=hunter2'],
  ['pass name', 'export PASS=hunter2'],
  ['password flag', 'run --password hunter2'],
  ['password flag equals', 'run --password=hunter2'],
  ['mysql flag', 'mysql -u root -phunter2'],
  ['quoted password with spaces', 'password = "hunter 2 with spaces"'],
  ['curl user', 'curl -u admin:hunter2 https://x'],
  ['yaml password', '  password: aHVudGVyMg=='],
  ['aws secret', 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
  ['pass name bare', 'pass=hunter2'],
  ['name ending in pass', 'DBPASS=hunter2'],
  ['lower name ending in pass', 'adminpass=hunter2'],
  ['json pass', '{"pass":"hunter2"}'],
  ['blob in a path', 'GET /api/v1/reset/a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u'],
  ['blob in a webhook url', 'https://hooks.example.com/services/a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u'],
  ['blob before a full stop', 'token a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u.'],
  ['blob after a dot', 'secret.a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u'],
  ['blob in a bot url', 'https://api.telegram.org/bot123456:a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u/getMe'],
  ['blob in a query', 'https://x.io/?sig=a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u'],
  ['standalone base64 blob', 'the value is Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1ub3A= end'],
]
const LEAKS = ['a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u', 'hunter2', 'hunter 2', 'dXNlcjpodW50ZXIycGFzcw', '8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c', '51HxYzAbCdEfGhIjKlMnOpQr', 'A1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvW', 'AbCdEfGhIjKlMnOpQrSt', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', '1234567890-abcdefghij', 'wJalrXUtnFEMI', 'Zm9vYmFyYmF6cXV4MTIzNDU2', 'abc123def456ghi789', 's3cr3t-value-here', 'hunter2hunter2', '9f8e7d6c5b4a', 'abcdef1234567890abcdef', 'dBjftJeZ4CVPmB92K27uhbUJU1p1r', 'AbCdEfGhIjKlMnOpQrStUv', 'abcdefghijklmnopqrstuvwxyz0123456789', '11ABCDEFG0abcdefghijklmnopqrst', `${S.AKI}IOSFODNN7EXAMPLE`, 'MIIEowIBAAKCAQEA', 'b3BlbnNzaC1rZXk', 'LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSUJrVENDQVRlZ0F3']

describe('secret masking', () => {
  for (const [name, input] of SECRETS) {
    test(name, () => {
      const out = maskSecrets(input)
      expect(out).toContain('***')
      for (const leak of LEAKS) expect(out).not.toContain(leak)
    })
  }

  test('ordinary text is unchanged', () => {
    const t = 'The parser reads the file in src/a.ts and writes the output; 12 tests passed: all green; passed: 5; run `npm test` and see https://example.com/a and /home/user/projects/app/src/components/forms/index.ts today.'
    expect(maskSecrets(t)).toBe(t)
  })

  test('every string in the state and questions of a Jev request is masked', () => {
    const request = buildRequest('k', 'm', { history: [{ i: 0, text: 'PASSWORD=hunter2hunter2' }], goal: `use ${S.AKI}IOSFODNN7EXAMPLE` }, { q: { type: 'noul', instructions: 'Bearer abcdef1234567890abcdef' } })
    expect(request.body).not.toMatch(/hunter2hunter2|IOSFODNN7EXAMPLE|abcdef1234567890abcdef/)
    expect(request.headers.authorization).toBe('Bearer k')
    expect(maskDeep({ a: [1, 'x', { b: 'API_KEY=zzzzzzzz' }] })).toEqual({ a: [1, 'x', { b: 'API_KEY=***' }] })
  })
})
