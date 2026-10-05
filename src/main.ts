import './style.css';
import type { Evaluation, LatLon, Lang, Person, Place, SpotType, Weights } from './types';
import { SPOT_TYPES } from './types';
import { detectLang, num, setLang, t, type Key } from './i18n';
import { load, newPerson, normalize, PRESETS, save, type AppState } from './store';
import { buildShareUrl, packLeg, clearSharedFromUrl, decodePayload, sharedFromUrl, unpackLeg, type SharedPayload } from './share';
import { MapView, personColor } from './ui/map';
import { $, debounce, esc } from './ui/dom';
import { Engine, type Progress, type SolveResult } from './solver/engine';
import { searchAddress, reverseGeocode } from './services/pdok';
import { formatTime } from './solver/scoring';
import { error as logError, log, pendingSummary } from './log';

// ---------------------------------------------------------------- state

let state: AppState = load(detectLang());
setLang(state.lang);
const persist = debounce(() => {
  save(state);
  // Once the user changes something, the address bar should no longer claim to be the shared plan.
  clearSharedFromUrl();
  fromLink = false;
}, 300);

const engine = new Engine();
let result: SolveResult | null = null;
let selected: string | null = null;
let tab: 'route' | 'priorities' | 'results' = 'route';
let busy = false;
/** Results came from a share link (no live search done yet). */
let fromLink = false;
let runId = 0;

const mapView = new MapView($('#map'));

const SPOT_ICON: Record<SpotType, string> = {
  cafe: '☕',
  park: '🌳',
  square: '⛲',
  landmark: '🏛️',
  station: '🚉',
  bikeshop: '🔧',
  generic: '📍',
};

const pinSvg =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>';

const riderName = (p: Person, i: number) => p.name.trim() || t('riderN', { n: i + 1 });
const ready = () =>
  !!state.settings.destination && state.people.filter((p) => p.home).length >= 2;
const activePeople = () => state.people.filter((p) => p.home);

// ---------------------------------------------------------------- rendering

function renderStatic() {
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n as Key);
  });
  document.title = `${t('appTitle')} – ${t('tagline')}`;
  document.querySelectorAll<HTMLButtonElement>('[data-lang]').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.lang === state.lang)),
  );
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.mode === state.settings.mode)),
  );
  $('#mode-hint').textContent = t(state.settings.mode === 'morning' ? 'morningHint' : 'eveningHint');
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) =>
    b.setAttribute('aria-selected', String(b.dataset.tab === tab)),
  );
  document.querySelectorAll<HTMLElement>('.tab').forEach((s) => (s.hidden = s.id !== `tab-${tab}`));
  renderSolveButton();
}

function renderSolveButton() {
  const btn = $('#solve-btn') as HTMLButtonElement;
  btn.disabled = busy;
  btn.textContent = busy ? t('searching') : t(state.settings.mode === 'morning' ? 'findSpots' : 'findSplit');
}

function addressField(target: string, place: Place | null, placeholder: string) {
  return `<div class="addr" data-target="${target}">
    <div class="addr-row">
      <input type="search" autocomplete="off" enterkeyhint="search" placeholder="${esc(placeholder)}"
        value="${esc(place?.label ?? '')}" aria-label="${esc(placeholder)}" />
      <button class="icon" data-action="pick" title="${esc(t('pickOnMap'))}" aria-label="${esc(t('pickOnMap'))}">${pinSvg}</button>
    </div>
    <ul class="suggest" hidden></ul>
  </div>`;
}

