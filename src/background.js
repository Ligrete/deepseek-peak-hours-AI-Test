/**
 * Service worker: держит иконку расширения в актуальном состоянии.
 * Зелёная иконка + бейдж OFF — офф-пик (скидка 50%), красная + PEAK — пик.
 *
 * Про экономию ресурсов: service worker просыпается не по минутному таймеру, а
 * только к моменту смены тарифа (2–4 раза в сутки) плюс недельная проверка
 * актуальности тарифов. Раньше минутный alarm будил воркер 1440 раз в сутки.
 *
 * Про надёжность: chrome.action.setIcon({path}) из service worker иногда падает
 * с "Failed to fetch" (гонка при старте воркера). Поэтому здесь три уровня:
 *   1) path → 2) повтор через 300 мс → 3) imageData, собранный из тех же PNG
 * через OffscreenCanvas. После успешного перехода режим закрепляется (sticky).
 * Бейдж и заголовок ставятся независимо от иконки — сбой иконки их не блокирует.
 */

import { status, nextTransition } from './schedule.js';
import { loadStoredPricing, refreshPricing } from './schedule-update.js';

const ICON_SIZES = [16, 32, 48, 128];
const ICON_PATHS = {
  peak: Object.fromEntries(ICON_SIZES.map((s) => [s, `icons/icon-peak-${s}.png`])),
  off: Object.fromEntries(ICON_SIZES.map((s) => [s, `icons/icon-off-${s}.png`])),
};

const BADGE_COLORS = { peak: '#EF4444', off: '#22C55E' };
/** Одноразовый alarm ровно на следующую смену тарифа. */
const TRANSITION_ALARM = 'deepseek-peak-transition';
/** Недельная проверка страницы тарифов. */
const UPDATE_ALARM = 'deepseek-pricing-update';
const UPDATE_PERIOD_MINUTES = 7 * 24 * 60;
const UPDATE_DELAY_MINUTES = 60;
/** Страховка, если смену тарифа вычислить не удалось. */
const FALLBACK_WAKE_MINUTES = 60;

