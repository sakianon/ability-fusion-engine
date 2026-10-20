import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const moduleId = "ability-fusion-engine";
const schoolIds = ["fire", "water", "wind", "earth", "yin", "yang"].map((school) => `rezero-${school}-magic`);
const plannedIds = [
  "rezero-carmilla-lust-authority",
  "rezero-daphne-gluttony-authority",
  "rezero-divine-protection-wind-indication",
  "rezero-divine-protection-wind-evasion",
  "rezero-divine-protection-soul-language",
  "rezero-divine-protection-earth-spirits",
  "rezero-divine-protection-gathering-spirits",
  "rezero-divine-protection-magic-manipulation",
  "rezero-divine-protection-death-god",
  "rezero-divine-protection-trisection",
  "rezero-divine-protection-sun",
  "rezero-oni-physiology",
  "rezero-tiger-beastification",
  "rezero-book-of-wisdom",
  "rezero-gospel",
  "rezero-book-of-the-dead",
  "rezero-yang-sword-vollachia",
  "rezero-dragon-history-stone",
  "rezero-divine-dragon-blood",
];
const entries = JSON.parse(readFileSync(new URL("../data/abilities.json", import.meta.url), "utf8"));
const entryUrl = new URL("../index.js", import.meta.url);
const source = readFileSync(entryUrl, "utf8")
  .replaceAll("import.meta.url", JSON.stringify(entryUrl.href)).replace(/^export /gm, "");
const plain = (value) => JSON.parse(JSON.stringify(value));

function createRuntime(initial = {}, fetcher = async () => ({ ok: true, json: async () => entries })) {
  let saves = 0;
  const context = {
    extensionSettings: { [moduleId]: structuredClone(initial) },
    saveSettingsDebounced() { saves += 1; },
  };
  const sandbox = { URL, console, fetch: fetcher, SillyTavern: { getContext: () => context } };
  vm.runInNewContext(`${source}\nglobalThis.api = {
    getSettings, selectedAbilities, buildInjectionPrompt, loadAbilities,
    interceptGeneration, cleanupInjectedMessages,
    loadBuiltIns(value) { baseAbilities = normalizeAbilities(value); rebuildAbilities(); },
  };`, sandbox, { filename: entryUrl.pathname });
  return { api: sandbox.api, saves: () => saves };
}

test("six schools are distinct built-ins with valid fields and unique IDs", () => {
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);
  const split = entries.filter((entry) => schoolIds.includes(entry.id));
  assert.deepEqual(split.map((entry) => entry.id), schoolIds);
  assert.equal(new Set(split.map((entry) => entry.name)).size, 6);
  for (const entry of split) {
    for (const key of ["effects", "requirements", "limits", "costs", "stages"]) {
      assert.ok(Array.isArray(entry[key]), `${entry.id}.${key}`);
    }
    assert.ok(entry.effects.length > 0);
    assert.equal(Object.hasOwn(entry, "prompt"), false);
    assert.equal(Object.hasOwn(entry, "parent"), false);
  }
});

test("current selections are deduplicated without automatic saves", () => {
  const runtime = createRuntime({ enabled: true, selectedIds: [schoolIds[0], schoolIds[0], null], extraSetting: 42 });
  const first = plain(runtime.api.getSettings());
  assert.deepEqual(first.selectedIds, [schoolIds[0]]);
  assert.equal(first.enabled, true);
  assert.equal(first.extraSetting, 42);
  assert.deepEqual(plain(runtime.api.getSettings()), first);
  assert.equal(runtime.saves(), 0);
});

test("all nineteen planned entries exist with complete current-schema fields", () => {
  const additions = entries.filter((entry) => plannedIds.includes(entry.id));
  assert.equal(new Set(plannedIds).size, 19);
  assert.deepEqual(additions.map((entry) => entry.id), plannedIds);
  const work = entries.find((entry) => entry.id === schoolIds[0]).work;
  const workEntries = entries.filter((entry) => entry.work === work);
  assert.equal(new Set(workEntries.map((entry) => entry.name)).size, workEntries.length);
  const fields = ["id", "category", "name", "work", "tags", "description", "effects", "requirements", "limits", "costs", "stages"];
  for (const entry of additions) {
    assert.equal(entry.work, work);
    assert.ok(["ability", "item"].includes(entry.category));
    assert.deepEqual(Object.keys(entry).sort(), [...fields].sort());
    assert.ok(entry.description.trim());
    assert.ok(entry.effects.length > 0);
    assert.ok(entry.tags.length <= 6);
    for (const field of ["tags", "effects", "requirements", "limits", "costs"]) {
      assert.ok(Array.isArray(entry[field]), `${entry.id}.${field}`);
      assert.ok(entry[field].every((value) => typeof value === "string" && value.trim()), `${entry.id}.${field}`);
    }
    assert.deepEqual(entry.stages, []);
  }
});