function renderRoute() {
  const s = state.settings;
  const morning = s.mode === 'morning';
  const people = state.people
    .map(
      (p, i) => `<div class="person card" data-id="${p.id}" style="--c:${personColor(i)}">
      <div class="person-head">
        <span class="dot" aria-hidden="true">${esc(riderName(p, i).charAt(0).toUpperCase())}</span>
        <input class="name" data-field="name" value="${esc(p.name)}" placeholder="${esc(t('riderN', { n: i + 1 }))}" aria-label="${esc(t('name'))}" />
        <button class="icon ghost" data-action="remove" title="${esc(t('remove'))}" aria-label="${esc(t('remove'))}" ${state.people.length <= 1 ? 'disabled' : ''}>✕</button>
      </div>
      ${addressField(p.id, p.home, `${t('home')}: ${t('searchAddress')}`)}
      <div class="person-opts">
        <label class="fit">
          <span>${esc(t('fitness'))}: <b data-fitlabel>${esc(t(`fitness${p.fitness}` as Key))}</b></span>
          <input type="range" min="1" max="5" step="1" value="${p.fitness}" data-field="fitness" />
        </label>
        <label class="numfield">
          <span>${esc(t('speed'))}</span>
          <span class="unit"><input type="number" inputmode="decimal" min="8" max="40" step="1" value="${p.speed}" data-field="speed" /> ${esc(t('kmh'))}</span>
        </label>
        <label class="numfield">
          <span>${esc(t('maxDetour'))}</span>
          <span class="unit"><input type="number" inputmode="decimal" min="0" max="50" step="0.5" value="${p.maxDetourKm ?? ''}" placeholder="–" data-field="maxDetourKm" title="${esc(t('noLimit'))}" /> ${esc(t('km'))}</span>
        </label>
      </div>
    </div>`,
    )
    .join('');

  $('#tab-route').innerHTML = `
    <div class="card dest-card">
      <h2>${esc(t(morning ? 'destination' : 'destinationEvening'))}</h2>
      ${addressField('dest', s.destination, t('searchAddress'))}
      <label class="inline">
        <span>${esc(t(morning ? 'arriveBy' : 'leaveAt'))}</span>
        <input type="time" value="${esc(s.time)}" data-setting="time" />
      </label>
    </div>
    <h2 class="section">${esc(t('riders'))}</h2>
    <div class="people">${people}</div>
    <div class="row-actions">
      <button class="secondary" data-action="add">＋ ${esc(t('addRider'))}</button>
      <button class="ghost small" data-action="reset">${esc(t('reset'))}</button>
    </div>`;
}

function slider(k: keyof Weights, label: Key, help: Key, lo?: Key, hi?: Key) {
  const v = Math.round(state.settings.weights[k] * 100);
  return `<div class="slider">
    <label for="w-${k}"><b>${esc(t(label))}</b><output>${v}%</output></label>
    <input id="w-${k}" type="range" min="0" max="100" step="5" value="${v}" data-weight="${k}" />
    ${lo && hi ? `<div class="ends"><span>${esc(t(lo))}</span><span>${esc(t(hi))}</span></div>` : ''}
    <p class="help">${esc(t(help))}</p>
  </div>`;
}

function renderPriorities() {
  const s = state.settings;
  const presets = Object.keys(PRESETS)
    .map((k) => {
      const active = (Object.keys(PRESETS[k]) as (keyof Weights)[]).every(
        (w) => Math.abs(PRESETS[k][w] - s.weights[w]) < 0.001,
      );
      return `<button class="chip" data-preset="${k}" aria-pressed="${active}">${esc(t(k as Key))}</button>`;
    })
    .join('');
  const spots = SPOT_TYPES.map(
    (st) => `<label class="check"><input type="checkbox" data-spot="${st}" ${s.spotTypes[st] ? 'checked' : ''} />
      <span>${SPOT_ICON[st]} ${esc(t(`spot_${st}` as Key))}</span></label>`,
  ).join('');
  $('#tab-priorities').innerHTML = `
    <h2 class="section">${esc(t('presets'))}</h2>
    <div class="chips">${presets}</div>
    <div class="card">
      ${slider('fairness', 'wFairness', 'wFairnessHelp', 'wFairnessLo', 'wFairnessHi')}
      ${slider('together', 'wTogether', 'wTogetherHelp')}
      ${slider('spot', 'wSpot', 'wSpotHelp')}
      ${slider('green', 'wGreen', 'wGreenHelp')}
      ${slider('fitness', 'wFitness', 'wFitnessHelp')}
    </div>
    <h2 class="section">${esc(t('spotTypes'))}</h2>
    <div class="checks">${spots}</div>
    <details class="card advanced">
      <summary>${esc(t('advanced'))}</summary>
      <label class="inline"><span>${esc(t('groupPace'))}</span>
        <select data-setting="groupPace">
          <option value="slowest" ${s.groupPace === 'slowest' ? 'selected' : ''}>${esc(t('paceSlowest'))}</option>
          <option value="average" ${s.groupPace === 'average' ? 'selected' : ''}>${esc(t('paceAverage'))}</option>
        </select></label>
      <label class="inline"><span>${esc(t('numOptions'))}</span>
        <input type="number" min="1" max="8" value="${s.options}" data-setting="options" /></label>
      <label class="inline"><span>${esc(t('waitBuffer'))}</span>
        <input type="number" min="0" max="15" value="${s.waitBuffer}" data-setting="waitBuffer" /></label>
    </details>`;
}

