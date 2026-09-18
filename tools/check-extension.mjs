/**
 * Интеграционная проверка расширения:
 *  1) манифест: права, host_permissions, все объявленные и импортируемые файлы существуют;
 *  2) service worker запускается с заглушками chrome.* и реальной фикстурой страницы тарифов:
 *     скачивает данные, ставит правильную иконку/бейдж и планирует пробуждения.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isPeak, nextTransition } from '../src/schedule.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureHtml = readFileSync(join(ROOT, 'tools', 'fixtures', 'pricing-page-2026-09-18.html'), 'utf8');

let failures = 0;
let checks = 0;

function check(name, ok, extra = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !extra ? '' : ` → ${extra}`}`);
}

/* --- 1. Манифест и файлы --- */
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
check('manifest_version = 3', manifest.manifest_version === 3);
check(
  'разрешения alarms + storage',
  ['alarms', 'storage'].every((p) => manifest.permissions?.includes(p)),
  JSON.stringify(manifest.permissions),
);
check(
  'host_permissions только для api-docs.deepseek.com',
  JSON.stringify(manifest.host_permissions) === JSON.stringify(['https://api-docs.deepseek.com/*']),
  JSON.stringify(manifest.host_permissions),
);
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

// Каждый относительный импорт в src/ должен указывать на существующий файл.
const srcDir = join(ROOT, 'src');
for (const file of readdirSync(srcDir).filter((f) => f.endsWith('.js'))) {
  const code = readFileSync(join(srcDir, file), 'utf8');
  for (const spec of [...code.matchAll(/from\s+'(\.[^']+)'/g)].map((m) => m[1])) {
    check(`импорт в ${file} существует: ${spec}`, existsSync(resolve(srcDir, spec)));
  }
}

