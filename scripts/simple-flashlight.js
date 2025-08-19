/*
Простой обработчик фонариков:
- Ищет в описании предмета фрагмент вида:
  <p>Источник света<br>Дальность освещения: 30</p>
- Если предмет экипирован, добавляет свет токену владельца; если снят — убирает.

Дополнительно (необязательно, можно на отдельных строках в том же <p>):
- Цвет: #ff8800 | rgb(255,136,0) | 255,136,0
- Анимация: torch | pulse | chroma | wave | fog | sunburst | energy | ghost | swirl | bubbles (также русские варианты: факел, пульс, хрома, волна, туман, солнце, энергия, призрак, вихрь, пузыри)
- Скорость: 5 (0..10)
- Интенсивность: 5 (0..10)
- Угол: 360 (1..360)
- Прозрачность: 0.55 (0..1) — общая «яркость» свечения

Упрощения:
- Нет кнопок включить/выключить — работает строго по статусу надет/снят.
- Если экипировано несколько источников, радиусы берутся по максимуму, а цвет/анимация наследуются от «доминирующего» источника (с наибольшей дальностью).
*/

class SimpleFlashlight {
  static MODULE_ID = 'simple-flashlight';

  static init() {
    Hooks.on('updateItem', this._onUpdateItem.bind(this));
    Hooks.on('updateActor', this._onUpdateActor.bind(this));
    Hooks.once('ready', () => this._initialRefresh());
    this._registerSettings();
  }

  static _registerSettings() {
    try {
      game.settings.registerMenu(this.MODULE_ID, 'generator', {
        name: 'Генератор описания света',
        label: 'Открыть генератор',
        icon: 'fas fa-lightbulb',
        type: SimpleFlashlightGenerator,
        restricted: false
      });

      game.settings.register(this.MODULE_ID, 'generatorState', {
        name: 'Состояние генератора',
        scope: 'client',
        config: false,
        type: Object,
        default: {}
      });
    } catch (e) { /* ignore */ }
  }

  static async _onUpdateItem(item, diff) {
    try {
      if (!item?.parent) return;
      const actor = item.parent;
      if (!actor?.isOwner) return;
      // Срабатываем только если поменялась экипировка или описание
      const equippedChanged = foundry.utils.hasProperty(diff, 'system.equipped');
      const descChanged =
        foundry.utils.hasProperty(diff, 'system.description') ||
        foundry.utils.hasProperty(diff, 'system.description.value');
      if (!equippedChanged && !descChanged) return;
      await this._refreshActor(actor);
    } catch (e) { console.error('[SimpleFlashlight] updateItem error', e); }
  }

  static async _onUpdateActor(actor, changes) {
    try {
      if (!actor?.isOwner) return;
      if (!changes?.items && !changes?.system?.traits) return;
      await this._refreshActor(actor);
    } catch (e) { console.error('[SimpleFlashlight] updateActor error', e); }
  }

  static async _initialRefresh() {
    try {
      // Только локально обновляем свои актёры, чтобы не гонять обновления всем
      for (const actor of game.actors?.contents || []) {
        try { if (actor.isOwner) await this._refreshActor(actor); } catch (_) {}
      }
    } catch (e) { console.error('[SimpleFlashlight] initialRefresh error', e); }
  }

