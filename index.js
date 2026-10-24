const MODULE_ID = "ability-fusion-engine";
const INTERCEPTOR_NAME = "AbilityFusion_interceptGeneration";
const SETTINGS_URL = new URL("./settings.html", import.meta.url);
const DATA_MANIFEST_URL = new URL("./data/works-manifest.json", import.meta.url);
const ABILITY_TEMPLATE_URL = new URL("./data/ability-template.json", import.meta.url);

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
  item: "道具",
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
  context.extensionSettings[MODULE_ID] = {
    ...DEFAULT_SETTINGS,
    ...current,
    selectedIds: Array.isArray(current.selectedIds)
      ? [...new Set(current.selectedIds.filter((id) => typeof id === "string"))]
      : [],
    customAbilities: normalizeAbilities(current.customAbilities),
    abilityOverrides: current.abilityOverrides && typeof current.abilityOverrides === "object"
      ? current.abilityOverrides
      : {},
    deletedIds: Array.isArray(current.deletedIds)
      ? [...new Set(current.deletedIds.filter((id) => typeof id === "string"))]
      : [],
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
  return value.filter((item) => item && typeof item.id === "string" && typeof item.name === "string")
    .map((item) => ({
      id: item.id,
      category: Object.hasOwn(CATEGORY_LABELS, item.category) ? item.category : "ability",
      name: item.name,
      work: typeof item.work === "string" ? item.work : "未标注作品",
      tags: Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === "string").slice(0, 6) : [],
      description: typeof item.description === "string" ? item.description : "暂无说明。",
      effects: normalizeDetailItems(item.effects),
      requirements: normalizeDetailItems(item.requirements),
      limits: normalizeDetailItems(item.limits),
      costs: normalizeDetailItems(item.costs),
      stages: normalizeStages(item.stages),
    }));
}

function normalizeStages(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((stage) => stage && typeof stage === "object")
    .map((stage) => ({
      name: typeof stage.name === "string" ? stage.name.trim() : "",
      transition: typeof stage.transition === "string" ? stage.transition.trim() : "",
      effects: normalizeDetailItems(stage.effects),
      requirements: normalizeDetailItems(stage.requirements),
      limits: normalizeDetailItems(stage.limits),
      costs: normalizeDetailItems(stage.costs),
    }))
    .filter((stage) => stage.name || stage.transition || stage.effects.length || stage.requirements.length || stage.limits.length || stage.costs.length);
}

function normalizeDetailItems(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim());
  if (typeof value === "string") return value.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
  return [];
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
      return edited ?? ability;
    });
  const customAbilities = normalizeAbilities(settings.customAbilities);
  abilities = [...builtInAbilities, ...customAbilities];
}

