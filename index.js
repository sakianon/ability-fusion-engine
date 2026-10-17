const MODULE_ID = "ability-fusion-engine";
const INTERCEPTOR_NAME = "AbilityFusion_interceptGeneration";
const SETTINGS_URL = new URL("./settings.html", import.meta.url);
const DATA_URL = new URL("./data/abilities.json", import.meta.url);

const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  selectedIds: [],
  customAbilities: [],
  abilityOverrides: {},
  deletedIds: [],
});

const PAGE_SIZE = 6;

const CATEGORY_LABELS = Object.freeze({
  ability: "能力",
  cultivation: "功法",
  skill: "技能",
  system: "系统",
});

const FALLBACK_ABILITIES = [];

let baseAbilities = [];
let abilities = [];
let dataLoadError = "";
let currentPage = 1;
let editingAbilityId = "";
let editorTrigger = null;
let detailAbilityId = "";
let detailTrigger = null;
let workOptionsExpanded = false;
let panelRoot = null;
let panelShell = null;
let menuEntry = null;
let menuEntryClickHandler = null;
let menuEntryKeyHandler = null;
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
  const customAbilities = Array.isArray(current.customAbilities)
    ? normalizeAbilities(current.customAbilities).map((ability) => ({
      ...ability,
      source: { status: "custom", label: "用户自定义" },
    }))
    : [];
  const deletedIds = Array.isArray(current.deletedIds)
    ? [...new Set(current.deletedIds.filter((id) => typeof id === "string"))]
    : [];
  const abilityOverrides = current.abilityOverrides && typeof current.abilityOverrides === "object"
    ? current.abilityOverrides
    : {};
  context.extensionSettings[MODULE_ID] = {
    ...DEFAULT_SETTINGS,
    ...current,
    selectedIds,
    customAbilities,
    abilityOverrides,
    deletedIds,
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
  const chatChanged = findHostEvent("CHAT_CHANGED");
  const generationEnded = findHostEvent("GENERATION_ENDED");
  const generationStopped = findHostEvent("GENERATION_STOPPED");
  const messageReceived = findHostEvent("MESSAGE_RECEIVED");
  subscribeHost(appReady, mountMenuEntry);
  subscribeHost(chatChanged, mountMenuEntry);
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
      source: item.source && typeof item.source === "object"
        ? {
          status: typeof item.source.status === "string" ? item.source.status : "unverified",
          label: typeof item.source.label === "string" ? item.source.label : "来源未标注",
        }
        : { status: "unverified", label: "来源未标注" },
    }));
}

function rebuildAbilities() {
  const settings = getSettings();
  const deletedIds = new Set(settings.deletedIds);
  const overrides = settings.abilityOverrides ?? {};
  const builtInAbilities = baseAbilities
    .filter((ability) => !deletedIds.has(ability.id))
    .map((ability) => {
      const override = overrides[ability.id];
      if (!override || typeof override !== "object") return ability;
      const edited = normalizeAbilities([{ ...ability, ...override, id: ability.id }])[0];
      return edited
        ? { ...edited, source: { status: "custom", label: "用户修改" } }
        : ability;
    });
  const customAbilities = normalizeAbilities(settings.customAbilities).map((ability) => ({
    ...ability,
    source: { status: "custom", label: "用户自定义" },
  }));
  abilities = [...builtInAbilities, ...customAbilities];
}

