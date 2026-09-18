/**
 * Прогон popup.js в минимальном фейковом DOM: ловит ошибки рендера,
 * несоответствие статуса, пустые блоки и лишние таймеры.
 *
 * Отдельно проверяется, что popup больше не тикает каждую секунду
 * (секунды убраны из отсчёта — экономим CPU) и что кнопка обновления данных
 * действительно перерисовывает источник.
 */

import { isPeak } from '../src/schedule.js';

class FakeEl {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.className = '';
    this.textContent = '';
    this.innerHTML = '';
    this.title = '';
    this.disabled = false;
    this.listeners = {};
    this.classList = {
      toggle: () => {},
      add: () => {},
      remove: () => {},
    };
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes) {
    this.children = nodes;
  }

  addEventListener(type, handler) {
    this.listeners[type] = handler;
  }
}

const registry = new Map();
globalThis.document = {
  body: new FakeEl('body'),
  createElement: (tag) => new FakeEl(tag),
  createDocumentFragment: () => new FakeEl('fragment'),
  querySelector: (selector) => {
    if (!registry.has(selector)) registry.set(selector, new FakeEl());
    return registry.get(selector);
  },
  querySelectorAll: () => [],
};

/* Служба обновления: имитируем и storage, и ответ service worker'а на refresh-pricing. */
const storage = new Map();
const STORAGE_KEY = 'deepseekPeakHours.pricing';
let messages = [];

globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => (storage.has(key) ? { [key]: storage.get(key) } : {}),
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) storage.set(k, v);
      },
    },
  },
  runtime: {
    sendMessage: async (message) => {
      messages.push(message);
      if (message?.type === 'refresh-pricing') {
        storage.set(STORAGE_KEY, {
          ok: true,
          attemptedAt: new Date().toISOString(),
          fetchedAt: new Date().toISOString(),
          lastError: null,
          schedule: { sentence: '01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday (all other hours are off-peak)' },
          prices: null,
          warnings: [],
        });
        return { status: 'updated' };
      }
      return { ok: true };
    },
  },
};

/* Перехватываем таймеры, чтобы проверить частоту обновления и не держать процесс. */
const realSetTimeout = globalThis.setTimeout;
const intervals = [];
globalThis.setInterval = (fn, ms) => {
  intervals.push(ms);
  return 0;
};
const timeouts = [];
globalThis.setTimeout = (fn, ms) => {
  timeouts.push(ms);
  return 0;
};

await import('../src/popup.js');
// popup.js запускает async init() без await — даём ему завершиться.
await new Promise((resolve) => realSetTimeout(resolve, 60));

let failures = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !extra ? '' : ` → ${extra}`}`);
};

const text = (selector) => registry.get(selector)?.textContent ?? '';
const peak = isPeak(new Date());

check(
  `статус совпадает с расписанием (${peak ? 'пик' : 'офф-пик'})`,
  text('#status-title').includes(peak ? 'ПИК' : 'ОФФ-ПИК'),
  text('#status-title'),
);
check('подпись статуса заполнена', text('#status-note').length > 10, text('#status-note'));
check('локальные часы в формате ЧЧ:ММ', /^\d{2}:\d{2}\s/.test(text('#local-clock')), text('#local-clock'));
check('в часах нет секунд', !/:\d{2}:\d{2}/.test(text('#local-clock')), text('#local-clock'));
check('UTC-часы заполнены', /UTC$/.test(text('#utc-clock')), text('#utc-clock'));
check('обратный отсчёт заполнен', text('#countdown-value') !== '—', text('#countdown-value'));
check(
  'в отсчёте нет секунд',
  /^(меньше минуты|\d+ мин|\d+ ч( \d+ мин)?)$/.test(text('#countdown-value')),
  text('#countdown-value'),
);
check('подсказка про смену тарифа заполнена', text('#countdown-hint').length > 5, text('#countdown-hint'));
check('пояс пользователя указан', text('#tz-note').includes('Ваш пояс:'));
check('таймлайн дня построен', (registry.get('#timeline')?.children.length ?? 0) === 1);
check('расписание по дням построено', (registry.get('#week')?.children.length ?? 0) > 0);
check('таблица цен построена', /deepseek-flash/.test(registry.get('#prices')?.innerHTML || ''));
check('body получил цвет статуса', ['peak', 'off'].includes(document.body.dataset.status));

check('тик раз в 30 секунд (а не каждую секунду)', JSON.stringify(intervals) === JSON.stringify([30000]), JSON.stringify(intervals));
check('иконку просят обновить при открытии popup', messages.some((m) => m.type === 'refresh'));

check('до обновления источник — файл расширения', text('#data-source').includes('файла расширения'), text('#data-source'));
check('тон источника bundled', registry.get('#data-source')?.dataset.tone === 'bundled', registry.get('#data-source')?.dataset.tone);

// Нажимаем «Обновить данные»: service worker отвечает updated, popup показывает новый источник.
const button = registry.get('#refresh-data');
await button.listeners.click();
check('запрошено принудительное обновление', messages.some((m) => m.type === 'refresh-pricing' && m.force === true));
check('источник переключился на страницу DeepSeek', text('#data-source').includes('сайта DeepSeek'), text('#data-source'));
check('тон источника remote', registry.get('#data-source')?.dataset.tone === 'remote', registry.get('#data-source')?.dataset.tone);
check('кнопка сообщила об успехе', button.textContent === 'Обновлено', button.textContent);
check('таймер возврата кнопки запланирован', timeouts.includes(1500), JSON.stringify(timeouts));

console.log(failures ? `\n${failures} проверок не прошло` : '\nPopup рендерится корректно');
process.exit(failures ? 1 : 0);