  static _parseLightFromItem(item) {
    try {
      let description = '';
      const sys = item?.system || item?.data?.system || {};
      if (sys.description) description = sys.description.value || sys.description;
      else if (item?.data?.data?.description) description = item.data.data.description;
      if (!description || typeof description !== 'string') return null;

      // Быстрые проверки текста — сохраняем переносы строк для корректного парсинга по строкам
      const plain = SimpleFlashlight._toPlainText(description);
      if (!/(Источник\s+света)/i.test(plain)) return null;

      // ЕДИНЫЙ ФОРМАТ: "Дальность освещения (футы)." + отдельные строки Яркий: N и Тусклый: N
      let bright = NaN;
      let dim = NaN;
      const mB = plain.match(/Ярк[а-яё]*\s*:\s*(\d{1,5})/i);
      const mD = plain.match(/Тускл[а-яё]*\s*:\s*(\d{1,5})/i);
      if (mB) bright = parseInt(mB[1], 10);
      if (mD) dim = parseInt(mD[1], 10);

      // Фолбэк для старого формата на всякий случай ("Дальность освещения: N")
      if (!Number.isFinite(dim) || dim <= 0) {
        let range = NaN;
        const mRange = plain.match(/Дальность\s*(?:\(\s*футы\s*\))?(?:\s*освещения)?\s*:\s*(\d{1,5})/i);
        if (mRange) range = parseInt(mRange[1], 10);
        if (Number.isFinite(range) && range > 0) dim = range;
      }
      if (!Number.isFinite(dim) || dim <= 0) return null;
      if (!Number.isFinite(bright) || bright <= 0) bright = Math.max(1, Math.floor(dim * 0.6));
      if (bright > dim) bright = dim;

      // Дополнительные параметры
      const angle = this._extractInt(plain, /Угол\s*:\s*(\d{1,3})/i, 360, 1, 360);
      const alpha = this._extractFloat(plain, /(Прозрачность|Alpha|Альфа|Яркость|Насыщенность)\s*:\s*([0-9]*\.?[0-9]+)/i, 0.0, 0, 1);

      const colorStr = this._extractString(plain, /Цвет\s*:\s*([^\n]+)/i);
      const color = this._parseColor(colorStr);

      const animStr = this._extractString(plain, /Анимация\s*:\s*([^\n]+)/i);
      const animType = this._normalizeAnimation(animStr);
      const animSpeed = this._extractInt(plain, /Скорость\s*:\s*(\d{1,2})/i, 5, 0, 10);
      const animIntensity = this._extractInt(plain, /Интенсивность\s*:\s*(\d{1,2})/i, 5, 0, 10);

      return {
        bright: bright,
        dim: dim,
        angle,
        color: color,
        alpha,
        animation: { type: animType, speed: animSpeed, intensity: animIntensity }
      };
    } catch (e) {
      console.warn('[SimpleFlashlight] parse error for', item?.name, e);
      return null;
    }
  }

  static async _refreshActor(actor) {
    try {
      const tokens = actor.getActiveTokens();
      if (!tokens?.length) return;

      // Собираем все экипированные источники света по упрощённому описанию
      const equipped = [];
      for (const item of actor.items) {
        if (!item?.system?.equipped) continue;
        const light = this._parseLightFromItem(item);
        if (light) equipped.push(light);
      }

      // Комбинируем простым максимумом параметров
      const combined = this._combine(equipped);
      for (const token of tokens) {
        await token.document.update({ light: combined });
      }
    } catch (e) { console.error('[SimpleFlashlight] _refreshActor error', e); }
  }

  static _combine(list) {
    if (!list || list.length === 0) return this._none();
    if (list.length === 1) return list[0];
    const max = (arr, key) => Math.max(...arr.map(o => Number(o?.[key] || 0)));
    const maxDim = max(list, 'dim');
    // Доминирующий источник — с максимальной дальностью (берём первый из таковых)
    const dominant = list.find(l => Number(l?.dim || 0) === maxDim) || list[0];
    return {
      bright: max(list, 'bright'),
      dim: maxDim,
      angle: list.some(l => Number(l?.angle) === 360) ? 360 : max(list, 'angle'),
      color: dominant?.color ?? null,
      alpha: Math.min(1, max(list, 'alpha')),
      animation: dominant?.animation?.type ? {
        type: dominant.animation.type,
        speed: Number.isFinite(Number(dominant.animation.speed)) ? Number(dominant.animation.speed) : 5,
        intensity: Number.isFinite(Number(dominant.animation.intensity)) ? Number(dominant.animation.intensity) : 5
      } : { type: null, speed: 5, intensity: 5 }
    };
  }

  static _none() {
    return { bright: 0, dim: 0, angle: 360, color: null, alpha: 0, animation: { type: null, speed: 5, intensity: 5 } };
  }

