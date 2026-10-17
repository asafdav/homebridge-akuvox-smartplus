import { caesarShift, GATE, md5Hex, parseJson, readCredentials, shape } from './akuvox-cloud.ts';

const { user, password } = readCredentials();
const shiftDigits = (s: string) => s.replace(/[0-9]/g, (d) => String((Number(d) + 3) % 10));
const variants: Array<[string, string, string]> = [
  ['user raw, md5(md5)', user, md5Hex(md5Hex(password))],
  ['user digit-shift, md5(md5)', shiftDigits(user), md5Hex(md5Hex(password))],
  ['user full-shift, md5', caesarShift(user), md5Hex(password)],
  ['user full-shift, MD5(MD5) upper', caesarShift(user), md5Hex(md5Hex(password).toUpperCase()).toUpperCase()],
];
const seen = new Set<string>();
for (const [name, u, p] of variants) {
  if (seen.has(u + p)) { console.log(`skip ${name} (same request as an earlier variant)`); continue; }
  seen.add(u + p);
  const res = await fetch(`${GATE}/login?user=${encodeURIComponent(u)}&passwd=${p}`, {
    headers: { 'api-version': '6.6', 'User-Agent': 'VBell/6.61.2 (iPhone; iOS 16.6; Scale/3.00)', 'x-cloud-lang': 'en' },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.text();
  const json = parseJson(body);
  const ok = json && (json.result === 0 || json.err_code === '0');
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}:`, json ? { result: json.result ?? json.err_code, message: json.message, fields: shape(json.datas ?? json.data) } : `non-JSON len ${body.length}`);
  if (ok) break;
}