function personLine(e: Evaluation, i: number) {
  const pr = e.people[i];
  const p = activePeople()[i];
  if (!p) return '';
  const morning = state.settings.mode === 'morning';
  const bits = [
    `<b>${esc(t(morning ? 'leaves' : 'arrives', { t: formatTime(pr.homeTime) }))}</b>`,
    esc(t('rides', { km: num(pr.totalKm) })),
    pr.detourKm < 0.05
      ? esc(t('noDetour'))
      : `<span class="${pr.overLimit ? 'bad' : ''}">${esc(t('detour', { km: num(pr.detourKm) }))}${pr.overLimit ? ` · ${esc(t('overLimit'))}` : ''}</span>`,
  ];
  if (pr.green != null) bits.push(esc(t('green', { p: Math.round(pr.green * 100) })));
  const idx = state.people.indexOf(p);
  return `<li style="--c:${personColor(idx)}"><span class="pdot" aria-hidden="true"></span>
    <span class="who">${esc(riderName(p, idx))}</span><span class="what">${bits.join(' · ')}</span></li>`;
}

/** Opening-hours line for cafés etc.: open at the meetup time on workdays? */
function hoursLine(e: Evaluation) {
  const c = e.candidate;
  if (c.type !== 'cafe' && c.type !== 'bikeshop') return '';
  const time = formatTime(e.meetTime);
  const raw = c.hours ? `<span class="raw">${esc(t('hoursRaw', { h: c.hours }))}</span>` : '';
  const open = e.openWorkdays;
  if (!open) return `<p class="hours unknown">🕒 ${esc(c.hours ? t('hoursRaw', { h: c.hours }) : t('hoursUnknown'))}</p>`;
  const n = open.filter(Boolean).length;
  if (n === open.length) return `<p class="hours ok">🕒 ${esc(t('openAll', { t: time }))}${raw}</p>`;
  if (n === 0) return `<p class="hours bad">🕒 ${esc(t('closedAll', { t: time }))}${raw}</p>`;
  // 1 Jan 2024 was a Monday.
  const fmt = new Intl.DateTimeFormat(state.lang === 'nl' ? 'nl-NL' : 'en-GB', { weekday: 'short' });
  const days = open.flatMap((o, d) => (o ? [fmt.format(new Date(2024, 0, 1 + d))] : [])).join(', ');
  return `<p class="hours some">🕒 ${esc(t('openSome', { t: time, days }))}${raw}</p>`;
}

function optionCard(e: Evaluation, i: number) {
  const c = e.candidate;
  const morning = state.settings.mode === 'morning';
  const isSel = c.id === selected;
  const sc = e.score;
  const row = (k: Key, v: number, sign: string) =>
    `<tr><td>${esc(t(k))}</td><td>${sign}${num(Math.abs(v), 2)} ${esc(t('kmEq'))}</td></tr>`;
  const title = c.name ?? `${t(`spot_${c.type}` as Key)}`;
  const meta = [
    `${SPOT_ICON[c.type]} ${esc(t(`spot_${c.type}` as Key))}`,
    esc(t(morning ? 'meetAt' : 'splitAt', { t: formatTime(e.meetTime) })),
    esc(t('together', { km: num(e.sharedKm) })),
  ];
  if (e.green != null) meta.push(esc(t('green', { p: Math.round(e.green * 100) })));
  return `<article class="option card${isSel ? ' selected' : ''}" data-id="${c.id}" tabindex="0">
    <header>
      <span class="num${c.custom ? ' custom' : ''}">${c.custom ? '★' : i + 1}</span>
      <div class="titles">
        <h3>${esc(title)}</h3>
        <p class="meta">${meta.join(' · ')}</p>
        ${hoursLine(e)}
      </div>
      ${i === 0 && !c.custom ? `<span class="tag">${esc(t('best'))}</span>` : ''}
      ${c.custom ? `<span class="tag alt">${esc(t('custom'))}</span>` : ''}
    </header>
    <ul class="plist">${e.people.map((_, j) => personLine(e, j)).join('')}</ul>
    <details class="why">
      <summary>${esc(t('scoreWhy'))}</summary>
      <table>
        ${row('effort', sc.effort, '+')}
        ${row('togetherBonus', sc.togetherBonus, '−')}
        ${row('spotBonus', sc.spotBonus, '−')}
        ${row('greenBonus', sc.greenBonus, '−')}
        ${sc.limitPenalty > 0 ? row('limitPenalty', sc.limitPenalty, '+') : ''}
        <tr class="total"><td>${esc(t('total'))}</td><td>${num(sc.total, 2)}</td></tr>
      </table>
    </details>
    <div class="opt-actions">
      <button class="small secondary" data-action="copy">${esc(t('copyPlan'))}</button>
      <a class="small ghost btn" target="_blank" rel="noopener" href="https://www.openstreetmap.org/?mlat=${c.lat.toFixed(6)}&mlon=${c.lon.toFixed(6)}#map=18/${c.lat.toFixed(6)}/${c.lon.toFixed(6)}">OSM</a>
      <a class="small ghost btn" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${c.lat.toFixed(6)},${c.lon.toFixed(6)}">Google Maps</a>
      ${c.custom ? `<button class="small ghost" data-action="remove-custom">${esc(t('remove'))}</button>` : ''}
    </div>
  </article>`;
}