for (const id of plannedIds) {
  test(`${id} selects and injects as a standalone built-in`, async () => {
    const runtime = createRuntime({ enabled: true, selectedIds: [id] });
    await runtime.api.loadAbilities();
    const selected = runtime.api.selectedAbilities();
    assert.deepEqual(plain(selected.map((entry) => entry.id)), [id]);
    const user = { is_user: true, mes: "User message" };
    const chat = [user];
    await runtime.api.interceptGeneration(chat, 4096, null, "normal");
    assert.equal(chat.length, 2);
    assert.equal(chat[1], user);
    assert.ok(chat[0].mes.includes(selected[0].name));
    for (const other of entries.filter((entry) => plannedIds.includes(entry.id) && entry.id !== id)) {
      assert.equal(chat[0].mes.includes(other.name), false, `${id} leaked ${other.id}`);
    }
    runtime.api.cleanupInjectedMessages();
    assert.deepEqual(chat, [user]);
  });
}

test("empty settings have usable current defaults", () => {
  const runtime = createRuntime();
  const settings = plain(runtime.api.getSettings());
  assert.equal(settings.enabled, false);
  assert.deepEqual(settings.selectedIds, []);
  assert.deepEqual(settings.customAbilities, []);
  assert.deepEqual(settings.abilityOverrides, {});
  assert.deepEqual(settings.deletedIds, []);
  assert.equal(runtime.saves(), 0);
});

test("built-in edits apply without modifying the JSON entry", () => {
  const original = structuredClone(entries.find((entry) => entry.id === schoolIds[0]));
  const runtime = createRuntime({
    selectedIds: [original.id],
    abilityOverrides: { [original.id]: { name: "Edited built-in", effects: ["Edited effect"] } },
  });
  runtime.api.loadBuiltIns(entries);
  const selected = plain(runtime.api.selectedAbilities());
  assert.equal(selected[0].name, "Edited built-in");
  assert.deepEqual(selected[0].effects, ["Edited effect"]);
  assert.deepEqual(entries.find((entry) => entry.id === original.id), original);
});

test("hidden built-ins do not enter selected results", () => {
  const runtime = createRuntime({ selectedIds: schoolIds, deletedIds: [schoolIds[0]] });
  runtime.api.loadBuiltIns(entries);
  assert.deepEqual(plain(runtime.api.selectedAbilities().map((entry) => entry.id)), schoolIds.slice(1));
});

test("current custom entries remain selectable alongside built-ins", () => {
  const custom = { id: "custom-test", name: "Custom entry", effects: ["Custom effect"] };
  const runtime = createRuntime({ selectedIds: [schoolIds[0], custom.id], customAbilities: [custom] });
  runtime.api.loadBuiltIns(entries);
  assert.deepEqual(plain(runtime.api.selectedAbilities().map((entry) => entry.id)), [schoolIds[0], custom.id]);
});

test("built-in JSON loads with every current entry selectable", async () => {
  const runtime = createRuntime({ selectedIds: entries.map((entry) => entry.id) });
  await runtime.api.loadAbilities();
  assert.deepEqual(plain(runtime.api.selectedAbilities().map((entry) => entry.id)), entries.map((entry) => entry.id));
});

test("failed JSON loading does not retain stale built-ins", async () => {
  const runtime = createRuntime({ selectedIds: schoolIds }, async () => ({ ok: false, status: 503 }));
  runtime.api.loadBuiltIns(entries);
  await runtime.api.loadAbilities();
  assert.deepEqual(plain(runtime.api.selectedAbilities()), []);
});

for (const schoolId of schoolIds) {
  test(`${schoolId} injects independently of other schools`, () => {
    const runtime = createRuntime({ selectedIds: [schoolId] });
    runtime.api.loadBuiltIns(entries);
    const selected = runtime.api.selectedAbilities();
    assert.deepEqual(plain(selected.map((entry) => entry.id)), [schoolId]);
    const prompt = runtime.api.buildInjectionPrompt(selected);
    assert.ok(prompt.includes(selected[0].name));
    for (const other of entries.filter((entry) => schoolIds.includes(entry.id) && entry.id !== schoolId)) {
      assert.equal(prompt.includes(other.name), false, `${schoolId} leaked ${other.id}`);
    }
  });
}

test("selected built-ins inject once before the user message and can be removed", async () => {
  const runtime = createRuntime({ enabled: true, selectedIds: [schoolIds[0]] });
  runtime.api.loadBuiltIns(entries);
  const user = { is_user: true, mes: "User message" };
  const chat = [user];
  await runtime.api.interceptGeneration(chat, 4096, null, "normal");
  await runtime.api.interceptGeneration(chat, 4096, null, "normal");
  assert.equal(chat.length, 2);
  assert.equal(chat[0].extra.abilityFusionEngine, true);
  assert.equal(chat[1], user);
  assert.ok(chat[0].mes.includes(entries.find((entry) => entry.id === schoolIds[0]).name));
  runtime.api.cleanupInjectedMessages();
  assert.deepEqual(chat, [user]);
});

for (const [enabled, type] of [[false, "normal"], [true, "quiet"]]) {
  test(`injection is skipped when enabled=${enabled} and type=${type}`, async () => {
    const runtime = createRuntime({ enabled, selectedIds: [schoolIds[0]] });
    runtime.api.loadBuiltIns(entries);
    const user = { is_user: true, mes: "User message" };
    const chat = [user];
    await runtime.api.interceptGeneration(chat, 4096, null, type);
    assert.deepEqual(chat, [user]);
  });
}
