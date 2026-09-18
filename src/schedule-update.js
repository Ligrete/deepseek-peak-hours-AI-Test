/**
 * Обновление расписания и цен со страницы тарифов DeepSeek.
 *
 * Логика: раз в неделю (или при первом запуске) скачиваем страницу, разбираем её
 * (src/parse-pricing.js), сохраняем в chrome.storage.local и подставляем в schedule.js.
 * Успешные данные живут 7 дней, неудачная попытка повторяется через 12 часов —
 * поэтому расширение не ходит в сеть постоянно, но и не «залипает» на ошибке.
 *
 * Сеть используется только для чтения публичной страницы тарифов.
 */

import { parsePricingPage, SOURCE_URL } from './parse-pricing.js';
import { applyRemoteData, isPlausibleSchedule } from './schedule.js';

export const STORAGE_KEY = 'deepseekPeakHours.pricing';
/** Успешные данные считаются свежими неделю. */
export const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/** После неудачной попытки пробуем снова через 12 часов. */
export const RETRY_INTERVAL_MS = 12 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20 * 1000;

const storageArea = () => globalThis.chrome?.storage?.local;

export async function readStoredPricing() {
  const area = storageArea();
  if (!area) return null;
  try {
    const result = await area.get(STORAGE_KEY);
    return result?.[STORAGE_KEY] ?? null;
  } catch {
    return null;
  }
}

async function writeStoredPricing(data) {
  const area = storageArea();
  if (!area) return false;
  try {
    await area.set({ [STORAGE_KEY]: data });
    return true;
  } catch {
    return false;
  }
}

/**
 * Пора ли обновлять данные: нет данных — да; свежий успех — нет;
 * свежая неудачная попытка — нет (ждём RETRY_INTERVAL_MS).
 */
export function shouldRefresh(stored, nowMs = Date.now()) {
  if (!stored?.attemptedAt) return true;
  const attempted = Date.parse(stored.attemptedAt);
  if (!Number.isFinite(attempted)) return true;
  const age = nowMs - attempted;
  return age >= (stored.ok ? REFRESH_INTERVAL_MS : RETRY_INTERVAL_MS);
}

/**
 * Подставляет ранее сохранённые данные (если они были успешно скачаны).
 * @returns {Promise<object|null>} сохранённая запись
 */
export async function loadStoredPricing() {
  const stored = await readStoredPricing();
  if (stored?.ok) {
    applyRemoteData({ schedule: stored.schedule, prices: stored.prices });
  }
  return stored;
}

/**
 * Скачивает и применяет актуальные данные.
 * @param {{force?: boolean, now?: Date, fetchImpl?: typeof fetch}} options
 * @returns {Promise<{status: 'updated'|'skipped'|'failed', stored: object|null, reason?: string}>}
 */
export async function refreshPricing({ force = false, now = new Date(), fetchImpl } = {}) {
  const previous = await readStoredPricing();

  if (!force && !shouldRefresh(previous, now.getTime())) {
    if (previous?.ok) applyRemoteData({ schedule: previous.schedule, prices: previous.prices });
    return { status: 'skipped', stored: previous, reason: 'данные ещё свежие' };
  }

  const attemptedAt = now.toISOString();

  try {
    const request = fetchImpl || globalThis.fetch;
    if (typeof request !== 'function') throw new Error('fetch недоступен');

    const signal =
      typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(FETCH_TIMEOUT_MS)
        : undefined;

    const response = await request(SOURCE_URL, { cache: 'no-store', redirect: 'follow', signal });
    if (!response?.ok) throw new Error(`HTTP ${response?.status ?? '?'}`);

    const html = await response.text();
    const parsed = parsePricingPage(html);
    if (!parsed.schedule?.ok) {
      throw new Error(parsed.schedule?.reason || 'расписание не распознано');
    }

    const prices = parsed.prices?.ok ? parsed.prices.models : null;
    const schedule = {
      ...parsed.schedule.data,
      sourceUrl: SOURCE_URL,
      checkedAt: attemptedAt.slice(0, 10),
    };

    // Явная проверка: «разобрали, но не применилось» должно быть громкой ошибкой,
    // а не тихой подменой на встроенные значения.
    if (!isPlausibleSchedule(schedule)) {
      throw new Error(
        `расписание со страницы не прошло проверку: ${JSON.stringify(schedule.peakWindowsUtc)} / ${JSON.stringify(schedule.peakWeekdaysUtc)}`,
      );
    }

    const record = {
      ok: true,
      attemptedAt,
      fetchedAt: attemptedAt,
      lastError: null,
      sourceUrl: SOURCE_URL,
      schedule,
      prices,
      warnings: parsed.warnings || [],
    };

    await writeStoredPricing(record);
    applyRemoteData({ schedule, prices });
    return { status: 'updated', stored: record };
  } catch (error) {
    const reason = String(error?.message || error);
    // Сохраняем прежние удачные данные как есть — падаем только на метаданные.
    const record = {
      ...(previous || {}),
      ok: Boolean(previous?.ok),
      attemptedAt,
      lastError: reason,
    };
    await writeStoredPricing(record);
    if (previous?.ok) applyRemoteData({ schedule: previous.schedule, prices: previous.prices });
    return { status: 'failed', stored: record, reason };
  }
}

/**
 * Человекочитаемое состояние источника данных для popup.
 * @returns {{tone: 'remote'|'bundled'|'error', text: string, detail: string}}
 */
export function describeDataState(stored, locale = 'ru-RU') {
  if (!stored) {
    return {
      tone: 'bundled',
      text: 'Данные из файла расширения (обновление ещё не выполнялось)',
      detail: '',
    };
  }

  if (stored.ok && stored.fetchedAt) {
    const date = new Date(stored.fetchedAt).toLocaleDateString(locale);
    const sentence = stored.schedule?.sentence ? `«Peak hours are ${stored.schedule.sentence}»` : '';
    return { tone: 'remote', text: `Данные с сайта DeepSeek · проверено ${date}`, detail: sentence };
  }

  const failedAt = stored.attemptedAt ? new Date(stored.attemptedAt).toLocaleDateString(locale) : '—';
  return {
    tone: 'error',
    text: `Обновление не удалось (${failedAt}) — используется файл расширения`,
    detail: stored.lastError || '',
  };
}