async function loadAbilities() {
  try {
    const manifestResponse = await fetch(DATA_MANIFEST_URL, { cache: "no-store" });
    if (!manifestResponse.ok) throw new Error(`manifest HTTP ${manifestResponse.status}`);
    const manifest = await manifestResponse.json();
    if (!Array.isArray(manifest) || !manifest.length) throw new Error("empty work manifest");
    const responses = await Promise.all(manifest.map(async (file) => {
      if (typeof file !== "string" || !file.trim()) throw new Error("invalid work manifest entry");
      const response = await fetch(new URL(`./works/${file}`, DATA_MANIFEST_URL), { cache: "no-store" });
      if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
      return response.json();
    }));
    const loaded = normalizeAbilities(responses.flatMap((items) => Array.isArray(items) ? items : [items]));
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
  const selectedOnly = panelRoot?.querySelector("#afe-selected-filter")?.getAttribute("aria-pressed") === "true";
  if (selectedOnly && !selected) {
    refreshPanel();
  } else {
    updateAbilityCardSelection(id, selected);
    renderLoadout();
  }
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
  const field = document.getElementById(id);
  if (field) field.value = value ?? "";
}

function openAbilityEditor(abilityId = "", trigger = null) {
  if (!panelRoot) return;
  editingAbilityId = abilityId;
  editorTrigger = trigger ?? document.activeElement;
  const ability = abilityId ? getAbility(abilityId) : null;
  const editorModal = document.getElementById("afe-editor-modal");
  const editor = document.getElementById("afe-editor");
  if (!editorModal || !editor) return;
  const scrollTop = panelRoot.scrollTop;
  editorModal.hidden = false;
  document.getElementById("afe-editor-title").textContent = ability ? "编辑外挂条目" : "新建外挂条目";
  document.getElementById("afe-editor-mode").textContent = ability
    ? (baseAbilities.some((item) => item.id === ability.id) ? "修改内置条目" : "修改自定义条目")
    : "用户资料库 / 新条目";
  setEditorField("afe-editor-category", ability?.category ?? "ability");
  setEditorField("afe-editor-name", ability?.name ?? "未命名外挂");
  setEditorField("afe-editor-work", ability?.work ?? "用户自定义");
  setEditorField("afe-editor-tags", ability?.tags?.join(", ") ?? "自定义");
  setEditorField("afe-editor-description", ability?.description ?? "描述这条外挂能做什么，以及它的边界。");
  setEditorField("afe-editor-effects", ability?.effects?.join("\n") ?? "");
  setEditorField("afe-editor-requirements", ability?.requirements?.join("\n") ?? "");
  setEditorField("afe-editor-limits", ability?.limits?.join("\n") ?? "");
  setEditorField("afe-editor-costs", ability?.costs?.join("\n") ?? "");
  renderStageEditor(ability?.stages ?? []);
  document.getElementById("afe-editor-name")?.focus({ preventScroll: true });
  panelRoot.scrollTop = scrollTop;
}

function closeAbilityEditor({ restoreFocus = true } = {}) {
  const trigger = editorTrigger;
  editingAbilityId = "";
  editorTrigger = null;
  const editorModal = document.getElementById("afe-editor-modal");
  if (editorModal) editorModal.hidden = true;
  if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
}

function renderAbilityDetails(ability) {
  if (!panelRoot || !ability) return;
  const category = document.getElementById("afe-detail-category");
  const work = document.getElementById("afe-detail-work");
  const tags = document.getElementById("afe-detail-tags");
  const description = document.getElementById("afe-detail-description");
  const effects = document.getElementById("afe-detail-effects");
  const requirements = document.getElementById("afe-detail-requirements");
  const limits = document.getElementById("afe-detail-limits");
  const costs = document.getElementById("afe-detail-costs");
  const stages = document.getElementById("afe-detail-stages");
  const action = document.getElementById("afe-detail-action");
  if (category) {
    category.textContent = CATEGORY_LABELS[ability.category];
    category.className = `afe-card-category afe-category-${ability.category}`;
  }
  if (work) work.textContent = `作品：${ability.work}`;
  if (tags) tags.replaceChildren(...ability.tags.map(createTag));
  if (description) description.textContent = ability.description;
  renderDetailItems(effects, ability.effects);
  renderDetailItems(requirements, ability.requirements);
  renderDetailItems(limits, ability.limits);
  renderDetailItems(costs, ability.costs);
  renderAbilityStages(stages, ability.stages);
  if (action) {
    const selected = isSelected(ability.id);
    action.textContent = selected ? "取消外挂" : "加入外挂";
    action.setAttribute("aria-pressed", String(selected));
  }
}

function renderAbilityStages(target, stages) {
  if (!target) return;
  if (!stages.length) {
    target.textContent = "无预设阶段变化；能力按当前条件持续生效。";
    return;
  }
  target.replaceChildren(...stages.map((stage, index) => {
    const card = document.createElement("article");
    card.className = "afe-stage-card";
    const heading = document.createElement("h4");
    heading.textContent = `${index + 1}. ${stage.name || `阶段 ${index + 1}`}`;
    card.append(heading);
    appendStageDetail(card, "阶段变化条件", stage.transition);
    appendStageDetail(card, "本阶段效果", stage.effects);
    appendStageDetail(card, "发动方式", stage.requirements);
    appendStageDetail(card, "限制", stage.limits);
    appendStageDetail(card, "代价", stage.costs);
    return card;
  }));
}

function appendStageDetail(parent, label, value) {
  const values = Array.isArray(value) ? value : (value ? [value] : []);
  if (!values.length) return;
  const row = document.createElement("p");
  const strong = document.createElement("strong");
  strong.textContent = `${label}：`;
  row.append(strong, document.createTextNode(values.join("；")));
  parent.append(row);
}

function renderStageEditor(stages = []) {
  const container = document.getElementById("afe-editor-stages");
  if (!container) return;
  container.replaceChildren(...stages.map((stage) => createStageEditorRow(stage)));
}

function createStageEditorRow(stage = {}) {
  const card = document.createElement("fieldset");
  card.className = "afe-stage-editor-card";
  const legend = document.createElement("legend");
  legend.textContent = "阶段";
  card.append(legend);
  const fields = [
    ["阶段名称", "name", "例如：初阶、熟练、觉醒"],
    ["阶段变化条件", "transition", "达到什么明确条件后进入本阶段；不要自动跳级"],
    ["本阶段效果", "effects", "每行一项，写清相对上一阶段增加或变化什么"],
    ["发动方式", "requirements", "持有外挂后如何主动发动；被动能力写实际触发条件"],
    ["限制", "limits", "每行一项"],
    ["代价", "costs", "每行一项；没有额外代价可留空"],
  ];
  for (const [labelText, key, placeholder] of fields) {
    const label = document.createElement("label");
    label.className = "afe-stage-editor-field";
    label.append(document.createTextNode(labelText));
    const field = key === "name" || key === "transition" ? document.createElement("input") : document.createElement("textarea");
    field.dataset.stageField = key;
    field.placeholder = placeholder;
    field.value = Array.isArray(stage[key]) ? stage[key].join("\n") : (stage[key] ?? "");
    label.append(field);
    card.append(label);
  }
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "afe-stage-remove";
  remove.textContent = "移除此阶段";
  remove.addEventListener("click", () => card.remove());
  card.append(remove);
  return card;
}

function renderDetailItems(target, items) {
  if (!target) return;
  const entries = items.length ? items : ["尚未单独整理。"];
  target.replaceChildren(...entries.map((item) => {
    const entry = document.createElement("li");
    entry.textContent = item;
    if (!items.length) entry.className = "is-unstructured";
    return entry;
  }));
}

function openAbilityDetails(abilityId, trigger = null) {
  const ability = getAbility(abilityId);
  const modal = document.getElementById("afe-detail-modal");
  const title = document.getElementById("afe-detail-title");
  if (!ability || !modal || !title) return;
  const scrollTop = panelRoot.scrollTop;
  detailAbilityId = abilityId;
  detailTrigger = trigger ?? document.activeElement;
  title.textContent = ability.name;
  renderAbilityDetails(ability);
  modal.hidden = false;
  document.getElementById("afe-detail-close")?.focus({ preventScroll: true });
  panelRoot.scrollTop = scrollTop;
}

function closeAbilityDetails({ restoreFocus = true } = {}) {
  const trigger = detailTrigger;
  detailAbilityId = "";
  detailTrigger = null;
  const modal = document.getElementById("afe-detail-modal");
  if (modal) modal.hidden = true;
  if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
}

async function applyAbilityTemplate() {
  let tpl = null;
  try {
    const resp = await fetch(ABILITY_TEMPLATE_URL, { cache: "no-store" });
    tpl = await resp.json();
  } catch (err) {
    console.warn("[ability-fusion-engine] 模板加载失败，使用空编辑器。", err);
  }
  if (tpl) {
    setEditorField("afe-editor-category", tpl.category ?? "ability");
    setEditorField("afe-editor-name", tpl.name ?? "");
    setEditorField("afe-editor-work", tpl.work ?? "");
    setEditorField("afe-editor-tags", Array.isArray(tpl.tags) ? tpl.tags.join(", ") : "");
    setEditorField("afe-editor-description", tpl.description ?? "");
    setEditorField("afe-editor-effects", Array.isArray(tpl.effects) ? tpl.effects.join("\n") : "");
    setEditorField("afe-editor-requirements", Array.isArray(tpl.requirements) ? tpl.requirements.join("\n") : "");
    setEditorField("afe-editor-limits", Array.isArray(tpl.limits) ? tpl.limits.join("\n") : "");
    setEditorField("afe-editor-costs", Array.isArray(tpl.costs) ? tpl.costs.join("\n") : "");
    renderStageEditor(Array.isArray(tpl.stages) ? tpl.stages : []);
  } else {
    renderStageEditor([]);
  }
  document.getElementById("afe-editor-name")?.focus();
  setStatus("已载入外挂条目模板，可以直接修改后保存。");
}

function readAbilityEditor() {
  const category = document.getElementById("afe-editor-category")?.value ?? "ability";
  const name = document.getElementById("afe-editor-name")?.value.trim() ?? "";
  const work = document.getElementById("afe-editor-work")?.value.trim() ?? "";
  const tags = (document.getElementById("afe-editor-tags")?.value ?? "")
    .split(/[,，、]/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 6);
  const description = document.getElementById("afe-editor-description")?.value.trim() ?? "";
  const effects = normalizeDetailItems(document.getElementById("afe-editor-effects")?.value ?? "");
  const requirements = normalizeDetailItems(document.getElementById("afe-editor-requirements")?.value ?? "");
  const limits = normalizeDetailItems(document.getElementById("afe-editor-limits")?.value ?? "");
  const costs = normalizeDetailItems(document.getElementById("afe-editor-costs")?.value ?? "");
  const stages = [...(document.getElementById("afe-editor-stages")?.querySelectorAll(".afe-stage-editor-card") ?? [])]
    .map((card) => {
      const value = (key) => card.querySelector(`[data-stage-field="${key}"]`)?.value.trim() ?? "";
      return {
        name: value("name"),
        transition: value("transition"),
        effects: normalizeDetailItems(value("effects")),
        requirements: normalizeDetailItems(value("requirements")),
        limits: normalizeDetailItems(value("limits")),
        costs: normalizeDetailItems(value("costs")),
      };
    }).filter((stage) => stage.name || stage.transition || stage.effects.length || stage.requirements.length || stage.limits.length || stage.costs.length);
  if (!name) {
    setStatus("请填写外挂名称。");
    document.getElementById("afe-editor-name")?.focus();
    return null;
  }
  return {
    id: editingAbilityId || makeCustomId(),
    category: Object.hasOwn(CATEGORY_LABELS, category) ? category : "ability",
    name,
    work: work || "用户自定义",
    tags,
    description: description || "暂无说明。",
    effects,
    requirements,
    limits,
    costs,
    stages,
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

function restoreBuiltInAbilities() {
  const settings = getSettings();
  const overrideCount = Object.keys(settings.abilityOverrides ?? {}).length;
  const deletedCount = settings.deletedIds.length;
  if (!overrideCount && !deletedCount) {
    setStatus("内置外挂已经是初始状态；自建外挂未受影响。");
    return;
  }
  if (!globalThis.confirm?.("确定恢复所有内置外挂到初始状态吗？这会清除内置外挂的修改和删除记录，但不会删除或修改自建外挂。")) return;
  settings.abilityOverrides = {};
  settings.deletedIds = [];
  saveSettings();
  rebuildAbilities();
  currentPage = 1;
  renderPanel();
  setStatus(`已恢复 ${overrideCount + deletedCount} 项内置记录；自建外挂未受影响。`);
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
  card.dataset.id = ability.id;
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

function updateAbilityCardSelection(id, selected) {
  if (!panelRoot) return;
  const card = [...panelRoot.querySelectorAll(".afe-card")].find((item) => item.dataset.id === id);
  if (!card) return;
  card.classList.toggle("is-selected", selected);
  card.dataset.selected = String(selected);
  const action = card.querySelector(".afe-card-action");
  if (!action) return;
  action.setAttribute("aria-pressed", String(selected));
  action.dataset.state = selected ? "selected" : "available";
  action.textContent = selected ? "已加入" : "加入外挂";
}

function filterAbilities() {
  const search = panelRoot.querySelector("#afe-search").value.trim().toLowerCase();
  const category = panelRoot.querySelector(".afe-category.is-active")?.dataset.category ?? "all";
  const work = panelRoot.querySelector("#afe-work-filter").value;
  const selectedOnly = panelRoot.querySelector("#afe-selected-filter").getAttribute("aria-pressed") === "true";
  return abilities.filter((ability) => {
    const searchable = [ability.name, ability.work, ability.description, ...ability.effects, ...ability.requirements, ...ability.limits, ...ability.costs, ...ability.stages.flatMap((stage) => [stage.name, stage.transition, ...stage.effects, ...stage.requirements, ...stage.limits, ...stage.costs]), ...ability.tags].join(" ").toLowerCase();
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
  const counts = { all: visibleAbilities.length, ability: 0, cultivation: 0, skill: 0, system: 0, item: 0 };
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

function renderResults(animate = false) {
  const results = panelRoot.querySelector("#afe-results");
  const empty = panelRoot.querySelector("#afe-empty");
  const filtered = filterAbilities();
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  currentPage = Math.min(currentPage, totalPages);
  const start = (currentPage - 1) * PAGE_SIZE;
  results.classList.toggle("is-entering", animate);
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

function renderLoadout(animate = false) {
  const selected = selectedAbilities();
  const list = panelRoot.querySelector("#afe-loadout-list");
  const empty = panelRoot.querySelector("#afe-loadout-empty");
  list.classList.toggle("is-entering", animate);
  list.replaceChildren();
  for (const ability of selected) {
    const item = document.createElement("div");
    item.className = "afe-loadout-item";
    item.dataset.id = ability.id;
    item.dataset.category = ability.category;
    const copy = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = ability.name;
    const meta = document.createElement("small");
    meta.textContent = `${CATEGORY_LABELS[ability.category]} · ${ability.work}`;
    copy.append(name, meta);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "afe-remove-button";
    remove.dataset.id = ability.id;
    remove.setAttribute("aria-label", `取消 ${ability.name}`);
    remove.textContent = "×";
    item.append(copy, remove);
    list.append(item);
  }
  empty.hidden = selected.length > 0;
  panelRoot.querySelector("#afe-loadout-count").textContent = String(selected.length);
  panelRoot.querySelector("#afe-selected-filter-count").textContent = String(selected.length);
  panelRoot.querySelector("#afe-token-estimate").textContent = `${selected.reduce((total, ability) => total + buildInjectionPrompt([ability]).length, 0)} 字`;
}

function renderMasterSwitch() {
  const enabled = getSettings().enabled === true;
  panelRoot.querySelector("#afe-enabled").checked = enabled;
  panelRoot.querySelector("#afe-master-state").textContent = enabled ? "正在注入" : "已关闭";
}

function renderPanel({ animate = false } = {}) {
  if (!panelRoot) return;
  clearDomSubscriptions();
  renderWorkOptions();
  renderCategoryCounts();
  renderMasterSwitch();
  renderResults(animate);
  renderLoadout(animate);
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
  subscribeDom(panelRoot.querySelector("#afe-restore-built-ins"), "click", restoreBuiltInAbilities);
  subscribeDom(document.getElementById("afe-editor-form"), "submit", (event) => {
    event.preventDefault();
    saveAbilityFromEditor();
  });
  subscribeDom(document.getElementById("afe-editor-template"), "click", applyAbilityTemplate);
  subscribeDom(document.getElementById("afe-editor-add-stage"), "click", () => {
    document.getElementById("afe-editor-stages")?.append(createStageEditorRow());
  });
  subscribeDom(document.getElementById("afe-editor-cancel"), "click", closeAbilityEditor);
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
  subscribeDom(panelRoot.querySelector("#afe-loadout-list"), "click", (event) => {
    const remove = event.target.closest(".afe-remove-button");
    if (remove?.dataset.id) setSelected(remove.dataset.id, false);
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
  const detailClose = document.getElementById("afe-detail-close");
  if (detailClose) subscribeDom(detailClose, "click", closeAbilityDetails);
  const detailAction = document.getElementById("afe-detail-action");
  if (detailAction) subscribeDom(detailAction, "click", () => {
    if (!detailAbilityId) return;
    const abilityId = detailAbilityId;
    setSelected(abilityId, !isSelected(abilityId));
    openAbilityDetails(abilityId);
  });
  const detailModal = document.getElementById("afe-detail-modal");
  if (detailModal) subscribeDom(detailModal, "click", (event) => {
    if (event.target === event.currentTarget) closeAbilityDetails();
  });
  const editorModal = document.getElementById("afe-editor-modal");
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
    else if (!document.getElementById("afe-editor-modal")?.hidden) closeAbilityEditor();
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
    const editorModal = panelRoot.querySelector("#afe-editor-modal");
    const detailModal = panelRoot.querySelector("#afe-detail-modal");
    if (editorModal) document.body.append(editorModal);
    if (detailModal) document.body.append(detailModal);
    renderPanel({ animate: true });
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
  document.getElementById("afe-editor-modal")?.remove();
  document.getElementById("afe-detail-modal")?.remove();
  panelShell?.remove();
  panelShell = null;
  panelRoot = null;
}

function buildInjectionPrompt(selected) {
  const lines = selected.map((ability) => {
    const sections = [
      `【${CATEGORY_LABELS[ability.category]}】${ability.name}（${ability.work}）`,
      `简介：${ability.description}`,
      formatInjectionList("标签", ability.tags),
      formatInjectionList("核心效果", ability.effects),
      formatInjectionList("发动方式", ability.requirements),
      formatInjectionList("限制", ability.limits),
      formatInjectionList("代价", ability.costs),
    ];
    if (ability.stages.length) {
      sections.push("阶段变化：", ...ability.stages.map((stage, index) => [
        `阶段 ${index + 1}：${stage.name || `阶段 ${index + 1}`}`,
        `变化条件：${stage.transition || "未注明；不得自行推定已解锁"}`,
        formatInjectionList("效果", stage.effects),
        formatInjectionList("发动方式", stage.requirements),
        formatInjectionList("限制", stage.limits),
        formatInjectionList("代价", stage.costs),
      ].filter(Boolean).join("\n")));
    }
    return sections.filter(Boolean).join("\n");
  });
  return [
    "【全能外挂引擎】",
    "以下是<user>拥有的外挂，仅作为本次生成的补充设定。条目默认已经属于<user>。",
    ...lines,
  ].join("\n");
}

function formatInjectionList(label, items) {
  return items.length ? `${label}：\n${items.map((item) => `- ${item}`).join("\n")}` : "";
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