function renderResults() {
  const el = $('#tab-results');
  const badge = $('#results-badge');
  if (!result) {
    el.innerHTML = `<p class="empty">${esc(t('noResults'))}</p>`;
    badge.hidden = true;
    return;
  }
  badge.hidden = false;
  badge.textContent = String(result.options.length);
  const stale = engine.isStale(activePeople(), state.settings);
  const warnings = result.warnings.map((w) => `<p class="warn">⚠️ ${esc(t(w as Key))}</p>`).join('');
  el.innerHTML = `
    ${stale ? `<p class="warn">↻ ${esc(t('staleHint'))}</p>` : ''}
    ${fromLink && !stale ? `<p class="note">🔗 ${esc(t('sharedNote'))}</p>` : ''}
    ${warnings}
    ${result.options.length ? '' : `<p class="empty">${esc(t('noOptions'))}</p>`}
    <div class="options">${result.options.map(optionCard).join('')}</div>
    <div class="row-actions">
      <button class="secondary" data-action="try-own" ${stale ? 'disabled' : ''}>📍 ${esc(t('tryOwn'))}</button>
      <button class="ghost small" data-action="share">🔗 ${esc(t('share'))}</button>
    </div>`;
}

function renderMap(fit = false) {
  mapView.drawBase(state.people, state.settings.destination, onMarkerDrag);
  if (result) {
    mapView.drawCandidates(result.all);
    mapView.drawOptions(result.options, selected, selectOption);
    mapView.drawRoutes(selected ? result.legs.get(selected) : undefined);
  } else mapView.clearResults();
  if (fit) {
    const pts: LatLon[] = [...activePeople().map((p) => p.home!)];
    if (state.settings.destination) pts.push(state.settings.destination);
    mapView.fitTo(pts);
  }
}

function renderAll() {
  renderStatic();
  renderRoute();
  renderPriorities();
  renderResults();
}

function setStatus(msg: string, kind: 'info' | 'error' = 'info') {
  const el = $('#status');
  el.textContent = msg;
  el.className = `status ${msg ? kind : ''}`;
}

// ---------------------------------------------------------------- actions

function setTab(next: typeof tab) {
  const switched = next !== tab;
  tab = next;
  renderStatic();
  if (!switched) return;
  // Show the new tab from its top instead of keeping the previous tab's scroll position.
  const diff = $(`#tab-${tab}`).getBoundingClientRect().top - $('.tabs').getBoundingClientRect().bottom - 8;
  if (diff < 0) {
    const scroller = matchMedia('(max-width: 800px)').matches ? window : $('.panel-scroll');
    scroller.scrollBy(0, diff);
  }
}

function changed(structure = false) {
  persist();
  if (structure) renderRoute();
  if (result) renderResults();
  renderMap();
}

