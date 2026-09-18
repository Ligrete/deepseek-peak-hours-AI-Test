/**
 * Прогон popup.js в минимальном фейковом DOM: ловит ошибки рендера,
 * несоответствие статуса и пустые блоки (таймлайн, расписание, цены).
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
globalThis.chrome = { runtime: { sendMessage: () => Promise.resolve({ ok: true }) } };

await import('../src/popup.js');

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
check('локальные часы заполнены', /\d{2}:\d{2}:\d{2}/.test(text('#local-clock')), text('#local-clock'));
check('UTC-часы заполнены', /UTC$/.test(text('#utc-clock')), text('#utc-clock'));
check('обратный отсчёт заполнен', text('#countdown-value') !== '—', text('#countdown-value'));
check('подсказка про смену тарифа заполнена', text('#countdown-hint').length > 5, text('#countdown-hint'));
check('пояс пользователя указан', text('#tz-note').includes('Ваш пояс:'));
check('таймлайн дня построен', (registry.get('#timeline')?.children.length ?? 0) === 1);
check('расписание по дням построено', (registry.get('#week')?.children.length ?? 0) > 0);
check('таблица цен построена', /deepseek-flash/.test(registry.get('#prices')?.innerHTML || ''));
check('body получил цвет статуса', ['peak', 'off'].includes(document.body.dataset.status));

console.log(failures ? `\n${failures} проверок не прошло` : '\nPopup рендерится корректно');
process.exit(failures ? 1 : 0);
