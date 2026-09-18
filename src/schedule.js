/**
 * Расписание пиковых / офф-пиковых часов DeepSeek API и цены.
 *
 * Источник: https://api-docs.deepseek.com/quick_start/pricing
 *   "Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00
 *    and 06:00 - 10:00 UTC, Monday through Friday (all other hours are off-peak)."
 * Проверено: 2026-09-18.
 *
 * Внутри всё считается в UTC (так задано у DeepSeek). Часовой пояс пользователя
 * учитывается только при отображении — поэтому переход на летнее время не ломает логику.
 *
 * Данные ниже — «встроенные» (BUNDLED_*). Раз в неделю расширение скачивает страницу
 * тарифов и подменяет активные данные через applyRemoteData(); логика читает их через
 * getSchedule()/getPrices(). Если разбор не удался — остаются встроенные значения.
 */

export const BUNDLED_SCHEDULE = {
  sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
  checkedAt: '2026-09-18',
  discountPercent: 50,
  /** 0 = воскресенье ... 6 = суббота, как в Date#getUTCDay(). */
  peakWeekdaysUtc: [1, 2, 3, 4, 5],
  /** Границы — в минутах от начала суток UTC; начало включительно, конец — нет. */
  peakWindowsUtc: [
    { startMinute: 1 * 60, endMinute: 4 * 60 },
    { startMinute: 6 * 60, endMinute: 10 * 60 },
  ],
};

/** Цены за 1M токенов, USD. Источник — та же страница тарифов. */
export const BUNDLED_PRICES = [
  {
    id: 'deepseek-flash',
    name: 'deepseek-flash',
    metrics: [
      { id: 'cacheHit', name: 'Вход, кэш-хит', peak: 0.006, offPeak: 0.003 },
      { id: 'cacheMiss', name: 'Вход, кэш-мисс', peak: 0.3, offPeak: 0.15 },
      { id: 'output', name: 'Выход', peak: 1.2, offPeak: 0.6 },
    ],
  },
  {
    id: 'deepseek-v4-pro',
    name: 'deepseek-v4-pro',
    metrics: [
      { id: 'cacheHit', name: 'Вход, кэш-хит', peak: 0.044, offPeak: 0.022 },
      { id: 'cacheMiss', name: 'Вход, кэш-мисс', peak: 1.32, offPeak: 0.66 },
      { id: 'output', name: 'Выход', peak: 3.96, offPeak: 1.98 },
    ],
  },
];

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** Порядок дней недели для вывода: Пн … Вс. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const clone = (value) => JSON.parse(JSON.stringify(value));

let activeSchedule = clone(BUNDLED_SCHEDULE);
let activePrices = clone(BUNDLED_PRICES);
let dataOrigin = 'bundled';

/** Активное расписание: встроенное либо скачанное со страницы тарифов. */
export function getSchedule() {
  return activeSchedule;
}

/** Активные цены за 1M токенов. */
export function getPrices() {
  return activePrices;
}

/** 'bundled' — значения из этого файла, 'remote' — разобраны со страницы тарифов. */
export function getDataOrigin() {
  return dataOrigin;
}

/**
 * Проверка правдоподобности расписания перед применением.
 * Экспортируется, чтобы слой обновления мог отбраковать данные с понятной ошибкой,
 * а не молча оставить старые (см. src/schedule-update.js).
 */
export function isPlausibleSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') return false;
  const { peakWindowsUtc: windows, peakWeekdaysUtc: weekdays } = schedule;
  if (!Array.isArray(windows) || !windows.length) return false;
  if (!Array.isArray(weekdays) || !weekdays.length) return false;
  const windowsOk = windows.every(
    (w) =>
      Number.isInteger(w?.startMinute) &&
      Number.isInteger(w?.endMinute) &&
      w.startMinute >= 0 &&
      w.startMinute < w.endMinute &&
      w.endMinute <= 24 * 60,
  );
  const weekdaysOk = weekdays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  return windowsOk && weekdaysOk;
}

/**
 * Подставляет данные, разобранные со страницы тарифов.
 * Неправдоподобное расписание игнорируется (остаются встроенные значения), цены
 * применяются независимо — битое расписание не должно тянуть за собой цены.
 * @returns {{scheduleApplied: boolean, pricesApplied: boolean}}
 */
export function applyRemoteData({ schedule, prices } = {}) {
  let scheduleApplied = false;
  if (schedule && isPlausibleSchedule(schedule)) {
    activeSchedule = {
      ...clone(BUNDLED_SCHEDULE),
      ...clone(schedule),
      discountPercent:
        Number.isFinite(schedule.discountPercent) && schedule.discountPercent > 0
          ? schedule.discountPercent
          : BUNDLED_SCHEDULE.discountPercent,
    };
    dataOrigin = 'remote';
    scheduleApplied = true;
  }

  let pricesApplied = false;
  if (Array.isArray(prices) && prices.length) {
    activePrices = clone(prices);
    pricesApplied = true;
  }

  return { scheduleApplied, pricesApplied };
}

