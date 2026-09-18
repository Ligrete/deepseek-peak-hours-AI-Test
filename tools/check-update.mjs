/**
 * Тесты обновления данных со страницы тарифов:
 * свежесть/повторы, сохранение в chrome.storage.local, поведение при сбоях
 * (прежние данные не должны теряться) и текст о источнике для popup.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getDataOrigin, getPrices, getSchedule, resetToBundled } from '../src/schedule.js';
import {
  RETRY_INTERVAL_MS,
  STORAGE_KEY,
  describeDataState,
  loadStoredPricing,
  readStoredPricing,
  refreshPricing,
  shouldRefresh,
} from '../src/schedule-update.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureHtml = readFileSync(join(ROOT, 'tools', 'fixtures', 'pricing-page-2026-09-18.html'), 'utf8');

/* --- заглушки chrome.storage и fetch --- */
const storage = new Map();
globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => (storage.has(key) ? { [key]: storage.get(key) } : {}),
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) storage.set(k, v);
      },
    },
  },
};

let fetchCalls = [];
let fetchResponse = () => ({ ok: true, text: async () => fixtureHtml });
globalThis.fetch = async (url, options) => {
  fetchCalls.push({ url, options });
  return fetchResponse();
};

let failures = 0;
let checks = 0;

