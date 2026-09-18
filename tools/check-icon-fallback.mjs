/**
 * Регрессионный тест на сбой chrome.action.setIcon({path}) — "Failed to fetch"
 * (гонка при старте service worker в Chrome).
 *
 * Проверяем, что service worker:
 *   • повторяет попытку по пути;
 *   • затем переходит на imageData через OffscreenCanvas и запоминает этот режим;
 *   • в любом случае выставляет бейдж OFF/PEAK и подсказку;
 *   • не пишет console.error, если фолбэк сработал.
 */

const SIZES = [16, 32, 48, 128];

const iconCalls = [];
const pathAttempts = { count: 0 };
let badgeText = null;
let badgeColor = null;
let title = null;
const listeners = { alarm: [], installed: [], startup: [], message: [] };
const infos = [];
const errors = [];

globalThis.console.info = (...args) => infos.push(args.join(' '));
globalThis.console.error = (...args) => errors.push(args.join(' '));

globalThis.fetch = async (url) => {
  // Страница тарифов: отдаём валидный HTTP-ответ без расписания — это не должно
  // мешать иконке (сбой обновления обрабатывается внутри и не пишет console.error).
  if (String(url).includes('api-docs.deepseek.com')) {
    return { ok: true, status: 200, text: async () => '<html><body>нет расписания</body></html>' };
  }
  return { blob: async () => ({ url }) };
};
globalThis.createImageBitmap = async () => ({ close() {} });
globalThis.OffscreenCanvas = class {
  constructor(width, height) {
    this.width = width;
    this.height = height;
  }

  getContext() {
    return {
      drawImage() {},
      getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    };
  }
};

globalThis.chrome = {
  alarms: {
    create() {},
    onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
  },
  action: {
    setIcon: async (details) => {
      if (details.path) {
        pathAttempts.count += 1;
        iconCalls.push({ kind: 'path' });
        throw new Error("Failed to set icon 'icons/icon-off-16.png': Failed to fetch");
      }
      iconCalls.push({ kind: 'imageData', sizes: Object.keys(details.imageData), value: details.imageData });
    },
    setBadgeText: async (o) => {
      badgeText = o.text;
    },
    setBadgeBackgroundColor: async (o) => {
      badgeColor = o.color;
    },
    setBadgeTextColor: async () => {},
    setTitle: async (o) => {
      title = o.title;
    },
  },
  storage: {
    local: {
      get: async () => ({}),
      set: async () => {},
    },
  },
  runtime: {
    getURL: (path) => `chrome-extension://test-extension/${path}`,
    onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
    onStartup: { addListener: (fn) => listeners.startup.push(fn) },
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
  },
};

const { isPeak } = await import('../src/schedule.js');
await import('../src/background.js');
await new Promise((resolve) => setTimeout(resolve, 900));

let failures = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !extra ? '' : ` → ${extra}`}`);
};

const peak = isPeak(new Date());
const imageCall = iconCalls.find((c) => c.kind === 'imageData');

check('путь пробовали дважды (есть повтор)', pathAttempts.count === 2, `попыток: ${pathAttempts.count}`);
check('сработал фолбэк на imageData', Boolean(imageCall));
check(
  'imageData содержит все размеры 16/32/48/128',
  JSON.stringify(imageCall?.sizes) === JSON.stringify(SIZES.map(String)),
  JSON.stringify(imageCall?.sizes),
);
check(
  'imageData каждого размера корректного размера',
  SIZES.every((s) => imageCall?.value?.[s]?.width === s && imageCall?.value?.[s]?.height === s),
);
check(`бейдж выставлен несмотря на сбой иконки (${peak ? 'PEAK' : 'OFF'})`, badgeText === (peak ? 'PEAK' : 'OFF'), String(badgeText));
check('цвет бейджа выставлен', badgeColor === (peak ? '#EF4444' : '#22C55E'), String(badgeColor));
check('подсказка выставлена', /DeepSeek API/.test(title || ''), String(title));
check('переход на imageData залогирован один раз', infos.filter((m) => m.includes('imageData')).length === 1, JSON.stringify(infos));
check('console.error не вызывался (фолбэк сработал)', errors.length === 0, JSON.stringify(errors));

// Повторный refresh (как по alarm/onInstalled) не должен снова биться в сбойный путь.
listeners.installed[0]();
await new Promise((resolve) => setTimeout(resolve, 300));
check('режим imageData закреплён: новых попыток по пути нет', pathAttempts.count === 2, `попыток: ${pathAttempts.count}`);
check('повторный refresh использовал imageData', iconCalls.at(-1)?.kind === 'imageData');

console.log(failures ? `\n${failures} проверок не прошло` : '\nФолбэк иконки работает как задумано');
process.exit(failures ? 1 : 0);
