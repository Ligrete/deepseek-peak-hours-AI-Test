/**
 * Тесты парсера страницы тарифов DeepSeek.
 * Основная проверка идёт на сохранённой копии реальной страницы,
 * остальные — на вариациях формулировок и на «сломанных» данных.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { htmlToText, parsePrices, parsePricingPage, parseSchedule } from '../src/parse-pricing.js';
import {
  applyRemoteData,
  getSchedule,
  isPlausibleSchedule,
  resetToBundled,
} from '../src/schedule.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'tools', 'fixtures', 'pricing-page-2026-09-18.html');
const fixtureHtml = readFileSync(FIXTURE, 'utf8');

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

function sentence(text) {
  return `Off-peak rates are half of the peak rates. ${text} Deduction Rules.`;
}

console.log('Реальная страница (фикстура 2026-09-18):');
const parsed = parsePricingPage(fixtureHtml);
check('расписание распознано', parsed.schedule.ok, true);
check(
  'окна UTC: 01:00–04:00 и 06:00–10:00',
  parsed.schedule.data.peakWindowsUtc,
  [
    { startMinute: 60, endMinute: 240 },
    { startMinute: 360, endMinute: 600 },
  ],
);
check('дни недели: Пн–Пт', parsed.schedule.data.peakWeekdaysUtc, [1, 2, 3, 4, 5]);
check('скидка 50%', parsed.schedule.data.discountPercent, 50);
check('цены распознаны', parsed.prices.ok, true);
check(
  'модели и метрики цен',
  parsed.prices.models.map((m) => [
    m.id,
    m.metrics.map((x) => [x.id, x.offPeak, x.peak]),
  ]),
  [
    [
      'deepseek-flash',
      [
        ['cacheHit', 0.003, 0.006],
        ['cacheMiss', 0.15, 0.3],
        ['output', 0.6, 1.2],
      ],
    ],
    [
      'deepseek-v4-pro',
      [
        ['cacheHit', 0.022, 0.044],
        ['cacheMiss', 0.66, 1.32],
        ['output', 1.98, 3.96],
      ],
    ],
  ],
);
check('предупреждений нет', parsed.warnings, []);

console.log('Разбор HTML:');
check(
  'вырезаются script/style, декодируются сущности, убирается zero-width',
  htmlToText('<p>A &amp; B</p><script>var x = "10:00 - 11:00";</script><span>1&nbsp;&#8203;2</span>'),
  'A & B 1 2',
);

console.log('Вариации формулировок:');
check(
  'среднее тире и «Monday to Friday»',
  (() => {
    const r = parseSchedule(sentence('Peak hours are 02:00 – 05:00 UTC, Monday to Friday (all other hours are off-peak).'));
    return [r.ok, r.data.peakWindowsUtc, r.data.peakWeekdaysUtc];
  })(),
  [true, [{ startMinute: 120, endMinute: 300 }], [1, 2, 3, 4, 5]],
);
check(
  'перечисление дней: Monday, Wednesday and Friday',
  (() => {
    const r = parseSchedule(sentence('Peak hours are 09:00 - 11:00 UTC on Monday, Wednesday and Friday (all other hours are off-peak).'));
    return [r.ok, r.data.peakWeekdaysUtc];
  })(),
  [true, [1, 3, 5]],
);
check(
  'диапазон выходных Saturday through Sunday',
  (() => {
    const r = parseSchedule(sentence('Peak hours are 00:00 - 02:00 UTC, Saturday through Sunday (all other hours are off-peak).'));
    return [r.ok, r.data.peakWeekdaysUtc];
  })(),
  [true, [6, 0]],
);
check(
  'скидка 75%',
  (() => {
    const r = parseSchedule('Off-peak rates are 75% lower. Peak hours are 01:00 - 03:00 UTC, Monday through Friday (all other hours are off-peak).');
    return [r.ok, r.data.discountPercent];
  })(),
  [true, 75],
);
check(
  'без фразы о скидке discountPercent = null (но расписание применяется)',
  (() => {
    const r = parseSchedule('Peak hours are 01:00 - 03:00 UTC, Monday through Friday (all other hours are off-peak).');
    return [r.ok, r.data.discountPercent];
  })(),
  [true, null],
);
check(
  '«weekdays» без перечисления дней',
  (() => {
    const r = parseSchedule(sentence('Peak hours are 01:00 - 03:00 UTC on weekdays (all other hours are off-peak).'));
    return [r.ok, r.data.peakWeekdaysUtc];
  })(),
  [true, [1, 2, 3, 4, 5]],
);
check(
  'лишние интервалы вне фразы не подхватываются',
  (() => {
    const r = parseSchedule('See 22:00 - 23:30 somewhere else. Peak hours are 01:00 - 03:00 UTC, Monday through Friday (all other hours are off-peak).');
    return [r.ok, r.data.peakWindowsUtc];
  })(),
  [true, [{ startMinute: 60, endMinute: 180 }]],
);
check(
  'несколько окон в одном предложении',
  (() => {
    const r = parseSchedule(sentence('Peak hours are 01:00 - 03:00, 07:30 - 09:00 UTC, Monday through Friday (all other hours are off-peak).'));
    return [r.ok, r.data.peakWindowsUtc];
  })(),
  [
    true,
    [
      { startMinute: 60, endMinute: 180 },
      { startMinute: 450, endMinute: 540 },
    ],
  ],
);

console.log('Отказы (данные не должны применяться):');
check(
  'нет фразы про peak hours',
  (() => {
    const r = parseSchedule('Мы просто текст без расписания.');
    return [r.ok, /Peak hours/.test(r.reason || '')];
  })(),
  [false, true],
);
check(
  'часовой пояс не UTC',
  (() => {
    const r = parseSchedule(sentence('Peak hours are 01:00 - 03:00 CET, Monday through Friday (all other hours are off-peak).'));
    return [r.ok, /UTC/.test(r.reason || '')];
  })(),
  [false, true],
);
check(
  'битый интервал (начало позже конца)',
  (() => {
    const r = parseSchedule(sentence('Peak hours are 05:00 - 02:00 UTC, Monday through Friday (all other hours are off-peak).'));
    return r.ok;
  })(),
  false,
);
check(
  'нет дней недели',
  (() => {
    const r = parseSchedule(sentence('Peak hours are 01:00 - 03:00 UTC (all other hours are off-peak).'));
    return r.ok;
  })(),
  false,
);

const priceTable = (rows) => `<html><body><table>${rows}</table></body></html>`;
const headerRow = '<tr><td>MODEL</td><td>deepseek-flash</td><td>deepseek-v4-pro</td></tr>';
const goodRows = `
  ${headerRow}
  <tr><td>PRICING</td><td>1M INPUT TOKENS<br>(CACHE HIT)</td><td>OFF-PEAK</td><td>$0.003</td><td>$0.022</td></tr>
  <tr><td>PEAK</td><td>$0.006</td><td>$0.044</td></tr>
  <tr><td>1M INPUT TOKENS<br>(CACHE MISS)</td><td>OFF-PEAK</td><td>$0.15</td><td>$0.66</td></tr>
  <tr><td>PEAK</td><td>$0.3</td><td>$1.32</td></tr>
  <tr><td>1M OUTPUT TOKENS</td><td>OFF-PEAK</td><td>$0.6</td><td>$1.98</td></tr>
  <tr><td>PEAK</td><td>$1.2</td><td>$3.96</td></tr>`;

check('цены: корректная таблица', parsePrices(priceTable(goodRows)).ok, true);
check(
  'цены: нет таблицы',
  parsePrices('<html><body>нет таблиц</body></html>').ok,
  false,
);
check(
  'цены: число цен не совпало с числом моделей',
  (() => {
    const r = parsePrices(
      priceTable(`${headerRow}
        <tr><td>1M OUTPUT TOKENS</td><td>OFF-PEAK</td><td>$0.6</td><td>$1.98</td><td>$9.99</td></tr>
        <tr><td>PEAK</td><td>$1.2</td><td>$3.96</td><td>$9.99</td></tr>`),
    );
    return [r.ok, /не совпало/.test(r.reason || '')];
  })(),
  [false, true],
);
check(
  'цены: пик не дороже офф-пика → отказ',
  (() => {
    const r = parsePrices(
      priceTable(`${headerRow}
        <tr><td>1M INPUT TOKENS (CACHE HIT)</td><td>OFF-PEAK</td><td>$0.5</td><td>$0.022</td></tr>
        <tr><td>PEAK</td><td>$0.5</td><td>$0.044</td></tr>
        <tr><td>1M INPUT TOKENS (CACHE MISS)</td><td>OFF-PEAK</td><td>$0.15</td><td>$0.66</td></tr>
        <tr><td>PEAK</td><td>$0.3</td><td>$1.32</td></tr>
        <tr><td>1M OUTPUT TOKENS</td><td>OFF-PEAK</td><td>$0.6</td><td>$1.98</td></tr>
        <tr><td>PEAK</td><td>$1.2</td><td>$3.96</td></tr>`),
    );
    return [r.ok, /неправдоподобная цена/.test(r.reason || '')];
  })(),
  [false, true],
);
check(
  'цены: не хватает метрики → отказ',
  (() => {
    const r = parsePrices(
      priceTable(`${headerRow}
        <tr><td>1M OUTPUT TOKENS</td><td>OFF-PEAK</td><td>$0.6</td><td>$1.98</td></tr>
        <tr><td>PEAK</td><td>$1.2</td><td>$3.96</td></tr>`),
    );
    return [r.ok, /нет метрик/.test(r.reason || '')];
  })(),
  [false, true],
);

console.log('Сводный разбор:');
check(
  'битые цены не мешают расписанию, но дают предупреждение',
  (() => {
    const r = parsePricingPage(`<html><body><p>${sentence('Peak hours are 01:00 - 03:00 UTC, Monday through Friday (all other hours are off-peak).')}</p></body></html>`);
    return [r.schedule.ok, r.prices.ok, r.warnings.length];
  })(),
  [true, false, 1],
);

console.log('Контракт «парсер → слой расписания»:');
check(
  'данные парсера реальной страницы принимаются applyRemoteData',
  (() => {
    const fixture = parsePricingPage(fixtureHtml);
    const applied = applyRemoteData({ schedule: fixture.schedule.data, prices: fixture.prices.models });
    const result = [applied.scheduleApplied, applied.pricesApplied];
    resetToBundled();
    return result;
  })(),
  [true, true],
);
check(
  'другое окно из страницы действительно меняет расписание',
  (() => {
    const parsedNew = parseSchedule(
      sentence('Peak hours are 01:00 - 03:00 UTC, Monday through Friday (all other hours are off-peak).'),
    );
    applyRemoteData({ schedule: parsedNew.data, prices: null });
    const windows = getSchedule().peakWindowsUtc;
    resetToBundled();
    return windows;
  })(),
  [{ startMinute: 60, endMinute: 180 }],
);
check(
  'регресс: расписание без ключа peakWindowsUtc отбраковывается',
  isPlausibleSchedule({
    peakWeekdaysUtc: [1, 2, 3, 4, 5],
    windowsUtc: [{ startMinute: 60, endMinute: 180 }],
  }),
  false,
);

console.log(`\n${checks - failures}/${checks} проверок пройдено`);
process.exit(failures ? 1 : 0);
