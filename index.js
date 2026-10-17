const MODULE_ID = "ability-fusion-engine";
const INTERCEPTOR_NAME = "AbilityFusion_interceptGeneration";
const SETTINGS_URL = new URL("./settings.html", import.meta.url);
const DATA_URL = new URL("./data/abilities.json", import.meta.url);

const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  selectedIds: [],
});

const CATEGORY_LABELS = Object.freeze({
  ability: "能力",
  cultivation: "功法",
  skill: "技能",
  system: "系统",
});

const FALLBACK_ABILITIES = [
  {
    id: "fallback-starter",
    category: "ability",
    name: "示例外挂",
    work: "本地降级数据",
    tags: ["示例"],
    description: "资料文件读取失败时仍可用来测试选择流程。",
    prompt: "外挂能力：示例外挂。请把它视为用户设定的一部分，并保持前后一致。",
  },
];

let abilities = [];
let dataLoadError = "";
let panelRoot = null;
let panelShell = null;
let launcherButton = null;
let launcherClickHandler = null;
let documentKeyHandler = null;
let runtimeActive = true;
let hostSubscriptions = [];
let domSubscriptions = [];
const activeInjections = [];

function getContext() {
  const context = globalThis.SillyTavern?.getContext?.();
  if (!context) throw new Error(`[${MODULE_ID}] SillyTavern context is unavailable`);
  return context;
}

function getSettings() {
  const context = getContext();
  context.extensionSettings ??= {};
  const current = context.extensionSettings[MODULE_ID] ?? {};
  const selectedIds = Array.isArray(current.selectedIds)
    ? [...new Set(current.selectedIds.filter((id) => typeof id === "string"))]
    : [];
  context.extensionSettings[MODULE_ID] = {
    ...DEFAULT_SETTINGS,
    ...current,
    selectedIds,
  };
  return context.extensionSettings[MODULE_ID];
}

function saveSettings() {
  getContext().saveSettingsDebounced?.();
}

function initializeSettings() {
  getSettings();
  saveSettings();
}

function subscribeDom(target, type, handler) {
  target.addEventListener(type, handler);
  domSubscriptions.push({ target, type, handler });
}

function clearDomSubscriptions() {
  for (const { target, type, handler } of domSubscriptions.splice(0)) {
    target.removeEventListener(type, handler);
  }
}

function subscribeHost(eventName, handler) {
  if (!eventName) return;
  const eventSource = getContext().eventSource;
  if (!eventSource) return;
  if (typeof eventSource.on === "function") {
    eventSource.on(eventName, handler);
    hostSubscriptions.push({ eventSource, eventName, handler, method: "on" });
  } else if (typeof eventSource.addListener === "function") {
    eventSource.addListener(eventName, handler);
    hostSubscriptions.push({ eventSource, eventName, handler, method: "addListener" });
  }
}

function clearHostSubscriptions() {
  for (const subscription of hostSubscriptions.splice(0)) {
    const { eventSource, eventName, handler, method } = subscription;
    if (method === "on" && typeof eventSource.off === "function") eventSource.off(eventName, handler);
    else if (typeof eventSource.removeListener === "function") eventSource.removeListener(eventName, handler);
  }
}

function findHostEvent(name) {
  return getContext().event_types?.[name];
}

function bindHostEvents() {
  clearHostSubscriptions();
  const appReady = findHostEvent("APP_READY");
  const generationEnded = findHostEvent("GENERATION_ENDED");
  const generationStopped = findHostEvent("GENERATION_STOPPED");
  const messageReceived = findHostEvent("MESSAGE_RECEIVED");
  subscribeHost(appReady, mountLauncher);
  subscribeHost(generationEnded, cleanupInjectedMessages);
  subscribeHost(generationStopped, cleanupInjectedMessages);
  subscribeHost(messageReceived, cleanupInjectedMessages);
}

function normalizeAbilities(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item.id === "string" && typeof item.name === "string" && typeof item.prompt === "string")
    .map((item) => ({
      id: item.id,
      category: Object.hasOwn(CATEGORY_LABELS, item.category) ? item.category : "ability",
      name: item.name,
      work: typeof item.work === "string" ? item.work : "未标注作品",
      tags: Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === "string").slice(0, 6) : [],
      description: typeof item.description === "string" ? item.description : "暂无说明。",
      prompt: item.prompt,
      source: item.source && typeof item.source.label === "string"
        ? { status: item.source.status ?? "unverified", label: item.source.label }
        : { status: "unverified", label: "来源未标注" },
    }));
}

