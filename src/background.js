/**
 * Service worker: держит иконку расширения в актуальном состоянии.
 * Зелёная иконка + бейдж OFF — офф-пик (скидка 50%), красная + PEAK — пик.
 *
 * Про надёжность: chrome.action.setIcon({path}) из service worker иногда падает
 * с "Failed to fetch" (гонка при старте воркера). Поэтому здесь три уровня:
 *   1) path → 2) повтор через 300 мс → 3) imageData, собранный из тех же PNG
 * через OffscreenCanvas. После успешного перехода режим закрепляется (sticky),
 * чтобы не дёргать заведомо сбойный путь каждый раз.
 * Бейдж и заголовок ставятся независимо от иконки — сбой иконки их не блокирует.
 */

import { status, nextTransition } from './schedule.js';

const ICON_SIZES = [16, 32, 48, 128];
const ICON_PATHS = {
  peak: Object.fromEntries(ICON_SIZES.map((s) => [s, `icons/icon-peak-${s}.png`])),
  off: Object.fromEntries(ICON_SIZES.map((s) => [s, `icons/icon-off-${s}.png`])),
};

const BADGE_COLORS = { peak: '#EF4444', off: '#22C55E' };
const ALARM_NAME = 'deepseek-peak-clock';

/** Режим установки иконки: 'path' (лёгкий) или 'imageData' (обходит баг Chrome). */
let iconMode = 'path';
/** Кэш ImageData по ключу "state:size". */
const imageDataCache = new Map();
/** Чтобы не спамить консоль одной и той же ошибкой на каждое состояние. */
const loggedFailures = new Set();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function humanLeft(ms) {
  const totalMinutes = Math.max(0, Math.round(ms / 60000));
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

async function refreshAction() {
  const now = new Date();
  const peak = status(now).peak;
  const state = peak ? 'peak' : 'off';
  const next = nextTransition(now);
  const eta = next ? humanLeft(next.msLeft) : '';

  const title = peak
    ? `DeepSeek API: пик — полная цена${eta ? `, до скидки ${eta}` : ''}`
    : `DeepSeek API: офф-пик — скидка 50%${eta ? `, до пика ${eta}` : ''}`;

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
}

function ensureAlarm() {
  chrome.alarms.create(ALARM_NAME, { delayInMinutes: 0.5, periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  refreshAction();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  refreshAction();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) refreshAction();
});

// Сообщение из popup при открытии — чтобы цвет обновился мгновенно.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'refresh') {
    refreshAction().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

// Старт service worker'а (в т.ч. после засыпания).
ensureAlarm();
refreshAction();