function selectOption(id: string) {
  selected = id;
  renderResults();
  renderMap();
  const legs = result?.legs.get(id);
  if (legs) {
    const pts = [...legs.shared.coords, ...legs.person.flatMap((l) => l.coords)].map(([lat, lon]) => ({ lat, lon }));
    mapView.fitTo(pts);
  }
  if (tab !== 'results') setTab('results');
  document.querySelector(`.option[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

const progress: Progress = (stage, detail) => {
  log('stage', stage, detail);
  const msg: Record<string, string> = {
    pois: t('stagePois'),
    matrix: t('stageMatrix'),
    routes: t('stageRoutes', { n: detail ?? '' }),
    green: t('stageGreen'),
    done: '',
  };
  setStatus(msg[stage]);
};

async function run(task: () => Promise<SolveResult>) {
  const id = ++runId;
  busy = true;
  renderSolveButton();
  const started = performance.now();
  log('run', `#${id} started`);
  // Every 5 s, report what we're still waiting on.
  const heartbeat = setInterval(() => {
    const p = pendingSummary();
    log('run', `#${id} still running after ${((performance.now() - started) / 1000).toFixed(0)}s; status "${$('#status').textContent}"; pending: ${p.length ? p.join(', ') : 'none (queued, sleeping between retries, or computing)'}`);
  }, 5000);
  try {
    const r = await task();
    log('run', `#${id} finished in ${((performance.now() - started) / 1000).toFixed(1)}s${id !== runId ? ' (superseded, ignored)' : ''}`);
    if (id !== runId) return;
    result = r;
    if (!selected || !r.options.some((o) => o.candidate.id === selected)) selected = r.options[0]?.candidate.id ?? null;
    setStatus(engine.greenPending ? t('stageGreen') : '');
    renderResults();
    renderMap();
  } catch (e) {
    logError('run', `#${id} failed`, e);
    if (id === runId) setStatus(t('errorGeneric', { msg: e instanceof Error ? e.message : String(e) }), 'error');
  } finally {
    clearInterval(heartbeat);
    if (id === runId) {
      busy = false;
      renderSolveButton();
    }
  }
}

async function solve() {
  if (!ready()) {
    setStatus(t('needInputs'), 'error');
    setTab('route');
    return;
  }
  selected = null;
  fromLink = false;
  clearSharedFromUrl();
  setTab('results');
  renderMap(true);
  await run(() => engine.solve(activePeople(), state.settings, progress));
  if (selected) selectOption(selected);
}

/** Weights changed: instant local re-rank, then (debounced) detail any new top options. */
const refineLater = debounce(() => {
  if (!result || engine.isStale(activePeople(), state.settings)) return;
  void run(() => engine.refine(state.settings, progress));
}, 700);

function weightsChanged() {
  persist();
  if (!result || engine.isStale(activePeople(), state.settings)) return;
  result = engine.rescore(state.settings);
  if (!result.options.some((o) => o.candidate.id === selected)) selected = result.options[0]?.candidate.id ?? null;
  renderResults();
  renderMap();
  refineLater();
}

engine.onBackgroundUpdate = () => {
  log('run', 'late greenery arrived; re-ranking');
  if (!busy) setStatus('');
  weightsChanged();
};

function startPick(text: string, cb: (p: LatLon) => void) {
  $('#pick-text').textContent = text;
  $('#pick-banner').hidden = false;
  document.body.classList.add('picking');
  // On phones the map sits above the panel: bring it into view.
  $('.map-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
  mapView.setPick((p) => {
    endPick();
    cb(p);
  });
}

function endPick() {
  $('#pick-banner').hidden = true;
  document.body.classList.remove('picking');
  mapView.setPick(null);
}

async function setPlace(target: string, p: LatLon, label?: string) {
  const place: Place = { lat: p.lat, lon: p.lon, label: label ?? `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}` };
  if (target === 'dest') state.settings.destination = place;
  else {
    const person = state.people.find((x) => x.id === target);
    if (person) person.home = place;
  }
  changed(true);
  if (!label) {
    const name = await reverseGeocode(p.lat, p.lon);
    if (name) {
      place.label = name;
      persist();
      renderRoute();
    }
  }
}

function onMarkerDrag(target: string, p: LatLon) {
  void setPlace(target, p);
}

function copyPlan(e: Evaluation) {
  const morning = state.settings.mode === 'morning';
  const people = activePeople();
  const place = e.candidate.name ?? `${e.candidate.lat.toFixed(5)}, ${e.candidate.lon.toFixed(5)}`;
  const lines = [
    `🚲 ${t('plan')}`,
    t(morning ? 'planMeet' : 'planSplit', { place, t: formatTime(e.meetTime) }),
    ...e.people.map((pr, i) =>
      t(morning ? 'planLeave' : 'planHome', {
        name: riderName(people[i], state.people.indexOf(people[i])),
        t: formatTime(pr.homeTime),
        km: num(pr.totalKm),
      }),
    ),
    `https://www.openstreetmap.org/?mlat=${e.candidate.lat.toFixed(6)}&mlon=${e.candidate.lon.toFixed(6)}#map=18/${e.candidate.lat.toFixed(6)}/${e.candidate.lon.toFixed(6)}`,
  ];
  return lines.join('\n');
}

/** Share link with the inputs and, when up to date, the computed options and routes. */
async function share(btn: HTMLElement) {
  const payload: SharedPayload = { v: 2, state: { people: state.people, settings: state.settings } };
  if (result && !engine.isStale(activePeople(), state.settings)) {
    const r = result;
    payload.result = {
      direct: engine.directDistances,
      selected,
      options: r.options.flatMap((o) => {
        const legs = r.legs.get(o.candidate.id);
        return legs ? [{ c: o.candidate, p: legs.person.map(packLeg), s: packLeg(legs.shared) }] : [];
      }),
    };
  }
  const url = await buildShareUrl(payload);
  log('share', `link with ${payload.result ? `${payload.result.options.length} options` : 'inputs only'}: ${url.length} characters`);
  // A ready-to-send message; the link goes inside the text because share targets
  // treat a separate `url` inconsistently (WhatsApp on Android appends it, some drop it).
  const opt = payload.result && result?.options.find((o) => o.candidate.id === selected);
  const msg = opt
    ? t(state.settings.mode === 'morning' ? 'shareMsgMorning' : 'shareMsgEvening', {
        place: opt.candidate.name ?? t(`spot_${opt.candidate.type}` as Key),
        time: formatTime(opt.meetTime),
      })
    : t('shareMsgPlain');
  const text = `${msg}\n${url}`;
  // Phones: the native share sheet (WhatsApp, Signal, …); elsewhere: copy the message.
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ title: t('appTitle'), text });
      return;
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
    }
  }
  await copyText(text, btn);
}

