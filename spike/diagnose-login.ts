import { createDecipheriv, createHash } from 'node:crypto';
import { caesarShift, GATE, md5Hex, parseJson, readCredentials, shape } from './akuvox-cloud.ts';

const creds = readCredentials();
const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest();

const shifted = caesarShift(creds.user);
const queries: Record<string, string> = {
  raw: `user=${encodeURIComponent(shifted).replace(/%40/g, '@')}`,
  encoded: `user=${encodeURIComponent(shifted)}`,
};

for (const [variant, userQuery] of Object.entries(queries)) {
  for (const apiVersion of ['6.4', '6.6', '6.8']) {
    const res = await fetch(`${GATE}/login?${userQuery}&passwd=${md5Hex(md5Hex(creds.password))}`, {
      headers: { 'api-version': apiVersion, 'User-Agent': 'VBell/6.61.2 (iPhone; iOS 16.6; Scale/3.00)', 'x-cloud-lang': 'en' },
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.text()).trim();
    const isBase64 = /^[A-Za-z0-9+/=\s]+$/.test(body);
    console.log(`\n== query:${variant} api-version:${apiVersion} HTTP ${res.status} type:${res.headers.get('content-type')} len:${body.length} base64:${isBase64}`);

    const plain = parseJson(body);
    if (plain) {
      console.log('plain JSON', { result: plain.result ?? plain.err_code, message: plain.message, fields: shape(plain.datas ?? plain.data) });
      continue;
    }
    if (!isBase64) {
      console.log('non-JSON, non-base64 head:', body.slice(0, 80).replace(/[A-Za-z0-9]{24,}/g, '<long>'));
      continue;
    }

    const cipher = Buffer.from(body, 'base64');
    console.log(`cipher bytes:${cipher.length} multipleOf16:${cipher.length % 16 === 0}`);
    const keySources = { user: creds.user, lower: creds.user.toLowerCase(), shifted, shiftedLower: caesarShift(creds.user.toLowerCase()) };
    for (const [name, src] of Object.entries(keySources)) {
      for (const [mode, key] of [
        ['aes-256-cbc', Buffer.concat([md5(src), Buffer.from('Akuvox55069013!@')])],
        ['aes-128-cbc', md5(src)],
      ] as const) {
        try {
          const d = createDecipheriv(mode, key, Buffer.from('1234567887654321'));
          const out = Buffer.concat([d.update(cipher), d.final()]).toString('utf8');
          const json = parseJson(out);
          console.log(`  key:${name} ${mode} -> ${json ? 'JSON' : 'decrypted, not JSON'}`, json ? { result: json.result ?? json.err_code, message: json.message, fields: shape(json.datas ?? json.data) } : '');
        } catch {
          console.log(`  key:${name} ${mode} -> bad decrypt`);
        }
      }
    }
  }
}
