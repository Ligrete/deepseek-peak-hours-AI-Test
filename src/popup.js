/** Popup: живой статус, обратный отсчёт, таймлайн суток, расписание и цены. */

import {
  PRICES,
  SCHEDULE,
  currentPeakWindow,
  localDayHourStatuses,
  localTimezone,
  nextTransition,
  status,
  weeklyLocalSchedule,
} from './schedule.js';

const LOCALE = 'ru-RU';
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

function clock(date) {
  return date.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function utcTime(date) {
  return `${date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC`;
}

function humanLeft(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours} ч ${String(minutes).padStart(2, '0')} мин`;
  if (minutes > 0) return `${minutes} мин ${String(seconds).padStart(2, '0')} с`;
  return `${seconds} с`;
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
  const rows = [];
  for (const model of PRICES) {
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

function renderStatic() {
  const now = new Date();
  const s = status(now);
  const next = nextTransition(now);
  const window_ = currentPeakWindow(now);

  document.body.dataset.status = s.peak ? 'peak' : 'off';

  $('#status-title').textContent = s.peak ? 'ПИК — полная цена' : 'ОФФ-ПИК — скидка 50%';
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

  $('#local-clock').textContent = `${clock(now)} ${tzShort}`;
  $('#utc-clock').textContent = utcTime(now);
  $('#countdown-value').textContent = next ? humanLeft(next.msLeft) : '—';
}

buildPrices();
tick();
setInterval(tick, 1000);

// Просим service worker обновить иконку сразу при открытии popup.
Promise.resolve(globalThis.chrome?.runtime?.sendMessage?.({ type: 'refresh' })).catch(() => {});