async function copyText(text: string, btn?: HTMLElement) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const old = btn.textContent;
      btn.textContent = t('copied');
      setTimeout(() => (btn.textContent = old), 1500);
    }
  } catch {
    prompt('', text);
  }
}

// ---------------------------------------------------------------- address search

const searchCtl = new Map<string, AbortController>();
const doSearch = debounce(async (input: HTMLInputElement, list: HTMLUListElement) => {
  const q = input.value.trim();
  const target = input.closest<HTMLElement>('.addr')!.dataset.target!;
  searchCtl.get(target)?.abort();
  if (q.length < 3) {
    list.hidden = true;
    return;
  }
  const ctl = new AbortController();
  searchCtl.set(target, ctl);
  try {
    const places = await searchAddress(q, ctl.signal);
    list.innerHTML = places
      .map(
        (p, i) =>
          `<li role="option" tabindex="-1" data-i="${i}" data-lat="${p.lat}" data-lon="${p.lon}">${esc(p.label)}</li>`,
      )
      .join('');
    list.hidden = places.length === 0;
  } catch {
    list.hidden = true;
  }
}, 250);

function choose(li: HTMLElement) {
  const addr = li.closest<HTMLElement>('.addr')!;
  void setPlace(addr.dataset.target!, { lat: Number(li.dataset.lat), lon: Number(li.dataset.lon) }, li.textContent ?? '');
  renderMap(true);
}

// ---------------------------------------------------------------- events

window.addEventListener('error', (e) => logError('window', 'uncaught error', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => logError('window', 'unhandled rejection', e.reason));
log('app', `loaded (${state.lang}, ${state.people.length} riders, mode ${state.settings.mode})`);

document.querySelectorAll<HTMLButtonElement>('[data-lang]').forEach((b) =>
  b.addEventListener('click', () => {
    state.lang = b.dataset.lang as Lang;
    setLang(state.lang);
    persist();
    renderAll();
  }),
);

document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) =>
  b.addEventListener('click', () => {
    const mode = b.dataset.mode as 'morning' | 'evening';
    if (mode === state.settings.mode) return;
    state.settings.mode = mode;
    state.settings.time = mode === 'morning' ? '08:45' : '17:30';
    persist();
    renderAll();
  }),
);