const popupHtml = readFileSync(join(ROOT, manifest.action.default_popup), 'utf8');
for (const rel of [...popupHtml.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])) {
  if (rel.startsWith('http')) continue;
  check(`файл popup существует: ${rel}`, existsSync(join(ROOT, 'src', rel)));
}
const popupJs = readFileSync(join(ROOT, 'src', 'popup.js'), 'utf8');
const htmlIds = new Set([...popupHtml.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
for (const id of new Set([...popupJs.matchAll(/\$\('#([^']+)'\)/g)].map((m) => m[1]))) {
  check(`id из popup.js есть в HTML: #${id}`, htmlIds.has(id));
}

/* --- 2. Service worker --- */
const calls = { setIcon: [], setBadgeText: [], setBadgeBackgroundColor: [], setTitle: [] };
const alarms = [];
const listeners = { alarm: [], installed: [], startup: [], message: [] };
const storage = new Map();
let fetchCount = 0;

globalThis.chrome = {
  alarms: {
    create: (name, options) => alarms.push({ name, options }),
    // Как в Chrome: get возвращает уже созданный alarm (или undefined).
    get: async (name) => alarms.filter((a) => a.name === name).at(-1),
    onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
  },
  action: {
    setIcon: async (o) => calls.setIcon.push(o.path),
    setBadgeText: async (o) => calls.setBadgeText.push(o.text),
    setBadgeBackgroundColor: async (o) => calls.setBadgeBackgroundColor.push(o.color),
    setBadgeTextColor: async () => {},
    setTitle: async (o) => calls.setTitle.push(o.title),
  },
  storage: {
    local: {
      get: async (key) => (storage.has(key) ? { [key]: storage.get(key) } : {}),
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) storage.set(k, v);
      },
    },
  },
  runtime: {
    onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
    onStartup: { addListener: (fn) => listeners.startup.push(fn) },
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
  },
};

globalThis.fetch = async (url) => {
  if (String(url).includes('api-docs.deepseek.com')) {
    fetchCount += 1;
    return { ok: true, status: 200, text: async () => fixtureHtml };
  }
  return { ok: false, status: 404, text: async () => '' };
};

globalThis.OffscreenCanvas = class {
  constructor(width, height) {
    this.width = width;
    this.height = height;
  }

  getContext() {
    return {
      drawImage() {},
      getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    };
  }
};
globalThis.createImageBitmap = async () => ({ close() {} });

await import('../src/background.js');
await new Promise((done) => setTimeout(done, 400));

const now = new Date();
const expectedState = isPeak(now) ? 'peak' : 'off';

check(
  'зарегистрированы onInstalled/onStartup/onAlarm',
  [listeners.installed.length, listeners.startup.length, listeners.alarm.length].every((n) => n === 1),
);

const transitionAlarm = alarms.filter((a) => a.name === 'deepseek-peak-transition').at(-1);
const updateAlarm = alarms.filter((a) => a.name === 'deepseek-pricing-update').at(-1);
check('есть alarm на смену тарифа', Boolean(transitionAlarm), JSON.stringify(alarms.map((a) => a.name)));
check(
  'alarm смены — одноразовый и ровно на момент смены (+1 с)',
  typeof transitionAlarm?.options?.when === 'number' &&
    transitionAlarm.options.when === nextTransition(new Date()).at.getTime() + 1000,
  JSON.stringify(transitionAlarm?.options),
);
check(
  'недельный alarm обновления тарифов',
  updateAlarm?.options?.periodInMinutes === 7 * 24 * 60,
  JSON.stringify(updateAlarm?.options),
);
check(
  'регресс: нет минутного периодического alarm (воркер не будится 1440 раз в сутки)',
  alarms.every((a) => a.options?.periodInMinutes !== 1),
  JSON.stringify(alarms.map((a) => a.options)),
);

check(
  `иконка соответствует статусу (${expectedState})`,
  calls.setIcon.at(-1)?.[16]?.includes(`icon-${expectedState}-16.png`) === true,
  JSON.stringify(calls.setIcon.at(-1)),
);
check(
  'цвет бейджа соответствует статусу',
  calls.setBadgeBackgroundColor.at(-1) === (isPeak(now) ? '#EF4444' : '#22C55E'),
  calls.setBadgeBackgroundColor.at(-1),
);
check('текст бейджа PEAK/OFF', calls.setBadgeText.at(-1) === (isPeak(now) ? 'PEAK' : 'OFF'), calls.setBadgeText.at(-1));
check('заголовок описывает тариф', /DeepSeek API/.test(calls.setTitle.at(-1) || ''), calls.setTitle.at(-1));

const stored = storage.get('deepseekPeakHours.pricing');
check('данные со страницы тарифов скачаны и сохранены', stored?.ok === true, JSON.stringify(stored?.lastError));
check(
  'расписание из хранилища: 2 окна',
  stored?.schedule?.peakWindowsUtc?.length === 2,
  JSON.stringify(stored?.schedule?.peakWindowsUtc),
);
check('дни из хранилища: Пн–Пт', JSON.stringify(stored?.schedule?.peakWeekdaysUtc), JSON.stringify([1, 2, 3, 4, 5]));
check('цены разобраны (2 модели)', stored?.prices?.length === 2, JSON.stringify(stored?.prices?.length));
check('сходили в сеть ровно один раз', fetchCount, 1);

// Повторное пробуждение по недельному alarm не должно тянуть сеть: данные свежие.
listeners.alarm[0]({ name: 'deepseek-pricing-update' });
await new Promise((done) => setTimeout(done, 200));
check('свежие данные повторно не скачиваются', fetchCount, 1, String(fetchCount));

// Повторная инициализация (onInstalled) не должна сбрасывать недельный цикл.
const updateAlarmsBefore = alarms.filter((a) => a.name === 'deepseek-pricing-update').length;
const transitionAlarmsBefore = alarms.filter((a) => a.name === 'deepseek-peak-transition').length;
listeners.installed[0]();
await new Promise((done) => setTimeout(done, 300));
check(
  'недельный alarm не пересоздаётся при повторном bootstrap',
  alarms.filter((a) => a.name === 'deepseek-pricing-update').length === updateAlarmsBefore,
  `${updateAlarmsBefore} → ${alarms.filter((a) => a.name === 'deepseek-pricing-update').length}`,
);
check(
  'alarm смены тарифа перепланируется',
  alarms.filter((a) => a.name === 'deepseek-peak-transition').length === transitionAlarmsBefore + 1,
);

console.log(`\n${checks - failures}/${checks} проверок пройдено`);
process.exit(failures ? 1 : 0);
