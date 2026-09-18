/**
 * Разбор страницы тарифов DeepSeek (https://api-docs.deepseek.com/quick_start/pricing):
 * расписание пиковых часов и таблица цен.
 *
 * Только чистые функции — ни chrome.*, ни сети. Поэтому парсер легко тестируется
 * на сохранённой копии страницы (tools/fixtures/) и не зависит от версии Chrome.
 *
 * Принцип: если что-то не распозналось — возвращаем ok:false с причиной, а не
 * угадываем. Вызывающий код в этом случае оставляет прежние (проверенные) данные.
 */

export const SOURCE_URL = 'https://api-docs.deepseek.com/quick_start/pricing/';

const WEEKDAY_INDEX = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const WEEKDAY_ALIASES = {
  sun: 'sunday',
  mon: 'monday',
  tue: 'tuesday',
  tues: 'tuesday',
  wed: 'wednesday',
  thu: 'thursday',
  thur: 'thursday',
  thurs: 'thursday',
  fri: 'friday',
  sat: 'saturday',
};

/** Метрики, которые обязаны быть в таблице, иначе цену не применяем. */
const METRIC_LABELS = [
  { id: 'cacheHit', name: 'Вход, кэш-хит', test: /INPUT TOKENS.*CACHE HIT/i },
  { id: 'cacheMiss', name: 'Вход, кэш-мисс', test: /INPUT TOKENS.*CACHE MISS/i },
  { id: 'output', name: 'Выход', test: /OUTPUT TOKENS/i },
];
const REQUIRED_METRICS = METRIC_LABELS.map((m) => m.id);

const DAY_WORD =
  '(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues|tue|wed|thu|thur|thurs|fri|sat)';

/* ---------- HTML → текст ---------- */

export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x?[0-9a-f]+;/gi, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ---------- Расписание ---------- */

function fail(reason) {
  return { ok: false, reason };
}

function parseWindows(text) {
  const windows = [];
  const re = /(\d{1,2}):(\d{2})\s*(?:[-–—−]|to)\s*(\d{1,2}):(\d{2})/gi;
  for (const match of text.matchAll(re)) {
    const startMinute = Number(match[1]) * 60 + Number(match[2]);
    const endMinute = Number(match[3]) * 60 + Number(match[4]);
    const valid =
      startMinute >= 0 &&
      startMinute < endMinute &&
      endMinute <= 24 * 60 &&
      Number(match[2]) < 60 &&
      Number(match[4]) < 60;
    if (!valid) continue;
    if (!windows.some((w) => w.startMinute === startMinute && w.endMinute === endMinute)) {
      windows.push({ startMinute, endMinute });
    }
  }
  return windows.sort((a, b) => a.startMinute - b.startMinute);
}

function parseWeekdays(text) {
  const lower = text.toLowerCase();
  const range = lower.match(new RegExp(`\\b${DAY_WORD}\\b\\s*(?:through|thru|to|[-–—])\\s*\\b${DAY_WORD}\\b`, 'i'));
  if (range) {
    const from = WEEKDAY_INDEX[WEEKDAY_ALIASES[range[1]] || range[1]];
    const to = WEEKDAY_INDEX[WEEKDAY_ALIASES[range[2]] || range[2]];
    if (Number.isInteger(from) && Number.isInteger(to)) {
      const days = [];
      for (let i = 0; i < 7; i += 1) {
        const day = (from + i) % 7;
        days.push(day);
        if (day === to) break;
      }
      return days;
    }
  }

  const words = [...lower.matchAll(new RegExp(`\\b${DAY_WORD}\\b`, 'gi'))].map(
    (m) => WEEKDAY_INDEX[WEEKDAY_ALIASES[m[1].toLowerCase()] || m[1].toLowerCase()],
  );
  if (words.length) return [...new Set(words)].sort((a, b) => a - b);

  if (/\bweekdays?\b/.test(lower)) return [1, 2, 3, 4, 5];
  if (/\bweekends?\b/.test(lower)) return [0, 6];
  return [];
}

function parseDiscount(text) {
  if (/off-peak rates? (?:are|is)\s+half\b/i.test(text)) return 50;
  const match = text.match(/off-peak[^.]{0,80}?(\d{1,3})\s*%\s*(?:off|lower|cheaper|discount)?/i);
  if (match) {
    const value = Number(match[1]);
    if (value > 0 && value < 100) return value;
  }
  return null;
}

/**
 * Разбирает фразу вида
 * "Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday (all other hours are off-peak)."
 * @param {string} pageText текст страницы (после htmlToText)
 */