document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) =>
  b.addEventListener('click', () => setTab(b.dataset.tab as typeof tab)),
);

$('#solve-btn').addEventListener('click', () => void solve());
$('#pick-cancel').addEventListener('click', endPick);
$('#privacy-btn').addEventListener('click', () => ($('#privacy-dialog') as HTMLDialogElement).showModal());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') endPick();
});

// Riders tab
const routeTab = $('#tab-route');
routeTab.addEventListener('input', (e) => {
  const el = e.target as HTMLInputElement;
  if (el.closest('.addr') && el.type === 'search') {
    doSearch(el, el.closest('.addr')!.querySelector('.suggest')!);
    return;
  }
  if (el.dataset.setting === 'time') {
    state.settings.time = el.value;
    persist();
    if (result) weightsChanged();
    return;
  }
  const card = el.closest<HTMLElement>('.person');
  const person = card && state.people.find((p) => p.id === card.dataset.id);
  if (!person || !el.dataset.field) return;
  const f = el.dataset.field;
  if (f === 'name') {
    person.name = el.value;
    const i = state.people.indexOf(person);
    card!.querySelector('.dot')!.textContent = riderName(person, i).charAt(0).toUpperCase();
    persist();
    mapView.drawBase(state.people, state.settings.destination, onMarkerDrag);
    return;
  }
  if (f === 'fitness') {
    person.fitness = Number(el.value);
    card!.querySelector('[data-fitlabel]')!.textContent = t(`fitness${person.fitness}` as Key);
  } else if (f === 'speed') {
    const v = Number(el.value);
    if (v > 0) person.speed = v;
  } else if (f === 'maxDetourKm') person.maxDetourKm = el.value === '' ? null : Math.max(0, Number(el.value));
  weightsChanged();
});
routeTab.addEventListener('change', (e) => {
  const el = e.target as HTMLInputElement;
  if (el.dataset.field === 'name' && result) renderResults();
});
routeTab.addEventListener('keydown', (e) => {
  const el = e.target as HTMLElement;
  if (!(el instanceof HTMLInputElement) || el.type !== 'search') return;
  const list = el.closest('.addr')!.querySelector<HTMLUListElement>('.suggest')!;
  if (e.key === 'Enter') {
    e.preventDefault();
    const first = list.querySelector<HTMLElement>('li');
    if (first && !list.hidden) choose(first);
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    list.querySelector<HTMLElement>('li')?.focus();
  }
});
routeTab.addEventListener('focusout', (e) => {
  const addr = (e.target as HTMLElement).closest('.addr');
  if (!addr) return;
  // Delay so a click on a suggestion still lands.
  setTimeout(() => {
    if (!addr.contains(document.activeElement)) (addr.querySelector('.suggest') as HTMLElement).hidden = true;
  }, 200);
});
routeTab.addEventListener('click', (e) => {
  const el = e.target as HTMLElement;
  const li = el.closest<HTMLElement>('.suggest li');
  if (li) return choose(li);
  const btn = el.closest<HTMLElement>('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'add') {
    state.people.push(newPerson());
    changed(true);
    routeTab.querySelector<HTMLInputElement>('.person:last-child input.name')?.focus();
  } else if (action === 'reset') {
    if (!confirm(t('resetConfirm'))) return;
    const lang = state.lang;
    localStorage.removeItem('bike2gather:v1');
    state = load(lang);
    state.lang = lang;
    result = null;
    selected = null;
    renderAll();
    renderMap();
  } else if (action === 'remove') {
    const id = btn.closest<HTMLElement>('.person')!.dataset.id;
    state.people = state.people.filter((p) => p.id !== id);
    changed(true);
  } else if (action === 'pick') {
    const target = btn.closest<HTMLElement>('.addr')!.dataset.target!;
    startPick(t('pickHint'), (p) => void setPlace(target, p));
  }
});
routeTab.addEventListener('keydown', (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>('.suggest li');
  if (!li) return;
  if (e.key === 'Enter') choose(li);
  else if (e.key === 'ArrowDown') (li.nextElementSibling as HTMLElement | null)?.focus();
  else if (e.key === 'ArrowUp') {
    e.preventDefault();
    const prev = li.previousElementSibling as HTMLElement | null;
    if (prev) prev.focus();
    else li.closest('.addr')!.querySelector('input')!.focus();
  }
});

