/**
 * Проверка логики расписания. Запуск: npm test (или node tools/check-schedule.mjs).
 * Тест ожидает локальный пояс Europe/Moscow, поэтому прогоняйте с TZ=Europe/Moscow.
 */

import {
  currentPeakWindow,
  isPeak,
  localDayHourStatuses,
  nextTransition,
  status,
  weeklyLocalSchedule,
} from '../src/schedule.js';

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
    console.log(`  FAIL ${name}: получено ${a}, ожидалось ${e}`);
  }
}

const utc = (s) => new Date(`${s}Z`);

console.log('Границы пиковых окон (UTC, будни 01:00–04:00 и 06:00–10:00):');
check('пт 00:59 → офф-пик', isPeak(utc('2026-09-18T00:59:00')), false);
check('пт 01:00 → пик', isPeak(utc('2026-09-18T01:00:00')), true);
check('пт 03:59 → пик', isPeak(utc('2026-09-18T03:59:59')), true);
check('пт 04:00 → офф-пик', isPeak(utc('2026-09-18T04:00:00')), false);
check('пт 06:00 → пик', isPeak(utc('2026-09-18T06:00:00')), true);
check('пт 09:59 → пик', isPeak(utc('2026-09-18T09:59:00')), true);
check('пт 10:00 → офф-пик', isPeak(utc('2026-09-18T10:00:00')), false);

console.log('Выходные целиком офф-пик:');
check('сб 02:00 → офф-пик', isPeak(utc('2026-09-19T02:00:00')), false);
check('сб 08:00 → офф-пик', isPeak(utc('2026-09-19T08:00:00')), false);
check('вс 08:00 → офф-пик', isPeak(utc('2026-09-20T08:00:00')), false);
check('пн 01:00 → пик', isPeak(utc('2026-09-21T01:00:00')), true);

console.log('Ближайшая смена тарифа:');
check(
  'из пика 02:00 → конец окна 04:00, toPeak=false',
  (() => {
    const t = nextTransition(utc('2026-09-18T02:00:00'));
    return [t.at.toISOString(), t.toPeak];
  })(),
  ['2026-09-18T04:00:00.000Z', false],
);
check(
  'из офф-пика 04:30 → старт окна 06:00, toPeak=true',
  (() => {
    const t = nextTransition(utc('2026-09-18T04:30:00'));
    return [t.at.toISOString(), t.toPeak];
  })(),
  ['2026-09-18T06:00:00.000Z', true],
);
check(
  'из офф-пика пт 10:17 → пн 01:00 (выходные пропускаются), toPeak=true',
  (() => {
    const t = nextTransition(utc('2026-09-18T10:17:00'));
    return [t.at.toISOString(), t.toPeak];
  })(),
  ['2026-09-21T01:00:00.000Z', true],
);
check(
  'из офф-пика сб 12:00 → пн 01:00, toPeak=true',
  (() => {
    const t = nextTransition(utc('2026-09-19T12:00:00'));
    return [t.at.toISOString(), t.toPeak];
  })(),
  ['2026-09-21T01:00:00.000Z', true],
);
check(
  'из офф-пика сб 16:00 → пн 01:00, toPeak=true',
  (() => {
    const t = nextTransition(utc('2026-09-19T16:00:00'));
    return [t.at.toISOString(), t.toPeak];
  })(),
  ['2026-09-21T01:00:00.000Z', true],
);

console.log('Статус и текущее окно:');
check('status(пт 02:00) = пик без скидки', status(utc('2026-09-18T02:00:00')).discountPercent, 0);
check('status(пт 02:00) множитель 1', status(utc('2026-09-18T02:00:00')).priceMultiplier, 1);
check('status(пт 11:00) множитель 0.5', status(utc('2026-09-18T11:00:00')).priceMultiplier, 0.5);
check(
  'currentPeakWindow(пт 07:00) = 06:00–10:00',
  (() => {
    const w = currentPeakWindow(utc('2026-09-18T07:00:00'));
    return [w.start.toISOString(), w.end.toISOString()];
  })(),
  ['2026-09-18T06:00:00.000Z', '2026-09-18T10:00:00.000Z'],
);
check('currentPeakWindow(пт 11:00) = null', currentPeakWindow(utc('2026-09-18T11:00:00')), null);

console.log(`Локальное время (TZ=${process.env.TZ || 'системный'}):`);
if ((process.env.TZ || '') === 'Europe/Moscow') {
  check(
    'пиковые окна в Москве: пн–пт 04:00–07:00 и 09:00–13:00',
    weeklyLocalSchedule(utc('2026-09-18T10:17:00'), 8, 'ru-RU').map((d) => d.windows),
    [
      ['04:00–07:00', '09:00–13:00'],
      ['04:00–07:00', '09:00–13:00'],
      ['04:00–07:00', '09:00–13:00'],
      ['04:00–07:00', '09:00–13:00'],
      ['04:00–07:00', '09:00–13:00'],
      ['04:00–07:00', '09:00–13:00'],
      ['04:00–07:00', '09:00–13:00'],
    ],
  );
  check(
    'локальные пиковые часы: 4,5,6 и 9,10,11,12',
    localDayHourStatuses(utc('2026-09-18T10:17:00'))
      .filter((h) => h.peak)
      .map((h) => h.hour),
    [4, 5, 6, 9, 10, 11, 12],
  );
} else {
  console.log('  skip проверки локального времени (нужен TZ=Europe/Moscow)');
}

console.log(`\n${checks - failures}/${checks} проверок пройдено`);
process.exit(failures ? 1 : 0);
