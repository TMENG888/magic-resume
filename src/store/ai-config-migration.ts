import {
  AI_PROVIDERS,
  AI_PROVIDER_DEFINITIONS,
  BUILTIN_AI_MODELS,
  builtinModelId,
  canModelParsePdf,
  createModelProfile,
  modelSupportsPdf,
  type AIModelProfile,
  type AIProvider,
  type AISettingsData,
} from "@/config/ai-models";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown) => (typeof value === "string" ? value : "");
const isProvider = (value: unknown): value is AIProvider =>
  AI_PROVIDERS.some((provider) => provider === value);

/**
 * DeepSeek 已下线旧模型名 → 现行模型名映射（2026-09 官方公告）。
 * deepseek-v4-flash / deepseek-v4-flash-vision-exp 已由 DeepSeek-V4.1-Flash
 * （模型名 deepseek-flash）替代，后者原生支持图片理解。
 * deepseek-v4-pro 暂保留：服务端会自动路由到 Flash 并按 Flash 计费。
 */
const DEEPSEEK_MODEL_RENAMES: Record<string, string> = {
  "deepseek-v4-flash": "deepseek-flash",
  "deepseek-v4-flash-vision-exp": "deepseek-flash",
};

const normalizeDeepseekModel = (provider: AIProvider, model: string) =>
  provider === "deepseek" ? (DEEPSEEK_MODEL_RENAMES[model] ?? model) : model;

/**
 * 已下线的 DeepSeek 旧内置模型 profile id → 新内置模型 profile id。
 * builtin profile 的 id/name/model 均来自目录，需整体重建而非仅改 model 字段，
 * 否则设置页会继续显示旧名「DeepSeek V4 Flash」。
 */
const DEEPSEEK_BUILTIN_ID_RENAMES: Record<string, string> = {
  "builtin:deepseek:deepseek-v4-flash": "builtin:deepseek:deepseek-flash",
  "builtin:deepseek:deepseek-v4-flash-vision-exp": "builtin:deepseek:deepseek-flash",
};

export function migrateAISettings(value: unknown): AISettingsData {
  const old = record(value);
  if (Array.isArray(old.models)) {
    const models: AIModelProfile[] = [];
    // 旧 profile id → 迁移后 id，用于保持 textModelId / pdfModelId 分配不断链
    const idRemap = new Map<string, string>();
    const allEntries = old.models.map(record);

    // 两遍处理：先入库未受重命名影响的 profile，再重建 DeepSeek 旧内置模型；
    // 这样用户已手动添加的新模型（相同目标 id）优先保留，旧条目仅重映射分配后丢弃
    for (const pass of [0, 1] as const) {
      for (const entry of allEntries) {
        const provider = entry.provider;
        if (!isProvider(provider)) continue;
        const rawId = string(entry.id);
        if (!rawId) continue;
        const renamedBuiltinId =
          provider === "deepseek" ? DEEPSEEK_BUILTIN_ID_RENAMES[rawId] : undefined;
        const isRename = Boolean(renamedBuiltinId);
        if ((pass === 1) !== isRename) continue;
        const id = renamedBuiltinId ?? rawId;
        const model = normalizeDeepseekModel(provider, string(entry.model));
        if (models.some((existing) => existing.id === id)) {
          // 目标 id 已存在：丢弃重复项，分配指向已有配置
          if (isRename) idRemap.set(rawId, id);
          continue;
        }
        const renamedBuiltin = renamedBuiltinId
          ? BUILTIN_AI_MODELS[provider].find(
              (builtin) => builtinModelId(provider, builtin.id) === renamedBuiltinId,
            )
          : undefined;
        const preset = createModelProfile(provider, id);
        const protocol =
          AI_PROVIDER_DEFINITIONS[provider].protocols.find(
            (candidate) => candidate === entry.protocol,
          ) ?? preset.protocol;
        models.push({
          ...preset,
          name: renamedBuiltin?.name ?? string(entry.name),
          apiKey: string(entry.apiKey),
          model,
          baseUrl: string(entry.baseUrl),
          protocol,
          supportsPdf: modelSupportsPdf(provider, model),
        });
        if (id !== rawId) idRemap.set(rawId, id);
      }
    }
    const resolveId = (value: unknown) => {
      const key = string(value);
      if (!key) return null;
      const target = idRemap.get(key) ?? key;
      return models.find((model) => model.id === target)?.id ?? null;
    };
    return {
      models,
      textModelId: resolveId(old.textModelId),
      pdfModelId:
        models.find(
          (model) =>
            model.id === resolveId(old.pdfModelId) && canModelParsePdf(model),
        )?.id ?? null,
    };
  }

  const state: AISettingsData = {
    models: [],
    textModelId: null,
    pdfModelId: null,
  };
  const legacyText = new Map<AIProvider, AIModelProfile>();
  for (const provider of ["doubao", "deepseek", "openai", "gemini"] as const) {
    const apiKey = string(old[`${provider}ApiKey`]);
    const model = string(old[`${provider}ModelId`]);
    const baseUrl = provider === "openai" ? string(old.openaiApiEndpoint) : "";
    if (!apiKey && !baseUrl && (!model || model === "gemini-flash-latest"))
      continue;
    const profile = createModelProfile(provider, `migrated-${provider}`);
    profile.apiKey = apiKey;
    // Preserve the model actually used by the old text routes.
    profile.model =
      provider === "deepseek" ? "deepseek-chat" : model || profile.model;
    profile.baseUrl = baseUrl || profile.baseUrl;
    state.models.push(profile);
    legacyText.set(provider, profile);
    if (old.selectedModel === provider) state.textModelId = profile.id;
  }

  const overrides = record(old.pdfImportProfiles);
  for (const provider of AI_PROVIDERS) {
    const saved = record(overrides[provider]);
    const inherited = legacyText.get(provider);
    const selected = (old.pdfImportProvider ?? "gemini") === provider;
    if (!Object.keys(saved).length && !(selected && inherited)) continue;
    const preset = createModelProfile(provider, `migrated-pdf-${provider}`);
    const profile: AIModelProfile = {
      ...preset,
      apiKey: string(saved.apiKey ?? inherited?.apiKey),
      model: string(
        saved.model ??
          (provider === "deepseek"
            ? AI_PROVIDER_DEFINITIONS.deepseek.pdfModel
            : (inherited?.model ?? AI_PROVIDER_DEFINITIONS[provider].pdfModel)),
      ),
      baseUrl: string(saved.baseUrl ?? inherited?.baseUrl ?? preset.baseUrl),
      protocol:
        AI_PROVIDER_DEFINITIONS[provider].protocols.find(
          (protocol) => protocol === saved.protocol,
        ) ?? preset.protocol,
      supportsPdf: modelSupportsPdf(
        provider,
        string(
          saved.model ??
            (provider === "deepseek"
              ? AI_PROVIDER_DEFINITIONS.deepseek.pdfModel
              : (inherited?.model ??
                AI_PROVIDER_DEFINITIONS[provider].pdfModel)),
        ),
      ),
    };
    const existing = state.models.find((model) =>
      ["provider", "protocol", "apiKey", "model", "baseUrl"].every(
        (field) =>
          model[field as keyof AIModelProfile] ===
          profile[field as keyof AIModelProfile],
      ),
    );
    if (existing)
      existing.supportsPdf = modelSupportsPdf(
        existing.provider,
        existing.model,
      );
    else state.models.push(profile);
    if (selected) state.pdfModelId = existing?.id ?? profile.id;
  }
  return state;
}