export function parseSchedule(pageText) {
  const text = String(pageText);
  const sentence = text.match(/peak hours are\s+([^.]+)\./i);
  if (!sentence) return fail('на странице нет фразы «Peak hours are …»');

  const body = sentence[1].trim();
  if (!/\butc\b/i.test(body)) {
    return fail('в расписании нет привязки к UTC — не применяю, чтобы не сдвинуть часы');
  }

  const windows = parseWindows(body);
  if (!windows.length) return fail('не нашёл ни одного интервала вида HH:MM - HH:MM');

  const weekdays = parseWeekdays(body);
  if (!weekdays.length) return fail('не нашёл дни недели в расписании');

  return {
    ok: true,
    data: {
      peakWindowsUtc: windows,
      peakWeekdaysUtc: weekdays,
      discountPercent: parseDiscount(text),
      sentence: body,
    },
  };
}

/* ---------- Цены ---------- */

function tableRows(html) {
  return [...String(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
    [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) =>
      htmlToText(cell[1]),
    ),
  );
}

function findPricingRows(html) {
  for (const table of String(html).matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const rows = tableRows(table[1]);
    const hasModels = rows.some((cells) => cells.some((c) => /^deepseek-[a-z0-9.-]+/i.test(c)));
    const hasTariffs = rows.some((cells) => cells.some((c) => /^(off-peak|peak)$/i.test(c.trim())));
    if (hasModels && hasTariffs) return rows;
  }
  return null;
}

export function parsePrices(html) {
  const rows = findPricingRows(html);
  if (!rows) return fail('не нашёл таблицу тарифов с моделями deepseek-* и строками OFF-PEAK/PEAK');

  const header = rows.find((cells) => cells.some((c) => /^deepseek-[a-z0-9.-]+/i.test(c)));
  const models = header
    .map((cell) => (cell.match(/^deepseek-[a-z0-9.-]+/i) || [])[0])
    .filter(Boolean);
  if (!models.length) return fail('в шапке таблицы нет названий моделей');

  const collected = new Map();
  let currentMetric = null;
  let misaligned = null;

  for (const cells of rows) {
    for (const cell of cells) {
      const metric = METRIC_LABELS.find((m) => m.test.test(cell));
      if (metric) {
        currentMetric = metric;
        break;
      }
    }

    const tariffIndex = cells.findIndex((c) => /^(off-peak|peak)$/i.test(c.trim()));
    if (tariffIndex === -1 || !currentMetric) continue;

    const kind = /^off-peak$/i.test(cells[tariffIndex].trim()) ? 'offPeak' : 'peak';
    const prices = cells
      .slice(tariffIndex + 1)
      .map((c) => c.trim())
      .filter((c) => /^\$?\d+(?:\.\d+)?$/.test(c))
      .map((c) => Number(c.replace('$', '')));

    if (prices.length !== models.length) {
      misaligned = `${currentMetric.id}/${kind}: цен ${prices.length}, моделей ${models.length}`;
      continue;
    }

    if (!collected.has(currentMetric.id)) collected.set(currentMetric.id, {});
    collected.get(currentMetric.id)[kind] = prices;
  }

  if (misaligned) return fail(`число цен не совпало с числом моделей (${misaligned})`);

  const result = models.map((id, index) => {
    const metrics = [];
    for (const metric of METRIC_LABELS) {
      const data = collected.get(metric.id);
      if (!data?.offPeak || !data?.peak) continue;
      const offPeak = data.offPeak[index];
      const peak = data.peak[index];
      metrics.push({ id: metric.id, name: metric.name, offPeak, peak });
    }
    return { id, name: id, metrics };
  });

  for (const model of result) {
    const ids = model.metrics.map((m) => m.id);
    const missing = REQUIRED_METRICS.filter((id) => !ids.includes(id));
    if (missing.length) return fail(`у модели ${model.id} нет метрик: ${missing.join(', ')}`);
    for (const metric of model.metrics) {
      const bad =
        !Number.isFinite(metric.offPeak) ||
        !Number.isFinite(metric.peak) ||
        metric.offPeak <= 0 ||
        metric.peak <= metric.offPeak;
      if (bad) {
        return fail(
          `неправдоподобная цена ${model.id}/${metric.id}: пик ${metric.peak}, офф-пик ${metric.offPeak}`,
        );
      }
    }
  }

  return { ok: true, models: result };
}

/* ---------- Всё вместе ---------- */

export function parsePricingPage(html) {
  const text = htmlToText(html);
  const schedule = parseSchedule(text);
  const prices = parsePrices(html);
  const warnings = [];

  if (!prices.ok) warnings.push(`цены не распознаны (${prices.reason}) — оставил цены из файла расширения`);
  if (schedule.ok && schedule.data.discountPercent == null) {
    warnings.push('размер скидки на странице не указан — оставил прежний');
  }

  return { text, schedule, prices, warnings };
}