// Priorities tab
const prioTab = $('#tab-priorities');
prioTab.addEventListener('input', (e) => {
  const el = e.target as HTMLInputElement;
  const w = el.dataset.weight as keyof Weights | undefined;
  if (w) {
    state.settings.weights[w] = Number(el.value) / 100;
    el.parentElement!.querySelector('output')!.textContent = `${el.value}%`;
    prioTab.querySelectorAll<HTMLElement>('[data-preset]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
    weightsChanged();
  }
});
prioTab.addEventListener('change', (e) => {
  const el = e.target as HTMLInputElement;
  if (el.dataset.spot) {
    state.settings.spotTypes[el.dataset.spot as SpotType] = el.checked;
    weightsChanged();
  } else if (el.dataset.setting === 'groupPace') {
    state.settings.groupPace = el.value as 'slowest' | 'average';
    weightsChanged();
  } else if (el.dataset.setting === 'options') {
    state.settings.options = Math.min(8, Math.max(1, Number(el.value) || 4));
    weightsChanged();
  } else if (el.dataset.setting === 'waitBuffer') {
    state.settings.waitBuffer = Math.min(15, Math.max(0, Number(el.value) || 0));
    weightsChanged();
  }
});
prioTab.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-preset]');
  if (!b) return;
  state.settings.weights = { ...PRESETS[b.dataset.preset!] };
  renderPriorities();
  weightsChanged();
});

// Results tab
const resultsTab = $('#tab-results');
resultsTab.addEventListener('click', (e) => {
  const el = e.target as HTMLElement;
  const btn = el.closest<HTMLElement>('[data-action]');
  const card = el.closest<HTMLElement>('.option');
  const opt = card && result?.options.find((o) => o.candidate.id === card.dataset.id);
  if (btn?.dataset.action === 'copy' && opt) return void copyText(copyPlan(opt), btn);
  if (btn?.dataset.action === 'remove-custom' && opt) {
    engine.removeCustom(opt.candidate.id);
    result = engine.rescore(state.settings);
    if (selected === opt.candidate.id) selected = result.options[0]?.candidate.id ?? null;
    renderResults();
    renderMap();
    return;
  }
  if (btn?.dataset.action === 'try-own') {
    startPick(t('tryOwnHint'), (p) => void run(() => engine.addCustom(p, state.settings, progress)));
    return;
  }
  if (btn?.dataset.action === 'share') {
    if (confirm(t('shareWarn'))) void share(btn);
    return;
  }
  if (el.closest('a, summary, details table')) return;
  if (card) selectOption(card.dataset.id!);
});
resultsTab.addEventListener('keydown', (e) => {
  const card = (e.target as HTMLElement).closest<HTMLElement>('.option');
  if (card && e.target === card && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    selectOption(card.dataset.id!);
  }
});

// Keep the map sized correctly when the layout changes (rotation, desktop resize).
new ResizeObserver(() => mapView.invalidate()).observe($('#map'));

renderAll();
renderMap(true);
void initShared();

/** Open a share link: apply its inputs and, if present, show its pre-computed options. */
async function initShared() {
  const data = sharedFromUrl();
  if (!data) return;
  const p = await decodePayload(data);
  if (!p) {
    logError('share', 'could not read the shared link');
    return;
  }
  // Keep the recipient's own language.
  state = normalize({ ...p.state, lang: state.lang }, state.lang);
  save(state);
  result = null;
  selected = null;
  if (p.result?.options.length) {
    engine.hydrate(
      activePeople(),
      state.settings,
      p.result.direct,
      p.result.options.map((o) => ({ candidate: o.c, legs: { person: o.p.map(unpackLeg), shared: unpackLeg(o.s) } })),
    );
    result = engine.rescore(state.settings);
    const sel = p.result.selected;
    selected = sel && result.options.some((o) => o.candidate.id === sel) ? sel : (result.options[0]?.candidate.id ?? null);
    fromLink = true;
    tab = 'results';
  }
  log('share', `opened link: ${state.people.length} riders, ${result ? result.options.length : 0} pre-computed options`);
  renderAll();
  renderMap(true);
  if (selected) selectOption(selected);
}