  static _toPlainText(html) {
    try {
      // Заменяем <br> и закрытие параграфа на переводы строк, затем убираем прочие теги
      const withBreaks = String(html)
        .replace(/<\s*br\s*\/?>/gi, '\n')
        .replace(/<\s*\/p\s*>/gi, '\n')
        .replace(/<\s*p\s*>/gi, '')
        .replace(/&nbsp;/gi, ' ');
      const noTags = withBreaks.replace(/<[^>]+>/g, '');
      return noTags
        .split(/\n+/)
        .map(s => s.trim())
        .filter(Boolean)
        .join('\n');
    } catch (_) { return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').trim(); }
  }

  static _extractInt(text, regex, fallback, min, max) {
    try {
      const m = text.match(regex);
      if (!m) return fallback;
      const n = parseInt(m[1], 10);
      if (!Number.isFinite(n)) return fallback;
      return Math.max(min, Math.min(max, n));
    } catch (_) { return fallback; }
  }

  static _extractFloat(text, regex, fallback, min, max) {
    try {
      const m = text.match(regex);
      if (!m) return fallback;
      const raw = m[2] ?? m[1];
      const n = parseFloat(String(raw).replace(',', '.'));
      if (!Number.isFinite(n)) return fallback;
      return Math.max(min, Math.min(max, n));
    } catch (_) { return fallback; }
  }

  static _extractString(text, regex) {
    try {
      const m = text.match(regex);
      if (!m) return '';
      return String((m[1] ?? '').trim());
    } catch (_) { return '';
    }
  }

  static _parseColor(value) {
    if (!value || typeof value !== 'string') return null;
    const v = value.trim().toLowerCase();
    // #RGB or #RRGGBB
    const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hex) {
      const h = hex[1];
      if (h.length === 3) {
        const r = h[0]; const g = h[1]; const b = h[2];
        return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
      }
      return `#${h}`.toLowerCase();
    }
    // rgb(...) or rgba(...)
    const rgbFunc = v.match(/^rgba?\((\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([0-9.]+))?\)$/i);
    if (rgbFunc) {
      const r = this._clamp255(parseInt(rgbFunc[1], 10));
      const g = this._clamp255(parseInt(rgbFunc[2], 10));
      const b = this._clamp255(parseInt(rgbFunc[3], 10));
      return this._rgbToHex(r, g, b);
    }
    // r,g,b list
    const rgbList = v.match(/^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})$/);
    if (rgbList) {
      const r = this._clamp255(parseInt(rgbList[1], 10));
      const g = this._clamp255(parseInt(rgbList[2], 10));
      const b = this._clamp255(parseInt(rgbList[3], 10));
      return this._rgbToHex(r, g, b);
    }
    // несколько распространённых имён цветов
    const named = {
      white: '#ffffff',
      black: '#000000',
      red: '#ff0000',
      green: '#00ff00',
      blue: '#0000ff',
      orange: '#ffa500',
      yellow: '#ffff00',
      purple: '#800080',
      pink: '#ffc0cb'
    };
    if (named[v]) return named[v];
    return null;
  }

  static _clamp255(n) { return Math.max(0, Math.min(255, Number.isFinite(n) ? n : 0)); }
  static _to2(n) { const s = n.toString(16); return s.length === 1 ? `0${s}` : s; }
  static _rgbToHex(r, g, b) { return `#${this._to2(r)}${this._to2(g)}${this._to2(b)}`; }

  static _normalizeAnimation(value) {
    if (!value || typeof value !== 'string') return null;
    const v = value.trim().toLowerCase();
    // Поддержка вариантов вида LIGHT.AnimationTorch и др.
    const m = v.match(/light\.?animation([a-z]+)/i);
    if (m && m[1]) return m[1].toLowerCase();
    const map = new Map([
      ['факел', 'flame'],
      ['flame', 'flame'],
      ['пламя', 'flame'],
      ['огонь', 'flame'],
      ['мерцающий', 'torch'],
      ['мерцающий свет', 'torch'],
      ['torch', 'torch'],
      ['пульс', 'pulse'],
      ['pulse', 'pulse'],
      ['хрома', 'chroma'],
      ['хроматический', 'chroma'],
      ['chroma', 'chroma'],
      ['радуга', 'chroma'],
      ['rainbow', 'chroma'],
      ['волна', 'wave'],
      ['wave', 'wave'],
      ['туман', 'fog'],
      ['fog', 'fog'],
      ['солнце', 'sunburst'],
      ['sunburst', 'sunburst'],
      ['энергия', 'energy'],
      ['energy', 'energy'],
      ['призрак', 'ghost'],
      ['ghost', 'ghost'],
      ['вихрь', 'swirl'],
      ['закрутка', 'swirl'],
      ['swirl', 'swirl'],
      ['пузыри', 'bubbles'],
      ['bubbles', 'bubbles'],
      // доп. типы, встречающиеся в системах/модулях
      ['вихрь света', 'vortex'],
      ['vortex', 'vortex'],
      ['вращающийся', 'revolving'],
      ['revolving', 'revolving'],
      ['дым', 'smokepatch'],
      ['smoke', 'smokepatch'],
      ['smokepatch', 'smokepatch'],
      ['звездный', 'starlight'],
      ['звёздный', 'starlight'],
      ['starlight', 'starlight'],
      ['гекс', 'hexa'],
      ['hexa', 'hexa'],
      ['купол', 'dome'],
      ['dome', 'dome'],
      ['радужный вихрь', 'rainbowswirl'],
      ['rainbowswirl', 'rainbowswirl'],
      ['синус', 'sine'],
      ['sine', 'sine'],
      ['сетка', 'grid'],
      ['grid', 'grid'],
      ['фея', 'fairy'],
      ['fairy', 'fairy'],
      ['излучение', 'emanation'],
      ['emanation', 'emanation'],
      ['flame', 'flame'],
      ['ведьмина волна', 'witchwave'],
      ['witchwave', 'witchwave'],
      ['сигнальный маяк', 'siren'],
      ['маяк', 'siren'],
      ['siren', 'siren'],
      ['круговая радуга', 'radialrainbow'],
      ['radialrainbow', 'radialrainbow']
    ]);
    const t = map.get(v) || v.replace(/[^a-z]/g, '');
    // Разрешаем простые латинские имена, иначе null
    return /^[a-z]{3,}$/.test(t) ? t : null;
  }
}

