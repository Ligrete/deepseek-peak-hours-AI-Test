/** Popup: статус, обратный отсчёт, таймлайн суток, расписание, цены и источник данных. */

import {
  currentPeakWindow,
  getPrices,
  getSchedule,
  localDayHourStatuses,
  localTimezone,
  nextTransition,
  status,
  weeklyLocalSchedule,
} from './schedule.js';
import { describeDataState, loadStoredPricing, readStoredPricing } from './schedule-update.js';

const LOCALE = 'ru-RU';
/** Тик раз в 30 секунд: отсчёт идёт в минутах, секунды не нужны (и не грузят CPU). */
const TICK_MS = 30000;
const $ = (selector) => document.querySelector(selector);

const tzId = localTimezone();
const tzShort = (() => {
  try {
    const parts = new Intl.DateTimeFormat(LOCALE, { timeZoneName: 'short' }).formatToParts(new Date());
    return parts.find((p) => p.type === 'timeZoneName')?.value || tzId;
  } catch {
    return tzId;
  }
})();

function time(date) {
  return date.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
}

function utcTime(date) {
  return `${date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC`;
}

/** Отсчёт в минутах: без секунд, чтобы popup не перерисовывался каждую секунду. */
function humanLeft(ms) {
  const totalMinutes = Math.max(0, Math.ceil(ms / 60000));
  if (totalMinutes < 1) return 'меньше минуты';
  if (totalMinutes < 60) return `${totalMinutes} мин`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours} ч ${minutes} мин` : `${hours} ч`;
}

function money(value) {
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3).replace(/0+$/, '')}`;
  return `$${value.toFixed(4)}`;
}

function buildTimeline() {
  const hours = localDayHourStatuses(new Date());
  const wrap = document.createDocumentFragment();
  const strip = document.createElement('div');
  strip.className = 'timeline';
  const ticks = document.createElement('div');
  ticks.className = 'ticks';

  for (const { hour, peak } of hours) {
    const cell = document.createElement('i');
    cell.className = peak ? 'peak' : '';
    cell.dataset.hour = String(hour);
    cell.title = `${String(hour).padStart(2, '0')}:00 — ${peak ? 'пик' : 'офф-пик'}`;
    strip.append(cell);

    const tick = document.createElement('span');
    tick.textContent = hour % 3 === 0 ? String(hour) : '';
    ticks.append(tick);
  }

  wrap.append(strip, ticks);
  const host = $('#timeline');
  host.replaceChildren(wrap);
  markCurrentHour();
}

function markCurrentHour() {
  const hour = new Date().getHours();
  for (const cell of document.querySelectorAll('.timeline i')) {
    cell.classList.toggle('now', Number(cell.dataset.hour) === hour);
  }
}

function buildWeek() {
  const list = weeklyLocalSchedule(new Date(), 8, LOCALE);
  const host = $('#week');
  host.replaceChildren(
    ...list.map(({ weekdayName, windows }) => {
      const li = document.createElement('li');
      const day = document.createElement('span');
      day.className = 'day';
      day.textContent = weekdayName;
      const win = document.createElement('span');
      win.className = 'win';
      win.textContent = windows.join('  ·  ');
      li.append(day, win);
      return li;
    }),
  );
}

function buildPrices() {
  const prices = getPrices();
  const rows = [];
  for (const model of prices) {
    rows.push(
      `<tr class="model-row"><td colspan="3">${model.name}</td></tr>`,
      ...model.metrics.map(
        (m) =>
          `<tr><td>${m.name}</td><td class="off">${money(m.offPeak)}</td><td class="peak">${money(m.peak)}</td></tr>`,
      ),
    );
  }
  $('#prices').innerHTML = `<table><thead><tr><th>Метрика</th><th>Офф-пик</th><th>Пик</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

async function renderDataSource() {
  const stored = await readStoredPricing();
  const state = describeDataState(stored, LOCALE);
  const host = $('#data-source');
  host.dataset.tone = state.tone;
  host.textContent = state.text;
  host.title = state.detail || '';
}

function renderStatic() {
  const now = new Date();
  const s = status(now);
  const schedule = getSchedule();
  const next = nextTransition(now);
  const window_ = currentPeakWindow(now);

  document.body.dataset.status = s.peak ? 'peak' : 'off';

  $('#status-title').textContent = s.peak ? 'ПИК — полная цена' : `ОФФ-ПИК — скидка ${schedule.discountPercent}%`;
  $('#status-note').textContent = s.peak
    ? 'Сейчас дорогой тариф. Массовые задачи лучше отложить.'
    : 'Лучшее время для тяжёлых прогонов: цены вдвое ниже.';

  $('#countdown-label').textContent = s.peak ? 'До офф-пика (скидки)' : 'До пика (полной цены)';
  if (next) {
    $('#countdown-hint').textContent = s.peak
      ? `Пик закончится в ${time(next.at)} (${utcTime(next.at)})`
      : window_
        ? `Пик начнётся в ${time(next.at)} (${utcTime(next.at)})`
        : `Ближайший пик: ${next.at.toLocaleDateString(LOCALE, { weekday: 'short' })}, ${time(next.at)} (${utcTime(next.at)})`;
  }

  buildTimeline();
  buildWeek();
  $('#tz-note').textContent = `Ваш пояс: ${tzId}`;
}

function tick() {
  const now = new Date();
  const s = status(now);
  const next = nextTransition(now);
  const key = `${s.peak}|${next ? next.at.toISOString() : 'none'}|${now.getHours()}`;
  if (key !== tick.lastKey) {
    tick.lastKey = key;
    renderStatic();
  } else {
    markCurrentHour();
  }

  $('#local-clock').textContent = `${time(now)} ${tzShort}`;
  $('#utc-clock').textContent = utcTime(now);
  $('#countdown-value').textContent = next ? humanLeft(next.msLeft) : '—';
}

async function onRefreshClick() {
  const button = $('#refresh-data');
  button.disabled = true;
  const original = button.textContent;
  button.textContent = 'Обновляю…';
  try {
    const response = await globalThis.chrome?.runtime?.sendMessage?.({ type: 'refresh-pricing', force: true });
    if (response?.status === 'updated') {
      button.textContent = 'Обновлено';
    } else {
      button.textContent = 'Не удалось';
    }
  } catch {
    button.textContent = 'Не удалось';
  }
  await renderDataSource();
  renderStatic();
  buildPrices();
  setTimeout(() => {
    button.textContent = original;
    button.disabled = false;
  }, 1500);
}

// Попап открывается на секунды — секундный тик здесь не нужен, хватает 30 с.
async function init() {
  await loadStoredPricing();
  await renderDataSource();
  buildPrices();
  tick();
  setInterval(tick, TICK_MS);
  $('#refresh-data').addEventListener('click', onRefreshClick);
  // Просим service worker обновить иконку сразу при открытии popup.
  Promise.resolve(globalThis.chrome?.runtime?.sendMessage?.({ type: 'refresh' })).catch(() => {});
}

init().catch((error) => console.error('[DeepSeek Peak Hours] popup:', error));