/** Режим установки иконки: 'path' (лёгкий) или 'imageData' (обходит баг Chrome). */
let iconMode = 'path';
/** Кэш ImageData по ключу "state:size". */
const imageDataCache = new Map();
/** Чтобы не спамить консоль одной и той же ошибкой на каждое состояние. */
const loggedFailures = new Set();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function humanLeft(ms) {
  const totalMinutes = Math.max(0, Math.round(ms / 60000));
  if (totalMinutes < 1) return 'меньше минуты';
  if (totalMinutes < 60) return `${totalMinutes} мин`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours} ч ${minutes} мин` : `${hours} ч`;
}

/** Собирает imageData для всех размеров из PNG-файлов расширения (с кэшем). */
async function loadImageData(state) {
  const dict = {};
  for (const size of ICON_SIZES) {
    const cacheKey = `${state}:${size}`;
    if (!imageDataCache.has(cacheKey)) {
      const url = chrome.runtime.getURL(ICON_PATHS[state][size]);
      const blob = await (await fetch(url)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(size, size);
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0, size, size);
      bitmap.close?.();
      imageDataCache.set(cacheKey, context.getImageData(0, 0, size, size));
    }
    dict[size] = imageDataCache.get(cacheKey);
  }
  return dict;
}

async function setIconWithImageData(state) {
  await chrome.action.setIcon({ imageData: await loadImageData(state) });
}

async function applyIcon(state) {
  if (iconMode === 'imageData') {
    await setIconWithImageData(state);
    return;
  }

  try {
    await chrome.action.setIcon({ path: ICON_PATHS[state] });
    return;
  } catch (firstError) {
    // Повтор: чаще всего сбой разовый и связан со стартом service worker.
    await delay(300);
    try {
      await chrome.action.setIcon({ path: ICON_PATHS[state] });
      return;
    } catch (secondError) {
      try {
        await setIconWithImageData(state);
        iconMode = 'imageData';
        console.info(
          '[DeepSeek Peak Hours] setIcon по пути недоступен в этом Chrome — переключился на imageData.',
          `Причина: ${firstError?.message || firstError}`,
        );
        return;
      } catch (fallbackError) {
        throw new Error(
          `path: ${firstError?.message || firstError}; imageData: ${fallbackError?.message || fallbackError}`,
        );
      }
    }
  }
}

async function applyBadge(state, title) {
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLORS[state] });
  if (typeof chrome.action.setBadgeTextColor === 'function') {
    await chrome.action.setBadgeTextColor({ color: '#FFFFFF' });
  }
  await chrome.action.setBadgeText({ text: state === 'peak' ? 'PEAK' : 'OFF' });
  await chrome.action.setTitle({ title });
}

/**
 * Ставит одноразовый alarm на момент следующей смены тарифа (+1 с запаса).
 * Так воркер просыпается только когда статус действительно меняется.
 * @returns {ReturnType<typeof nextTransition>} момент смены
 */
function scheduleNextWake(now = new Date()) {
  const next = nextTransition(now);
  if (!next) {
    chrome.alarms.create(TRANSITION_ALARM, {
      delayInMinutes: FALLBACK_WAKE_MINUTES,
      periodInMinutes: FALLBACK_WAKE_MINUTES,
    });
    return null;
  }
  chrome.alarms.create(TRANSITION_ALARM, { when: next.at.getTime() + 1000 });
  return next;
}

/**
 * Недельная проверка тарифов. Создаём только если такого alarm ещё нет:
 * bootstrap выполняется на каждом пробуждении воркера, и пересоздание сбрасывало
 * бы недельный цикл (alarm срабатывал бы через час после каждого пробуждения).
 */
async function ensureUpdateAlarm() {
  const getAlarm = chrome.alarms.get?.bind(chrome.alarms);
  if (getAlarm) {
    const existing = await getAlarm(UPDATE_ALARM);
    if (existing) return;
  }
  chrome.alarms.create(UPDATE_ALARM, {
    delayInMinutes: UPDATE_DELAY_MINUTES,
    periodInMinutes: UPDATE_PERIOD_MINUTES,
  });
}

async function refreshAction({ reschedule = true } = {}) {
  const now = new Date();
  const peak = status(now).peak;
  const state = peak ? 'peak' : 'off';
  const next = nextTransition(now);
  const eta = next ? humanLeft(next.msLeft) : '';
  const schedule = status(now);

  const title = peak
    ? `DeepSeek API: пик — полная цена${eta ? `, до скидки ${eta}` : ''}`
    : `DeepSeek API: офф-пик — скидка ${schedule.discountPercent}%${eta ? `, до пика ${eta}` : ''}`;

  // Бейдж и заголовок важны не меньше иконки, поэтому ставятся независимо.
  const results = await Promise.allSettled([applyBadge(state, title), applyIcon(state)]);

  const iconResult = results[1];
  if (iconResult.status === 'rejected') {
    const message = String(iconResult.reason?.message || iconResult.reason);
    if (!loggedFailures.has(message)) {
      loggedFailures.add(message);
      console.error(
        '[DeepSeek Peak Hours] не удалось обновить иконку (бейдж и подсказка обновлены):',
        message,
      );
    }
  } else {
    loggedFailures.clear();
  }

  if (reschedule) scheduleNextWake(now);
}

/** Обновляет расписание (если пора) и, если данные изменились, иконку. */
async function refreshPricingAndAction({ force = false } = {}) {
  const result = await refreshPricing({ force });
  if (result.status === 'updated') await refreshAction();
  return result;
}

/** Запуск/перезапуск воркера: применяем сохранённые данные и планируем пробуждения. */
async function bootstrap() {
  await loadStoredPricing();
  await refreshAction();
  await ensureUpdateAlarm();
  await refreshPricingAndAction();
}

chrome.runtime.onInstalled.addListener(() => {
  bootstrap();
});

chrome.runtime.onStartup.addListener(() => {
  bootstrap();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TRANSITION_ALARM) {
    refreshAction().catch((error) => console.error('[DeepSeek Peak Hours]', error));
  } else if (alarm.name === UPDATE_ALARM) {
    refreshPricingAndAction().catch((error) => console.error('[DeepSeek Peak Hours]', error));
  }
});

// Сообщения из popup: обновить иконку и/или принудительно перечитать тарифы.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'refresh') {
    refreshAction().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === 'refresh-pricing') {
    refreshPricingAndAction({ force: Boolean(message.force) })
      .then(async (result) => {
        await refreshAction();
        sendResponse(result);
      })
      .catch((error) => sendResponse({ status: 'failed', reason: String(error?.message || error) }));
    return true;
  }
  return false;
});

// Старт service worker'а (в т.ч. после засыпания).
bootstrap().catch((error) => console.error('[DeepSeek Peak Hours]', error));