class SimpleFlashlightGenerator extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: 'simple-flashlight-generator',
      classes: ['simple-flashlight', 'sheet'],
      title: 'Генератор описания света',
      template: 'modules/simple-flashlight/templates/generator.hbs',
      width: 520,
      height: 'auto'
    });
  }

  getData() {
    const saved = game.settings.get(SimpleFlashlight.MODULE_ID, 'generatorState') || {};
    const animationsCfg = (CONFIG?.Canvas?.lightAnimations) || {};
    const types = Object.keys(animationsCfg);
    const list = types.map(t => {
      const labelKey = animationsCfg[t]?.label || t;
      const label = (game.i18n?.localize?.(labelKey) || labelKey);
      return { value: t, label, selected: (t === (saved.anim || 'flame')) };
    });
    return {
      animations: list,
      values: {
        range: Number.isFinite(saved.range) ? saved.range : 40,
        color: typeof saved.color === 'string' ? saved.color : '#ff8a00',
        anim: typeof saved.anim === 'string' ? saved.anim : 'flame',
        speed: Number.isFinite(saved.speed) ? saved.speed : 7,
        intensity: Number.isFinite(saved.intensity) ? saved.intensity : 6,
        angle: Number.isFinite(saved.angle) ? saved.angle : 360,
        alpha: Number.isFinite(saved.alpha) ? saved.alpha : 0
      }
    };
  }

  activateListeners(html) {
    super.activateListeners(html);
    const root = html[0];
    const $root = $(root);

    const syncColor = () => {
      const t = root.querySelector('input[name="colorText"]');
      const p = root.querySelector('input[name="colorPicker"]');
      if (t && p) {
        const v = String(t.value || '').trim();
        if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) p.value = v.length === 4 ? `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}` : v;
      }
    };
    const syncColorBack = () => {
      const t = root.querySelector('input[name="colorText"]');
      const p = root.querySelector('input[name="colorPicker"]');
      if (t && p) t.value = p.value;
    };

    $root.on('input', 'input, select', () => this._updatePreview(root));
    $root.on('input', 'input[name="colorText"]', syncColor);
    $root.on('input', 'input[name="colorPicker"]', syncColorBack);

    $root.on('click', '.sf-copy', async (ev) => {
      ev.preventDefault();
      const ta = root.querySelector('.sf-output');
      const text = ta?.value || '';
      try { await navigator.clipboard.writeText(text); ui.notifications?.info('Скопировано в буфер обмена'); }
      catch (_) {
        try { ta?.select(); document.execCommand('copy'); ui.notifications?.info('Скопировано'); } catch (e) {}
      }
    });

    this._updatePreview(root);
  }

  _updatePreview(root) {
    const getNumber = (sel, def, min, max) => {
      const el = root.querySelector(sel); if (!el) return def;
      let n = parseFloat(String(el.value).replace(',', '.'));
      if (!Number.isFinite(n)) n = def;
      if (min !== undefined) n = Math.max(min, n);
      if (max !== undefined) n = Math.min(max, n);
      if (sel.includes('[type="number"]')) el.value = String(n);
      return n;
    };
    const getStr = (sel, def='') => { const el = root.querySelector(sel); return (el && String(el.value || '').trim()) || def; };

    // Единый формат: генерируем строки для Яркий/Тусклый, без отдельной дальности числа
    const defaultRange = 40;
    let brightManual = getNumber('input[name="bright"]', NaN, 1, 9999);
    let dimManual = getNumber('input[name="dim"]', NaN, 1, 9999);
    const color = getStr('input[name="colorText"]', '#ff8a00');
    const anim = getStr('select[name="anim"]', 'flame');
    const speed = getNumber('input[name="speed"]', 7, 0, 10);
    const intensity = getNumber('input[name="intensity"]', 6, 0, 10);
    const angle = getNumber('input[name="angle"]', 360, 1, 360);
    const alpha = getNumber('input[name="alpha"]', 0, 0, 1);

    const animLabel = SimpleFlashlightGenerator._displayNameForAnimation(anim);

    if (!Number.isFinite(dimManual)) dimManual = defaultRange;
    if (!Number.isFinite(brightManual)) brightManual = Math.max(1, Math.floor(dimManual * 0.6));
    if (brightManual > dimManual) brightManual = dimManual;

    const lines = [
      'Источник света',
      `Дальность освещения (футы).`,
      `Яркий: ${Math.round(brightManual)}`,
      `Тусклый: ${Math.round(dimManual)}`,
      `Цвет: ${color}`,
      `Анимация: ${animLabel}`,
      `Скорость: ${Math.round(speed)}`,
      `Интенсивность: ${Math.round(intensity)}`,
      ...(angle !== 360 ? [`Угол: ${Math.round(angle)}`] : []),
      ...(alpha > 0 ? [`Прозрачность: ${alpha}`] : [])
    ];
    const html = `<p>${lines.join('<br>')}</p>`;
    const ta = root.querySelector('.sf-output');
    if (ta) ta.value = html;

    // persist state
    try {
      game.settings.set(SimpleFlashlight.MODULE_ID, 'generatorState', {
        range: dimManual, color, anim, speed, intensity, angle, alpha,
        bright: brightManual, dim: dimManual
      });
    } catch (_) { /* ignore */ }
  }

  static _displayNameForAnimation(type) {
    try {
      const cfg = CONFIG?.Canvas?.lightAnimations?.[type];
      const labelKey = cfg?.label || type;
      return game.i18n?.localize?.(labelKey) || labelKey;
    } catch (_) { return type; }
  }
}

Hooks.once('init', () => SimpleFlashlight.init());