function check(name, actual, expected) {
  checks += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}\n       получено: ${a}\n       ожидалось: ${e}`);
  }
}

const reset = () => {
  storage.clear();
  fetchCalls = [];
  fetchResponse = () => ({ ok: true, text: async () => fixtureHtml });
  resetToBundled();
};

console.log('shouldRefresh (свежесть данных):');
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
check('нет записи → обновляемся', shouldRefresh(null), true);
check('успех 6 дней назад → ещё свежо', shouldRefresh({ ok: true, attemptedAt: iso(6 * DAY) }), false);
check('успех 8 дней назад → пора', shouldRefresh({ ok: true, attemptedAt: iso(8 * DAY) }), true);
check('ошибка час назад → не долбим', shouldRefresh({ ok: false, attemptedAt: iso(1 * HOUR) }), false);
check('ошибка 13 часов назад → повторяем', shouldRefresh({ ok: false, attemptedAt: iso(13 * HOUR) }), true);
check('мусорная дата → обновляемся', shouldRefresh({ ok: true, attemptedAt: 'не дата' }), true);
check('RETRY меньше недели', RETRY_INTERVAL_MS < 7 * DAY, true);

console.log('Успешное обновление:');
reset();
{
  const now = new Date('2026-09-18T10:17:00Z');
  const result = await refreshPricing({ now });
  check('статус updated', result.status, 'updated');
  check('сходили в сеть один раз', fetchCalls.length, 1);
  check('запрошен верный URL', fetchCalls[0].url.includes('api-docs.deepseek.com/quick_start/pricing'), true);
  check('источник данных — remote', getDataOrigin(), 'remote');
  check('расписание применилось', getSchedule().peakWindowsUtc, [
    { startMinute: 60, endMinute: 240 },
    { startMinute: 360, endMinute: 600 },
  ]);
  check('дата проверки из now', getSchedule().checkedAt, '2026-09-18');
  check('цены применились (2 модели)', getPrices().length, 2);
  check('предупреждений нет', result.stored.warnings, []);
  check('запись сохранена в storage', (await readStoredPricing())?.ok, true);
  check('fetchedAt = attemptedAt', result.stored.fetchedAt, result.stored.attemptedAt);
}

console.log('Свежие данные не перекачиваем:');
{
  const firstCalls = fetchCalls.length;
  const result = await refreshPricing({ now: new Date() });
  check('статус skipped', result.status, 'skipped');
  check('новых запросов в сеть нет', fetchCalls.length, firstCalls);
  const forced = await refreshPricing({ force: true, now: new Date() });
  check('с force — снова updated', forced.status, 'updated');
  check('и запрос ушёл', fetchCalls.length, firstCalls + 1);
}

console.log('Сбой не должен ломать прежние данные:');
reset();
{
  const good = await refreshPricing({ now: new Date('2026-09-18T10:17:00Z') });
  check('сначала успех', good.status, 'updated');

  fetchResponse = () => ({ ok: true, text: async () => '<html><body>страница без расписания</body></html>' });
  const bad = await refreshPricing({ force: true, now: new Date('2026-09-25T10:17:00Z') });
  check('статус failed', bad.status, 'failed');
  check('причина про расписание', /Peak hours/.test(bad.reason || ''), true);
  check('прежнее расписание осталось', getSchedule().checkedAt, '2026-09-18');
  check('прежние цены остались', getPrices().length, 2);
  const stored = await readStoredPricing();
  check('в storage всё ещё ok:true', stored.ok, true);
  check('fetchedAt не переписан', stored.fetchedAt, good.stored.fetchedAt);
  check('attemptedAt обновлён', stored.attemptedAt, '2026-09-25T10:17:00.000Z');
  check('ошибка записана', /Peak hours/.test(stored.lastError || ''), true);
  check(
    'после сбоя повтор только через 12 ч',
    shouldRefresh(stored, Date.parse('2026-09-25T20:00:00Z')),
    false,
  );
}

console.log('HTTP-ошибки:');
reset();
{
  fetchResponse = () => ({ ok: false, status: 500, text: async () => '' });
  const result = await refreshPricing({ force: true });
  check('статус failed', result.status, 'failed');
  check('причина HTTP 500', result.reason, 'HTTP 500');
  check('источник так и остался встроенным', getDataOrigin(), 'bundled');
  check('запись о попытке сохранена', (await readStoredPricing())?.ok, false);
}

console.log('Страница без указания скидки:');
reset();
{
  const html = `<html><body><p>Peak hours are 01:00 - 03:00 UTC, Monday through Friday (all other hours are off-peak).</p></body></html>`;
  fetchResponse = () => ({ ok: true, text: async () => html });
  const result = await refreshPricing({ force: true });
  check('расписание применилось', result.status, 'updated');
  check('окно из страницы', getSchedule().peakWindowsUtc, [{ startMinute: 60, endMinute: 180 }]);
  check('скидка осталась встроенной (50%)', getSchedule().discountPercent, 50);
  check(
    'есть предупреждение про скидку',
    result.stored.warnings.some((w) => w.includes('скидк')),
    true,
  );
  check(
    'и предупреждение про нераспознанные цены (в этой странице нет таблицы)',
    result.stored.warnings.some((w) => w.includes('цены не распознаны')),
    true,
  );
}

console.log('loadStoredPricing и описание источника:');
reset();
{
  check('пустое хранилище → встроенные данные', getDataOrigin(), 'bundled');
  check('describe(null)', describeDataState(null).tone, 'bundled');

  await refreshPricing({ now: new Date('2026-09-18T10:17:00Z') });
  resetToBundled();
  check('после сброса — встроенные', getDataOrigin(), 'bundled');
  await loadStoredPricing();
  check('loadStoredPricing вернул сохранённое расписание', getDataOrigin(), 'remote');
  check('описание показывает источник и дату', describeDataState(await readStoredPricing()).tone, 'remote');
  check(
    'в описании есть цитата со страницы',
    /Peak hours are 01:00/.test(describeDataState(await readStoredPricing()).detail),
    true,
  );

  fetchResponse = () => ({ ok: false, status: 503, text: async () => '' });
  await refreshPricing({ force: true });
  check('при сбое описание окрашено как ошибка', describeDataState(await readStoredPricing()).tone, 'remote');
}

reset();
{
  fetchResponse = () => ({ ok: false, status: 503, text: async () => '' });
  await refreshPricing({ force: true });
  const state = describeDataState(await readStoredPricing());
  check('первая же попытка не удалась → tone error', state.tone, 'error');
  check('текст про файл расширения', /файл\w* расширения/.test(state.text), true);
}

console.log(`\n${checks - failures}/${checks} проверок пройдено`);
process.exit(failures ? 1 : 0);