/** Возврат к встроенным данным (нужно тестам и при сбросе). */
export function resetToBundled() {
  activeSchedule = clone(BUNDLED_SCHEDULE);
  activePrices = clone(BUNDLED_PRICES);
  dataOrigin = 'bundled';
}

/** @returns {boolean} идёт ли сейчас пиковое окно. */
export function isPeak(date = new Date()) {
  const schedule = getSchedule();
  if (!schedule.peakWeekdaysUtc.includes(date.getUTCDay())) return false;
  const minuteOfDay = date.getUTCHours() * 60 + date.getUTCMinutes();
  return schedule.peakWindowsUtc.some(
    (w) => minuteOfDay >= w.startMinute && minuteOfDay < w.endMinute,
  );
}

/** Полное состояние тарифа в конкретный момент. */
export function status(date = new Date()) {
  const schedule = getSchedule();
  const peak = isPeak(date);
  return {
    peak,
    offPeak: !peak,
    discountPercent: peak ? 0 : schedule.discountPercent,
    priceMultiplier: peak ? 1 : 1 - schedule.discountPercent / 100,
    label: peak ? 'ПИК' : 'ОФФ-ПИК',
  };
}

/** Пиковые окна (как Date) для UTC-суток, начинающихся с utcDayStartMs. */
export function peakWindowDatesForUtcDay(utcDayStartMs) {
  return getSchedule().peakWindowsUtc.map((w) => ({
    start: new Date(utcDayStartMs + w.startMinute * MINUTE_MS),
    end: new Date(utcDayStartMs + w.endMinute * MINUTE_MS),
  }));
}

function utcDayStartMs(date) {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * Ближайшая реальная смена тарифа (учитываются только границы, где статус
 * действительно меняется: выходные целиком офф-пик, поэтому старты окон в
 * субботу/воскресенье сменой не считаются).
 * @returns {{at: Date, toPeak: boolean, msLeft: number}|null}
 */
export function nextTransition(date = new Date()) {
  const now = date.getTime();
  const day0 = utcDayStartMs(date);
  let best = null;
  for (let d = 0; d <= 8 && best === null; d += 1) {
    for (const { start, end } of peakWindowDatesForUtcDay(day0 + d * DAY_MS)) {
      for (const at of [start.getTime(), end.getTime()]) {
        if (at <= now) continue;
        if (isPeak(new Date(at - 1)) === isPeak(new Date(at))) continue;
        if (best === null || at < best) best = at;
      }
    }
  }
  if (best === null) return null;
  return { at: new Date(best), toPeak: isPeak(new Date(best)), msLeft: best - now };
}

/** Окно, в котором мы сейчас находимся: {start, end} текущего пика либо null. */
export function currentPeakWindow(date = new Date()) {
  if (!isPeak(date)) return null;
  const day0 = utcDayStartMs(date);
  for (const { start, end } of peakWindowDatesForUtcDay(day0)) {
    if (date >= start && date < end) return { start, end };
  }
  return null;
}

/**
 * Пиковые окна, переведённые в местное время пользователя и сгруппированные
 * по дню недели (локальному). Одинаковые пояса дают по одному интервалу на день.
 * @returns {Array<{weekday:number, windows:string[]}>}
 */
export function weeklyLocalSchedule(date = new Date(), days = 8, locale) {
  const day0 = utcDayStartMs(date);
  const byWeekday = new Map();
  for (let d = 0; d <= days; d += 1) {
    for (const { start, end } of peakWindowDatesForUtcDay(day0 + d * DAY_MS)) {
      const weekday = start.getDay();
      const span = end.getDay() === start.getDay() ? '' : ' (след. сутки)';
      const label = `${formatTime(start, locale)}–${formatTime(end, locale)}${span}`;
      if (!byWeekday.has(weekday)) byWeekday.set(weekday, new Set());
      byWeekday.get(weekday).add(label);
    }
  }
  return WEEK_ORDER.filter((w) => byWeekday.has(w)).map((weekday) => ({
    weekday,
    weekdayName: weekdayName(weekday, locale),
    windows: [...byWeekday.get(weekday)],
  }));
}

/** 24 значения «пик/не пик» для местных часов текущих суток (для полосы дня). */
export function localDayHourStatuses(date = new Date()) {
  const out = [];
  for (let hour = 0; hour < 24; hour += 1) {
    const probe = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, 30, 0, 0);
    out.push({ hour, peak: isPeak(probe) });
  }
  return out;
}

/** Короткое имя часового пояса пользователя, например "Europe/Moscow". */
export function localTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
  } catch {
    return 'local';
  }
}

export function formatTime(date, locale) {
  return date.toLocaleTimeString(locale || undefined, { hour: '2-digit', minute: '2-digit' });
}

export function weekdayName(weekday, locale) {
  // 7 января 2024 — воскресенье, берём локальную дату, чтобы попасть в нужный день.
  const ref = new Date(2024, 0, 7 + weekday);
  return ref.toLocaleDateString(locale || undefined, { weekday: 'short' });
}