async function loadAbilities() {
  try {
    const response = await fetch(DATA_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const loaded = normalizeAbilities(await response.json());
    if (!loaded.length) throw new Error("empty ability data");
    baseAbilities = loaded;
    rebuildAbilities();
    dataLoadError = "";
  } catch (error) {
    baseAbilities = FALLBACK_ABILITIES;
    rebuildAbilities();
    dataLoadError = `资料文件暂时读不到，内置资料库暂时不可用。${error instanceof Error ? `（${error.message}）` : ""}`;
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
  const status = panelRoot?.querySelector("#afe-status");
  if (!status) return;
  status.replaceChildren(document.createTextNode(message));
  status.classList.remove("is-flashing");
  void status.offsetWidth;
  status.classList.add("is-flashing");
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

function getAbility(id) {
  return abilities.find((ability) => ability.id === id) ?? null;
}

function makeCustomId() {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  return `custom-${suffix}`;
}

function setEditorField(id, value) {
  const field = panelRoot?.querySelector(`#${id}`);
  if (field) field.value = value ?? "";
}

function openAbilityEditor(abilityId = "", trigger = null) {
  if (!panelRoot) return;
  editingAbilityId = abilityId;
  editorTrigger = trigger ?? document.activeElement;
  const ability = abilityId ? getAbility(abilityId) : null;
  const editorModal = panelRoot.querySelector("#afe-editor-modal");
  const editor = panelRoot.querySelector("#afe-editor");
  if (!editorModal || !editor) return;
  const scrollTop = panelRoot.scrollTop;
  editorModal.hidden = false;
  panelRoot.querySelector("#afe-editor-title").textContent = ability ? "编辑外挂条目" : "新建外挂条目";
  panelRoot.querySelector("#afe-editor-mode").textContent = ability
    ? (baseAbilities.some((item) => item.id === ability.id) ? "修改内置条目" : "修改自定义条目")
    : "用户资料库 / 新条目";
  setEditorField("afe-editor-category", ability?.category ?? "ability");
  setEditorField("afe-editor-name", ability?.name ?? "未命名外挂");
  setEditorField("afe-editor-work", ability?.work ?? "用户自定义");
  setEditorField("afe-editor-tags", ability?.tags?.join(", ") ?? "自定义");
  setEditorField("afe-editor-description", ability?.description ?? "描述这条外挂能做什么，以及它的边界。");
  setEditorField("afe-editor-prompt", ability?.prompt ?? "外挂能力：请在这里写入会注入给模型的完整设定，并明确限制条件。");
  panelRoot.querySelector("#afe-editor-name")?.focus({ preventScroll: true });
  panelRoot.scrollTop = scrollTop;
}

function closeAbilityEditor({ restoreFocus = true } = {}) {
  const trigger = editorTrigger;
  editingAbilityId = "";
  editorTrigger = null;
  const editorModal = panelRoot?.querySelector("#afe-editor-modal");
  if (editorModal) editorModal.hidden = true;
  if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
}

function renderAbilityDetails(ability) {
  if (!panelRoot || !ability) return;
  const category = panelRoot.querySelector("#afe-detail-category");
  const source = panelRoot.querySelector("#afe-detail-source");
  const work = panelRoot.querySelector("#afe-detail-work");
  const tags = panelRoot.querySelector("#afe-detail-tags");
  const description = panelRoot.querySelector("#afe-detail-description");
  const prompt = panelRoot.querySelector("#afe-detail-prompt");
  const action = panelRoot.querySelector("#afe-detail-action");
  if (category) {
    category.textContent = CATEGORY_LABELS[ability.category];
    category.className = `afe-card-category afe-category-${ability.category}`;
  }
  if (source) source.textContent = ability.source.label;
  if (work) work.textContent = ability.work;
  if (tags) tags.replaceChildren(...ability.tags.map(createTag));
  if (description) description.textContent = ability.description;
  if (prompt) prompt.textContent = ability.prompt;
  if (action) {
    const selected = isSelected(ability.id);
    action.textContent = selected ? "取消外挂" : "加入外挂";
    action.setAttribute("aria-pressed", String(selected));
  }
}

function openAbilityDetails(abilityId, trigger = null) {
  const ability = getAbility(abilityId);
  const modal = panelRoot?.querySelector("#afe-detail-modal");
  const title = panelRoot?.querySelector("#afe-detail-title");
  if (!ability || !modal || !title) return;
  const scrollTop = panelRoot.scrollTop;
  detailAbilityId = abilityId;
  detailTrigger = trigger ?? document.activeElement;
  title.textContent = ability.name;
  renderAbilityDetails(ability);
  modal.hidden = false;
  panelRoot.querySelector("#afe-detail-close")?.focus({ preventScroll: true });
  panelRoot.scrollTop = scrollTop;
}

function closeAbilityDetails({ restoreFocus = true } = {}) {
  const trigger = detailTrigger;
  detailAbilityId = "";
  detailTrigger = null;
  const modal = panelRoot?.querySelector("#afe-detail-modal");
  if (modal) modal.hidden = true;
  if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
}

function applyAbilityTemplate() {
  setEditorField("afe-editor-category", "ability");
  setEditorField("afe-editor-name", "新外挂名称");
  setEditorField("afe-editor-work", "用户自定义作品");
  setEditorField("afe-editor-tags", "标签一, 标签二");
  setEditorField("afe-editor-description", "用一句话说明这条外挂的作用、触发条件和不能做什么。");
  setEditorField("afe-editor-prompt", "外挂能力：新外挂名称。用户可以在明确条件下使用这项能力；请保持能力边界、代价和已知信息一致，不要把它写成无条件万能能力。");
  panelRoot?.querySelector("#afe-editor-name")?.focus();
  setStatus("已载入外挂条目模板，可以直接修改后保存。");
}

function readAbilityEditor() {
  const category = panelRoot?.querySelector("#afe-editor-category")?.value ?? "ability";
  const name = panelRoot?.querySelector("#afe-editor-name")?.value.trim() ?? "";
  const work = panelRoot?.querySelector("#afe-editor-work")?.value.trim() ?? "";
  const tags = (panelRoot?.querySelector("#afe-editor-tags")?.value ?? "")
    .split(/[,，、]/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 6);
  const description = panelRoot?.querySelector("#afe-editor-description")?.value.trim() ?? "";
  const prompt = panelRoot?.querySelector("#afe-editor-prompt")?.value.trim() ?? "";
  if (!name || !prompt) {
    setStatus("至少填写外挂名称和注入设定。");
    panelRoot?.querySelector(!name ? "#afe-editor-name" : "#afe-editor-prompt")?.focus();
    return null;
  }
  return {
    id: editingAbilityId || makeCustomId(),
    category: Object.hasOwn(CATEGORY_LABELS, category) ? category : "ability",
    name,
    work: work || "用户自定义",
    tags,
    description: description || "暂无说明。",
    prompt,
    source: { status: "custom", label: editingAbilityId ? "用户修改" : "用户自定义" },
  };
}

function saveAbilityFromEditor() {
  const draft = readAbilityEditor();
  if (!draft) return;
  const settings = getSettings();
  const isBuiltIn = baseAbilities.some((ability) => ability.id === draft.id);
  if (isBuiltIn) {
    settings.abilityOverrides[draft.id] = draft;
  } else {
    const next = settings.customAbilities.filter((ability) => ability.id !== draft.id);
    next.push(draft);
    settings.customAbilities = next;
  }
  saveSettings();
  rebuildAbilities();
  closeAbilityEditor();
  currentPage = 1;
  renderPanel();
  setStatus(isBuiltIn ? "外挂条目已修改并保存。" : "外挂条目已新增并保存。" );
}

function deleteAbility(id) {
  const ability = getAbility(id);
  if (!ability) return;
  if (!globalThis.confirm?.(`确定删除“${ability.name}”吗？`)) return;
  const settings = getSettings();
  const isBuiltIn = baseAbilities.some((item) => item.id === id);
  if (isBuiltIn) {
    settings.deletedIds = [...new Set([...settings.deletedIds, id])];
    delete settings.abilityOverrides[id];
  } else {
    settings.customAbilities = settings.customAbilities.filter((item) => item.id !== id);
  }
  settings.selectedIds = settings.selectedIds.filter((selectedId) => selectedId !== id);
  saveSettings();
  rebuildAbilities();
  currentPage = Math.max(1, currentPage - 1);
  renderPanel();
  setStatus("外挂条目已删除。");
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
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", `查看 ${ability.name} 的完整信息`);
  card.dataset.category = ability.category;
  card.dataset.selected = String(selected);
  subscribeDom(card, "click", (event) => {
    if (event.target.closest("button, a")) return;
    openAbilityDetails(ability.id, card);
  });
  subscribeDom(card, "keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (event.target !== card) return;
    event.preventDefault();
    openAbilityDetails(ability.id, card);
  });

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
  action.dataset.state = selected ? "selected" : "available";
  action.textContent = selected ? "已加入" : "加入外挂";
  subscribeDom(action, "click", () => setSelected(ability.id, !isSelected(ability.id)));

  const footer = document.createElement("div");
  footer.className = "afe-card-footer";
  const actions = document.createElement("div");
  actions.className = "afe-card-actions";
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "afe-card-edit";
  edit.setAttribute("aria-label", `编辑 ${ability.name}`);
  edit.textContent = "编辑";
  subscribeDom(edit, "click", () => openAbilityEditor(ability.id, edit));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "afe-card-delete";
  remove.setAttribute("aria-label", `删除 ${ability.name}`);
  remove.textContent = "删除";
  subscribeDom(remove, "click", () => deleteAbility(ability.id));
  actions.append(edit, remove, action);
  footer.append(work, actions);
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
  const selectedWork = panelRoot.querySelector("#afe-work-filter")?.value ?? "";
  const visibleAbilities = selectedWork
    ? abilities.filter((ability) => ability.work === selectedWork)
    : abilities;
  const counts = { all: visibleAbilities.length, ability: 0, cultivation: 0, skill: 0, system: 0 };
  for (const ability of visibleAbilities) counts[ability.category] += 1;
  for (const [key, count] of Object.entries(counts)) {
    const target = panelRoot.querySelector(`[data-count="${key}"]`);
    if (target) target.textContent = String(count);
  }
}

function renderWorkOptions() {
  const select = panelRoot.querySelector("#afe-work-filter");
  const toggle = panelRoot.querySelector("#afe-work-toggle");
  const currentLabel = panelRoot.querySelector("#afe-work-current");
  const options = panelRoot.querySelector("#afe-work-options");
  const current = select.value;
  const works = [...new Set(abilities.map((ability) => ability.work))].sort((a, b) => a.localeCompare(b));
  select.replaceChildren(new Option("全部作品", ""));
  for (const work of works) {
    select.append(new Option(work, work));
  }
  select.value = works.includes(current) ? current : "";
  if (toggle) toggle.setAttribute("aria-expanded", String(workOptionsExpanded));
  if (currentLabel) currentLabel.textContent = select.value || "全部作品";
  options.hidden = !workOptionsExpanded;
  options.replaceChildren();
  const allWorks = ["", ...works];
  for (const work of allWorks) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `afe-work-category${work === select.value ? " is-active" : ""}`;
    button.dataset.work = work;
    button.setAttribute("aria-pressed", String(work === select.value));
    button.textContent = work || "全部作品";
    options.append(button);
  }
}

function renderResults() {
  const results = panelRoot.querySelector("#afe-results");
  const empty = panelRoot.querySelector("#afe-empty");
  const filtered = filterAbilities();
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  currentPage = Math.min(currentPage, totalPages);
  const start = (currentPage - 1) * PAGE_SIZE;
  results.replaceChildren(...filtered.slice(start, start + PAGE_SIZE).map(createAbilityCard));
  panelRoot.querySelector("#afe-results-count").textContent = `${filtered.length} 条`;
  empty.hidden = filtered.length > 0;
  const pagination = panelRoot.querySelector("#afe-pagination");
  if (pagination) pagination.hidden = filtered.length <= PAGE_SIZE;
  const current = panelRoot.querySelector("#afe-page-current");
  const total = panelRoot.querySelector("#afe-page-total");
  const previous = panelRoot.querySelector("#afe-page-prev");
  const next = panelRoot.querySelector("#afe-page-next");
  if (current) current.textContent = String(currentPage);
  if (total) total.textContent = String(totalPages);
  if (previous) previous.disabled = currentPage <= 1;
  if (next) next.disabled = currentPage >= totalPages;
}

function renderLoadout() {
  const selected = selectedAbilities();
  const list = panelRoot.querySelector("#afe-loadout-list");
  const empty = panelRoot.querySelector("#afe-loadout-empty");
  list.replaceChildren();
  for (const ability of selected) {
    const item = document.createElement("div");
    item.className = "afe-loadout-item";
    item.dataset.category = ability.category;
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
  renderWorkOptions();
  renderCategoryCounts();
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
  subscribeDom(panelRoot.querySelector("#afe-work-toggle"), "click", () => {
    workOptionsExpanded = !workOptionsExpanded;
    renderPanel();
  });
  for (const button of panelRoot.querySelectorAll(".afe-work-category")) {
    subscribeDom(button, "click", () => {
      panelRoot.querySelector("#afe-work-filter").value = button.dataset.work;
      refreshPanel();
    });
  }
  subscribeDom(panelRoot.querySelector("#afe-open-editor"), "click", (event) => openAbilityEditor("", event.currentTarget));
  subscribeDom(panelRoot.querySelector("#afe-editor-form"), "submit", (event) => {
    event.preventDefault();
    saveAbilityFromEditor();
  });
  subscribeDom(panelRoot.querySelector("#afe-editor-template"), "click", applyAbilityTemplate);
  subscribeDom(panelRoot.querySelector("#afe-editor-cancel"), "click", closeAbilityEditor);
  subscribeDom(panelRoot.querySelector("#afe-page-prev"), "click", () => {
    currentPage = Math.max(1, currentPage - 1);
    renderPanel();
  });
  subscribeDom(panelRoot.querySelector("#afe-page-next"), "click", () => {
    currentPage += 1;
    renderPanel();
  });
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
  const detailClose = panelRoot.querySelector("#afe-detail-close");
  if (detailClose) subscribeDom(detailClose, "click", closeAbilityDetails);
  const detailAction = panelRoot.querySelector("#afe-detail-action");
  if (detailAction) subscribeDom(detailAction, "click", () => {
    if (!detailAbilityId) return;
    const abilityId = detailAbilityId;
    setSelected(abilityId, !isSelected(abilityId));
    openAbilityDetails(abilityId);
  });
  const detailModal = panelRoot.querySelector("#afe-detail-modal");
  if (detailModal) subscribeDom(detailModal, "click", (event) => {
    if (event.target === event.currentTarget) closeAbilityDetails();
  });
  const editorModal = panelRoot.querySelector("#afe-editor-modal");
  if (editorModal) subscribeDom(editorModal, "click", (event) => {
    if (event.target === event.currentTarget) closeAbilityEditor();
  });
}

function refreshPanel() {
  if (!panelRoot) return;
  currentPage = 1;
  renderPanel();
}

function mountMenuEntry() {
  if (!runtimeActive || menuEntry?.isConnected) return;
  if (menuEntry) {
    menuEntry.removeEventListener("click", menuEntryClickHandler);
    menuEntry.removeEventListener("keydown", menuEntryKeyHandler);
    menuEntry = null;
  }
  const menu = document.querySelector("#extensionsMenu, .extensionsMenu");
  if (!menu) return;

  menuEntry = document.createElement("div");
  menuEntry.id = "afe-menu-entry";
  menuEntry.className = "list-group-item flex-container flexGap5 interactable afe-menu-entry";
  menuEntry.tabIndex = 0;
  menuEntry.setAttribute("role", "button");
  menuEntry.setAttribute("aria-controls", "afe-panel-shell");
  menuEntry.setAttribute("aria-haspopup", "dialog");
  menuEntry.setAttribute("aria-expanded", "false");

  const icon = document.createElement("div");
  icon.className = "fa-solid fa-wand-sparkles extensionsMenuExtensionButton";
  icon.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.textContent = "全能外挂引擎";
  menuEntry.append(icon, label);

  menuEntryClickHandler = () => openPanel();
  menuEntryKeyHandler = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openPanel();
  };
  menuEntry.addEventListener("click", menuEntryClickHandler);
  menuEntry.addEventListener("keydown", menuEntryKeyHandler);
  menu.append(menuEntry);
}

async function openPanel() {
  if (!runtimeActive) return;
  if (!panelRoot) await mountPanel();
  if (!panelShell) return;
  panelShell.hidden = false;
  menuEntry?.setAttribute("aria-expanded", "true");
  documentKeyHandler ??= (event) => {
    if (event.key !== "Escape") return;
    if (detailAbilityId) closeAbilityDetails();
    else if (!panelRoot?.querySelector("#afe-editor-modal")?.hidden) closeAbilityEditor();
    else closePanel();
  };
  document.addEventListener("keydown", documentKeyHandler);
  panelRoot.querySelector("#afe-search")?.focus();
}

function closePanel() {
  if (!panelShell) return;
  closeAbilityEditor({ restoreFocus: false });
  closeAbilityDetails({ restoreFocus: false });
  panelShell.hidden = true;
  menuEntry?.setAttribute("aria-expanded", "false");
  if (documentKeyHandler) document.removeEventListener("keydown", documentKeyHandler);
  if (menuEntry?.isConnected) menuEntry.focus();
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
    console.error(`[${MODULE_ID}] failed to open ability panel`, error);
  }
}

function removePanel() {
  closePanel();
  clearDomSubscriptions();
  if (menuEntry && menuEntryClickHandler) menuEntry.removeEventListener("click", menuEntryClickHandler);
  if (menuEntry && menuEntryKeyHandler) menuEntry.removeEventListener("keydown", menuEntryKeyHandler);
  menuEntry?.remove();
  menuEntry = null;
  menuEntryClickHandler = null;
  menuEntryKeyHandler = null;
  panelShell?.remove();
  panelShell = null;
  panelRoot = null;
}

function buildInjectionPrompt(selected) {
  const lines = selected.map((ability) => `- ${CATEGORY_LABELS[ability.category]}：${ability.name}（${ability.work}）\n  ${ability.prompt}`);
  return [
    "【全能外挂引擎】",
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
    name: "全能外挂引擎",
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
    mountMenuEntry();
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
    mountMenuEntry();
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
