/**
 * Проверка целостности расширения:
 *  1) все пути из manifest.json существуют;
 *  2) service worker запускается с заглушкой chrome.* и ставит правильную иконку/бейдж.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isPeak } from '../src/schedule.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;

function check(name, ok, extra = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !extra ? '' : ` → ${extra}`}`);
}

/* --- manifest --- */
const manifestPath = join(ROOT, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

check('manifest_version = 3', manifest.manifest_version === 3);
check('есть разрешение alarms', manifest.permissions?.includes('alarms'));
check('service worker объявлен как module', manifest.background?.type === 'module');

const referenced = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...Object.values(manifest.action?.default_icon || {}),
  ...Object.values(manifest.icons || {}),
].filter(Boolean);

for (const rel of [...new Set(referenced)]) {
  check(`файл существует: ${rel}`, existsSync(join(ROOT, rel)));
}

const popupHtml = readFileSync(join(ROOT, manifest.action.default_popup), 'utf8');
for (const rel of [...popupHtml.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])) {
  if (rel.startsWith('http')) continue;
  check(`файл popup существует: ${rel}`, existsSync(join(ROOT, 'src', rel)));
}

// Все id, к которым обращается popup.js, должны существовать в разметке.
const popupJs = readFileSync(join(ROOT, 'src', 'popup.js'), 'utf8');
const htmlIds = new Set([...popupHtml.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
for (const id of [...popupJs.matchAll(/\$\('#([^']+)'\)/g)].map((m) => m[1])) {
  check(`id из popup.js есть в HTML: #${id}`, htmlIds.has(id));
}

/* --- service worker с заглушкой chrome.* --- */
const calls = { setIcon: [], setBadgeText: [], setBadgeBackgroundColor: [], setTitle: [] };
const alarms = [];
const listeners = { alarm: [], installed: [], startup: [], message: [] };

globalThis.chrome = {
  alarms: {
    create: (name, options) => alarms.push({ name, options }),
    onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
  },
  action: {
    setIcon: async (o) => calls.setIcon.push(o.path),
    setBadgeText: async (o) => calls.setBadgeText.push(o.text),
    setBadgeBackgroundColor: async (o) => calls.setBadgeBackgroundColor.push(o.color),
    setBadgeTextColor: async () => {},
    setTitle: async (o) => calls.setTitle.push(o.title),
  },
  runtime: {
    onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
    onStartup: { addListener: (fn) => listeners.startup.push(fn) },
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
  },
};

await import('../src/background.js');
await new Promise((resolve) => setTimeout(resolve, 80));

const peak = isPeak(new Date());
const expectedState = peak ? 'peak' : 'off';

check('создан минутный alarm', alarms.some((a) => a.options?.periodInMinutes === 1));
check('зарегистрированы onInstalled/onStartup/onAlarm', [
  listeners.installed.length,
  listeners.startup.length,
  listeners.alarm.length,
].every((n) => n === 1));
check(`иконка соответствует статусу (${expectedState})`, calls.setIcon.at(-1)?.[16]?.includes(`icon-${expectedState}-16.png`) === true, JSON.stringify(calls.setIcon.at(-1)));
check(
  'цвет бейджа соответствует статусу',
  calls.setBadgeBackgroundColor.at(-1) === (peak ? '#EF4444' : '#22C55E'),
  calls.setBadgeBackgroundColor.at(-1),
);
check('текст бейджа PEAK/OFF', calls.setBadgeText.at(-1) === (peak ? 'PEAK' : 'OFF'), calls.setBadgeText.at(-1));
check('заголовок описывает тариф', /DeepSeek API/.test(calls.setTitle.at(-1) || ''), calls.setTitle.at(-1));

for (const path of calls.setIcon.at(-1) ? Object.values(calls.setIcon.at(-1)) : []) {
  check(`иконка существует: ${path}`, existsSync(join(ROOT, path)));
}

console.log(failures ? `\n${failures} проверок не прошло` : '\nРасширение собрано корректно');
process.exit(failures ? 1 : 0);