async function loadAbilities() {
  try {
    const response = await fetch(DATA_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const loaded = normalizeAbilities(await response.json());
    if (!loaded.length) throw new Error("empty ability data");
    abilities = loaded;
    dataLoadError = "";
  } catch (error) {
    abilities = FALLBACK_ABILITIES;
    dataLoadError = `资料文件暂时读不到，已切换到本地示例。${error instanceof Error ? `（${error.message}）` : ""}`;
  }
}

function selectedAbilities() {
  const settings = getSettings();
  const byId = new Map(abilities.map((ability) => [ability.id, ability]));
  return settings.selectedIds.map((id) => byId.get(id)).filter(Boolean);
}

function setPanelError(message) {
  if (!panelRoot) return;
  const error = panelRoot.querySelector("#afe-error");
  if (!error) return;
  error.textContent = message;
  error.hidden = !message;
}

function setStatus(message) {
  panelRoot?.querySelector("#afe-status")?.replaceChildren(document.createTextNode(message));
}

function setSelected(id, selected) {
  const settings = getSettings();
  const next = settings.selectedIds.filter((item) => item !== id);
  if (selected) next.push(id);
  settings.selectedIds = [...new Set(next)];
  saveSettings();
  renderPanel();
  setStatus(selected ? "已加入外挂，下次生成会带上它。" : "已取消外挂，下次生成不再带上它。");
}

function isSelected(id) {
  return getSettings().selectedIds.includes(id);
}

function createTag(text) {
  const tag = document.createElement("span");
  tag.className = "afe-tag";
  tag.textContent = text;
  return tag;
}

function createAbilityCard(ability) {
  const card = document.createElement("article");
  const selected = isSelected(ability.id);
  card.className = `afe-card${selected ? " is-selected" : ""}`;

  const top = document.createElement("div");
  top.className = "afe-card-top";
  const category = document.createElement("span");
  category.className = `afe-card-category afe-category-${ability.category}`;
  category.textContent = CATEGORY_LABELS[ability.category];
  top.append(category);
  const source = document.createElement("span");
  source.className = "afe-tag";
  source.textContent = ability.source.label;
  top.append(source);
  for (const tag of ability.tags) top.append(createTag(tag));

  const title = document.createElement("h4");
  title.textContent = ability.name;
  const work = document.createElement("p");
  work.className = "afe-card-work";
  work.textContent = ability.work;
  const description = document.createElement("p");
  description.className = "afe-card-description";
  description.textContent = ability.description;

  const action = document.createElement("button");
  action.type = "button";
  action.className = "afe-card-action";
  action.setAttribute("aria-pressed", String(selected));
  action.textContent = selected ? "已加入" : "加入外挂";
  subscribeDom(action, "click", () => setSelected(ability.id, !isSelected(ability.id)));

  const footer = document.createElement("div");
  footer.className = "afe-card-footer";
  footer.append(work, action);
  card.append(top, title, description, footer);
  return card;
}

function filterAbilities() {
  const search = panelRoot.querySelector("#afe-search").value.trim().toLowerCase();
  const category = panelRoot.querySelector(".afe-category.is-active")?.dataset.category ?? "all";
  const work = panelRoot.querySelector("#afe-work-filter").value;
  const selectedOnly = panelRoot.querySelector("#afe-selected-filter").getAttribute("aria-pressed") === "true";
  return abilities.filter((ability) => {
    const searchable = [ability.name, ability.work, ability.description, ability.prompt, ...ability.tags].join(" ").toLowerCase();
    return (category === "all" || ability.category === category)
      && (!work || ability.work === work)
      && (!selectedOnly || isSelected(ability.id))
      && (!search || searchable.includes(search));
  });
}

function renderCategoryCounts() {
  const counts = { all: abilities.length, ability: 0, cultivation: 0, skill: 0, system: 0 };
  for (const ability of abilities) counts[ability.category] += 1;
  for (const [key, count] of Object.entries(counts)) {
    const target = panelRoot.querySelector(`[data-count="${key}"]`);
    if (target) target.textContent = String(count);
  }
}

function renderWorkOptions() {
  const select = panelRoot.querySelector("#afe-work-filter");
  const current = select.value;
  select.replaceChildren(new Option("全部作品", ""));
  for (const work of [...new Set(abilities.map((ability) => ability.work))].sort((a, b) => a.localeCompare(b))) {
    select.append(new Option(work, work));
  }
  select.value = current;
}

function renderResults() {
  const results = panelRoot.querySelector("#afe-results");
  const empty = panelRoot.querySelector("#afe-empty");
  const filtered = filterAbilities();
  results.replaceChildren(...filtered.map(createAbilityCard));
  panelRoot.querySelector("#afe-results-count").textContent = `${filtered.length} 条`;
  empty.hidden = filtered.length > 0;
}

function renderLoadout() {
  const selected = selectedAbilities();
  const list = panelRoot.querySelector("#afe-loadout-list");
  const empty = panelRoot.querySelector("#afe-loadout-empty");
  list.replaceChildren();
  for (const ability of selected) {
    const item = document.createElement("div");
    item.className = "afe-loadout-item";
    const copy = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = ability.name;
    const source = document.createElement("small");
    source.textContent = `${CATEGORY_LABELS[ability.category]} · ${ability.work}`;
    copy.append(name, source);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "afe-remove-button";
    remove.setAttribute("aria-label", `取消 ${ability.name}`);
    remove.textContent = "×";
    subscribeDom(remove, "click", () => setSelected(ability.id, false));
    item.append(copy, remove);
    list.append(item);
  }
  empty.hidden = selected.length > 0;
  panelRoot.querySelector("#afe-loadout-count").textContent = String(selected.length);
  panelRoot.querySelector("#afe-selected-filter-count").textContent = String(selected.length);
  panelRoot.querySelector("#afe-token-estimate").textContent = `${selected.reduce((total, ability) => total + ability.prompt.length, 0)} 字`;
}

function renderMasterSwitch() {
  const enabled = getSettings().enabled === true;
  panelRoot.querySelector("#afe-enabled").checked = enabled;
  panelRoot.querySelector("#afe-master-state").textContent = enabled ? "正在注入" : "已关闭";
}

function renderPanel() {
  if (!panelRoot) return;
  clearDomSubscriptions();
  renderCategoryCounts();
  renderWorkOptions();
  renderMasterSwitch();
  renderResults();
  renderLoadout();
  setPanelError(dataLoadError);

  subscribeDom(panelRoot.querySelector("#afe-enabled"), "change", (event) => {
    getSettings().enabled = event.target.checked;
    saveSettings();
    renderMasterSwitch();
    setStatus(event.target.checked ? "外挂注入已开启。" : "外挂注入已关闭。选择仍会保留。" );
  });
  subscribeDom(panelRoot.querySelector("#afe-search"), "input", refreshPanel);
  subscribeDom(panelRoot.querySelector("#afe-work-filter"), "change", refreshPanel);
  subscribeDom(panelRoot.querySelector("#afe-selected-filter"), "click", (event) => {
    const next = event.currentTarget.getAttribute("aria-pressed") !== "true";
    event.currentTarget.setAttribute("aria-pressed", String(next));
    event.currentTarget.classList.toggle("is-active", next);
    refreshPanel();
  });
  for (const button of panelRoot.querySelectorAll(".afe-category")) {
    subscribeDom(button, "click", () => {
      for (const item of panelRoot.querySelectorAll(".afe-category")) {
        const active = item === button;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-pressed", String(active));
      }
      refreshPanel();
    });
  }

  const closeButton = panelRoot.querySelector("#afe-close");
  if (closeButton) subscribeDom(closeButton, "click", closePanel);
}

function refreshPanel() {
  if (!panelRoot) return;
  renderPanel();
}

function mountLauncher() {
  if (launcherButton || !runtimeActive) return;
  const host = document.querySelector("#leftSendForm, #send_form");
  if (!host) return;

  launcherButton = document.createElement("button");
  launcherButton.type = "button";
  launcherButton.id = "afe-launcher";
  launcherButton.className = "afe-launcher menu_button";
  launcherButton.title = "打开外挂能力聚合引擎";
  launcherButton.setAttribute("aria-label", "打开外挂能力聚合引擎");
  launcherButton.setAttribute("aria-controls", "afe-panel-shell");
  launcherButton.setAttribute("aria-expanded", "false");
  launcherButton.innerHTML = '<i class="fa-solid fa-wand-sparkles" aria-hidden="true"></i>';
  launcherClickHandler = () => {
    if (panelShell?.hidden === false) closePanel();
    else openPanel();
  };
  launcherButton.addEventListener("click", launcherClickHandler);

  const reference = host.querySelector("#options_button, #extensionsMenuButton, .extensionsMenuButton");
  if (reference) reference.insertAdjacentElement("afterend", launcherButton);
  else host.prepend(launcherButton);
}

async function openPanel() {
  if (!runtimeActive) return;
  if (!panelRoot) await mountPanel();
  if (!panelShell) return;
  panelShell.hidden = false;
  launcherButton?.setAttribute("aria-expanded", "true");
  documentKeyHandler ??= (event) => {
    if (event.key === "Escape") closePanel();
  };
  document.addEventListener("keydown", documentKeyHandler);
  panelRoot.querySelector("#afe-search")?.focus();
}

function closePanel() {
  if (!panelShell) return;
  panelShell.hidden = true;
  launcherButton?.setAttribute("aria-expanded", "false");
  if (documentKeyHandler) document.removeEventListener("keydown", documentKeyHandler);
}

async function mountPanel() {
  if (panelRoot || !runtimeActive) return;
  try {
    const context = getContext();
    let html;
    if (typeof context.renderExtensionTemplateAsync === "function") {
      try {
        html = await context.renderExtensionTemplateAsync("third-party/ability-fusion-engine", "settings");
      } catch {
        html = null;
      }
    }
    if (!html) {
      html = await (async () => {
        const response = await fetch(SETTINGS_URL, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })();
    }
    const fragment = document.createRange().createContextualFragment(html);
    panelRoot = fragment.querySelector("#afe-panel");
    if (!panelRoot) throw new Error("settings template is missing #afe-panel");
    panelShell = document.createElement("div");
    panelShell.id = "afe-panel-shell";
    panelShell.className = "afe-panel-shell";
    panelShell.hidden = true;
    panelShell.setAttribute("role", "dialog");
    panelShell.setAttribute("aria-modal", "true");
    panelShell.setAttribute("aria-labelledby", "afe-title");
    panelShell.append(panelRoot);
    panelShell.addEventListener("click", (event) => {
      if (event.target === panelShell) closePanel();
    });
    document.body.append(panelShell);
    renderPanel();
    setPanelError(dataLoadError);
  } catch (error) {
    console.error(`[${MODULE_ID}] failed to mount settings panel`, error);
  }
}

function removePanel() {
  closePanel();
  clearDomSubscriptions();
  if (launcherButton && launcherClickHandler) launcherButton.removeEventListener("click", launcherClickHandler);
  launcherButton?.remove();
  launcherButton = null;
  launcherClickHandler = null;
  panelShell?.remove();
  panelShell = null;
  panelRoot = null;
}

function buildInjectionPrompt(selected) {
  const lines = selected.map((ability) => `- ${CATEGORY_LABELS[ability.category]}：${ability.name}（${ability.work}）\n  ${ability.prompt}`);
  return [
    "【外挂能力聚合引擎】",
    "以下内容是用户手动选择的外挂设定，请作为本次生成上下文的补充背景，保持与既有设定一致；不要替用户发言，不要擅自扩大能力，不要把本段说明当作剧情对白。",
    ...lines,
  ].join("\n");
}

function cleanupInjectedMessages() {
  for (const { chat, message } of activeInjections.splice(0)) {
    const index = chat.indexOf(message);
    if (index >= 0) chat.splice(index, 1);
  }
}

async function interceptGeneration(chat, contextSize, abort, type) {
  if (!runtimeActive || !Array.isArray(chat)) return;
  let settings;
  try {
    settings = getSettings();
  } catch (error) {
    console.warn(`[${MODULE_ID}] skipped injection because host context is unavailable`, error);
    return;
  }
  if (!settings.enabled || type === "quiet") return;
  const selected = selectedAbilities();
  if (!selected.length) return;
  cleanupInjectedMessages();
  const message = {
    is_user: false,
    is_system: true,
    name: "外挂能力聚合引擎",
    send_date: Date.now(),
    mes: buildInjectionPrompt(selected),
    extra: { abilityFusionEngine: true, isSmallSys: true },
  };
  let insertAt = chat.length;
  for (let index = chat.length - 1; index >= 0; index -= 1) {
    if (chat[index]?.is_user === true) {
      insertAt = index;
      break;
    }
  }
  chat.splice(insertAt, 0, message);
  activeInjections.push({ chat, message });
}

globalThis[INTERCEPTOR_NAME] = interceptGeneration;

export function onInstall() {
  initializeSettings();
}

export async function onActivate() {
  runtimeActive = true;
  globalThis[INTERCEPTOR_NAME] = interceptGeneration;
  initializeSettings();
  bindHostEvents();
  const start = async () => {
    await loadAbilities();
    mountLauncher();
  };
  if (document.readyState === "loading") subscribeDom(document, "DOMContentLoaded", start);
  else void start();
}

export async function onUpdate() {
  initializeSettings();
}

export function onEnable() {
  runtimeActive = true;
  bindHostEvents();
  loadAbilities().then(() => {
    mountLauncher();
  });
}

export function onDisable() {
  runtimeActive = false;
  cleanupInjectedMessages();
  clearHostSubscriptions();
  removePanel();
}

export function onDelete() {
  onDisable();
}

export function onClean() {
  const context = getContext();
  if (context.extensionSettings) delete context.extensionSettings[MODULE_ID];
  context.saveSettingsDebounced?.();
}
