/**
 * models.js — Router 可调用的模型/思考强度 allowlist。
 *
 * 设计要点：
 *
 * 1. **用户只维护一个子集。** `config.models.allowed` 非空时，Worker 只能用这里
 *    列出的 provider/model；为空时退回宿主的完整模型目录（开箱可用，也可以在
 *    面板里逐步收紧）。每条允许项可以再限制 efforts，并把某个 effort 标成默认。
 *
 * 2. **Router 只看到稳定短 id。** 模型条目有 `id`（缺省为 `provider/model`），
 *    Router 在 `superagent_dispatch` 里传 `model: "pro"`，不必记住 provider 的
 *    内部命名；面板用同一份视图。
 *
 * 3. **校验尽量宽进严出。** 宿主模型目录可能暂时不可用（provider 掉线、冷启动、
 *    没挂 llm catalog）。此时仍接受配置里明确列出的条目，只把 `available` 标成
 *    unknown；真正不存在的 effort/model 交给宿主在请求时拒绝，而不是把任务卡死。
 *
 * 本模块不依赖任何 DSH 包，纯函数，便于单测。
 */

/** 允许项规范化结果；`undefined` 表示这一项不可用。 */
function normalizeEntry(raw, index, warnings) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    warnings.push(`models.allowed[${index}] 不是对象，已忽略`)
    return undefined
  }
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : ''
  const model = typeof raw.model === 'string' ? raw.model.trim() : ''
  if (provider.length === 0 || model.length === 0) {
    warnings.push(`models.allowed[${index}] 缺少 provider/model，已忽略`)
    return undefined
  }
  const id = typeof raw.id === 'string' && raw.id.trim().length > 0
    ? raw.id.trim()
    : `${provider}/${model}`
  const label = typeof raw.label === 'string' && raw.label.trim().length > 0
    ? raw.label.trim()
    : model
  const efforts = Array.isArray(raw.efforts)
    ? raw.efforts.filter((effort) => typeof effort === 'string' && effort.trim().length > 0).map((effort) => effort.trim())
    : []
  const defaultEffort = typeof raw.defaultEffort === 'string' && raw.defaultEffort.trim().length > 0
    ? raw.defaultEffort.trim()
    : undefined
  return {
    id,
    label,
    provider,
    model,
    efforts: [...new Set(efforts)],
    defaultEffort,
    note: typeof raw.note === 'string' && raw.note.trim().length > 0 ? raw.note.trim() : undefined,
    enabled: raw.enabled !== false,
  }
}

/** 展开宿主 modelCatalog 的 groups。 */
export function flattenCatalog(catalog) {
  const out = []
  for (const group of Array.isArray(catalog?.groups) ? catalog.groups : []) {
    const provider = typeof group?.id === 'string' ? group.id : ''
    if (provider.length === 0) continue
    for (const model of Array.isArray(group.models) ? group.models : []) {
      if (typeof model?.id !== 'string' || model.id.length === 0) continue
      out.push({
        provider,
        providerName: typeof group.name === 'string' && group.name.length > 0 ? group.name : provider,
        model: model.id,
        name: typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id,
        description: typeof model.description === 'string' ? model.description : undefined,
        efforts: Array.isArray(model.reasoning?.efforts)
          ? model.reasoning.efforts
            .filter((effort) => typeof effort?.id === 'string' && effort.id.length > 0)
            .map((effort) => ({
              id: effort.id,
              name: typeof effort.name === 'string' && effort.name.length > 0 ? effort.name : effort.id,
              description: typeof effort.description === 'string' ? effort.description : undefined,
            }))
          : [],
        defaultEffort: typeof model.reasoning?.defaultEffort === 'string' ? model.reasoning.defaultEffort : undefined,
      })
    }
  }
  return out
}

/**
 * 名称过滤：先做紧凑子串匹配；再按「非版本词」回退，容忍渠道展示名插入
 * 版本号（`DeepSeek-Flash` 命中 `DeepSeek-V4.1-Flash`）或连字符差异。
 *
 * @param {string} label 目录里的 model 名 + id
 * @param {string} name 用户配置的名称
 * @returns {boolean}
 */
function nameMatches(label, name) {
  const compact = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const haystack = compact(label)
  const needle = compact(name)
  if (needle.length > 0 && haystack.includes(needle)) return true
  const words = name.toLowerCase().split(/[^a-z0-9]+/).filter((word) => (
    word.length > 0 && !/^v?\d+$/.test(word)
  ))
  if (words.length === 0) return false
  return words.every((word) => haystack.includes(word))
}

/**
 * 按 `models.onlyProvider` / `models.onlyNames` 过滤宿主目录。
 *
 * 这是给「宿主机上有很多渠道，但用户只允许其中一两个」的场景用的：不必先
 * 把每个 model id 抄进 allowlist，也能保证 Router 看不到其它渠道。名字匹配
 * 同时看 model id、显示名和「显示名 · provider」标签，大小写不敏感。
 */
export function filterCatalog(catalog, raw) {
  const provider = typeof raw?.onlyProvider === 'string' ? raw.onlyProvider.trim() : ''
  const names = Array.isArray(raw?.onlyNames)
    ? raw.onlyNames.filter((name) => typeof name === 'string' && name.trim().length > 0).map((name) => name.trim())
    : []
  if (provider.length === 0 && names.length === 0) return catalog
  const groups = []
  for (const group of Array.isArray(catalog?.groups) ? catalog.groups : []) {
    if (provider.length > 0 && group?.id !== provider) continue
    const models = (Array.isArray(group?.models) ? group.models : []).filter((model) => {
      if (names.length === 0) return true
      const label = `${model?.name ?? ''} ${model?.id ?? ''}`
      return names.some((name) => nameMatches(label, name))
    })
    if (models.length > 0) groups.push({ ...group, models })
  }
  return { ...catalog, groups }
}

/** 索引 catalog：`provider\0model` → 目录项。 */
export function catalogIndex(catalog) {
  const index = new Map()
  for (const entry of flattenCatalog(catalog)) index.set(`${entry.provider}\u0000${entry.model}`, entry)
  return index
}

/**
 * 把配置 + 宿主目录折叠成可展示、可解析的模型视图。
 *
 * @param {object} config 合并后的配置。
 * @param {{ catalog?: object, defaultSelection?: object }} [context]
 * @returns {object}
 */
export function normalizeModelConfig(config, context = {}) {
  const warnings = []
  const raw = config?.models !== null && typeof config?.models === 'object' && !Array.isArray(config.models)
    ? config.models
    : {}
  const rawAllowed = Array.isArray(raw.allowed) ? raw.allowed : []
  const catalog = context.catalog ?? { groups: [], failures: [] }
  const index = catalogIndex(catalog)
  const configured = []

  for (const [position, item] of rawAllowed.entries()) {
    const entry = normalizeEntry(item, position, warnings)
    if (entry === undefined || entry.enabled === false) continue
    if (configured.some((candidate) => candidate.id === entry.id)) {
      warnings.push(`models.allowed 里 id 重复：${entry.id}，已保留第一条`)
      continue
    }
    configured.push(entry)
  }

  const filteredCatalog = filterCatalog(catalog, raw)
  const filtering = filteredCatalog !== catalog
  const catalogEntries = flattenCatalog(filteredCatalog)
  if (filtering && (catalog?.groups?.length ?? 0) > 0 && catalogEntries.length === 0) {
    warnings.push('models.onlyProvider / onlyNames 没有匹配到宿主目录里的任何模型')
  }
  const source = configured.length > 0
    ? configured.map((entry) => ({ ...entry, configured: true }))
    : catalogEntries.map((entry) => ({
        id: `${entry.provider}/${entry.model}`,
        label: `${entry.name} · ${entry.providerName}`,
        provider: entry.provider,
        model: entry.model,
        modelName: entry.name,
        efforts: entry.efforts.map((effort) => effort.id),
        defaultEffort: entry.defaultEffort,
        note: entry.description,
        enabled: true,
        configured: false,
      }))

  const models = source.map((entry) => {
    const catalogEntry = index.get(`${entry.provider}\u0000${entry.model}`)
    const catalogEfforts = catalogEntry?.efforts ?? []
    const configuredEfforts = Array.isArray(entry.efforts) ? entry.efforts : []
    const efforts = configuredEfforts.length > 0
      ? configuredEfforts.map((id) => catalogEfforts.find((effort) => effort.id === id) ?? { id, name: id })
      : catalogEfforts
    const defaultEffort = entry.defaultEffort !== undefined && efforts.some((effort) => effort.id === entry.defaultEffort)
      ? entry.defaultEffort
      : catalogEntry?.defaultEffort
    const available = catalogEntry !== undefined
      ? true
      : (catalog?.groups?.length ?? 0) === 0
        ? undefined
        : false
    return {
      id: entry.id,
      label: entry.label || catalogEntry?.name || entry.model,
      provider: entry.provider,
      providerName: catalogEntry?.providerName ?? entry.provider,
      model: entry.model,
      modelName: catalogEntry?.name ?? entry.model,
      description: entry.note ?? catalogEntry?.description,
      configured: entry.configured,
      available,
      unavailableReason: available === false
        ? `provider/model 不在宿主当前模型目录里：${entry.provider}/${entry.model}`
        : undefined,
      efforts,
      defaultEffort,
    }
  })

  const globalDefaultEffort = typeof raw.defaultEffort === 'string' ? raw.defaultEffort.trim() : ''
  const defaultSelection = context.defaultSelection ?? catalog?.default
  const defaultIdCandidate = typeof raw.default === 'string' ? raw.default.trim() : ''
  let defaultId
  if (defaultIdCandidate.length > 0) {
    const match = models.find((entry) => entry.id === defaultIdCandidate)
      ?? models.find((entry) => `${entry.provider}/${entry.model}` === defaultIdCandidate)
    if (match !== undefined) defaultId = match.id
    else warnings.push(`models.default 不在允许列表里：${defaultIdCandidate}，已回退`)
  }
  if (defaultId === undefined && models.length > 0) {
    const onlyNames = Array.isArray(raw.onlyNames)
      ? raw.onlyNames.filter((name) => typeof name === 'string' && name.trim().length > 0).map((name) => name.trim())
      : []
    // onlyNames 的顺序就是默认模型优先级：第一个是 deepseek-flash 时，它先被选中。
    let named
    for (const name of onlyNames) {
      named = models.find((entry) => nameMatches(`${entry.modelName} ${entry.model} ${entry.label}`, name))
      if (named !== undefined) break
    }
    const preferred = defaultSelection === undefined
      ? undefined
      : models.find((entry) => entry.provider === defaultSelection.provider && entry.model === defaultSelection.model)
    defaultId = (named ?? preferred ?? models[0]).id
  }
  if (defaultId !== undefined && globalDefaultEffort.length > 0) {
    const entry = models.find((candidate) => candidate.id === defaultId)
    if (entry !== undefined && entry.efforts.some((effort) => effort.id === globalDefaultEffort)) {
      entry.defaultEffort = globalDefaultEffort
    } else {
      warnings.push(`models.defaultEffort "${globalDefaultEffort}" 不适用于默认模型，已忽略`)
    }
  }

  return {
    mode: configured.length > 0 ? 'allowlist' : (filtering ? 'filtered' : 'all'),
    configuredCount: configured.length > 0 ? configured.length : (filtering ? models.length : 0),
    filtered: filtering,
    filter: { provider: typeof raw.onlyProvider === 'string' ? raw.onlyProvider : '', names: Array.isArray(raw.onlyNames) ? raw.onlyNames : [] },
    models,
    defaultId,
    defaultEffort: models.find((entry) => entry.id === defaultId)?.defaultEffort,
    defaultSelection,
    catalog: filteredCatalog,
    warnings,
  }
}

/** 在模型视图里按 id、label、provider/model、模型名查找。 */
export function findModel(view, reference) {
  if (typeof reference !== 'string' || reference.trim().length === 0) return undefined
  const query = reference.trim()
  const lower = query.toLowerCase()
  return view.models.find((entry) => entry.id === query)
    ?? view.models.find((entry) => `${entry.provider}/${entry.model}` === query)
    ?? view.models.find((entry) => entry.label.toLowerCase() === lower)
    ?? view.models.find((entry) => entry.modelName.toLowerCase() === lower)
    ?? view.models.find((entry) => entry.model === query)
}

/**
 * 解析一次 Worker dispatch 的模型选择。
 *
 * - 不传 model：使用 allowlist 的默认项。
 * - 传了 allowlist 之外的 model：明确报错，并给出可选项，避免 Router 悄悄降级。
 * - 传了 effort：必须是该模型声明的 effort；不传则用条目的 defaultEffort，
 *   没有默认则留给 provider 自己决定。
 *
 * @param {{ model?: string, reasoningEffort?: string }} request
 * @param {object} view `normalizeModelConfig` 的结果。
 * @returns {{ entry: object, selection: { provider: string, model: string, reasoningEffort?: string } }}
 */
export function resolveModelSelection(request, view) {
  const reference = typeof request?.model === 'string' && request.model.trim().length > 0
    ? request.model.trim()
    : undefined
  const entry = reference === undefined
    ? view.models.find((candidate) => candidate.id === view.defaultId) ?? view.models[0]
    : findModel(view, reference)
  if (entry === undefined) {
    const known = view.models.slice(0, 24).map((candidate) => `${candidate.id} (${candidate.provider}/${candidate.model})`).join('; ')
    throw Object.assign(
      new Error(`unknown or disallowed model "${reference}". Callable models: ${known || '(none)'}`),
      { code: 'model_not_allowed' },
    )
  }
  const requestedEffort = typeof request?.reasoningEffort === 'string' && request.reasoningEffort.trim().length > 0
    ? request.reasoningEffort.trim()
    : undefined
  let effort = requestedEffort ?? entry.defaultEffort
  if (effort !== undefined && entry.efforts.length > 0 && !entry.efforts.some((candidate) => candidate.id === effort)) {
    const known = entry.efforts.map((candidate) => candidate.id).join(', ')
    throw Object.assign(
      new Error(`model "${entry.id}" does not allow reasoning effort "${effort}". Allowed: ${known}`),
      { code: 'effort_not_allowed' },
    )
  }
  if (effort !== undefined && entry.efforts.length === 0) {
    // 目录缺失时无法校验 effort；保留 Router 的选择，让宿主在请求时给出准确错误。
    effort = requestedEffort ?? entry.defaultEffort
  }
  const selection = {
    provider: entry.provider,
    model: entry.model,
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
  }
  return { entry: { ...entry, reasoningEffort: effort }, selection }
}

/** 紧凑的一行模型摘要，用于动态提示词。 */
export function modelSummary(view) {
  if (view === undefined || view.models.length === 0) return 'no callable models are configured'
  const defaultEntry = view.models.find((entry) => entry.id === view.defaultId)
  const rows = view.models.slice(0, 12).map((entry) => {
    const efforts = entry.efforts.length > 0 ? ` · efforts ${entry.efforts.map((effort) => effort.id).join('/')}` : ''
    const suffix = entry.id === view.defaultId ? ' [default]' : ''
    return `${entry.id}${suffix} (${entry.model}@${entry.provider}${efforts})`
  })
  const more = view.models.length > 12 ? `; +${view.models.length - 12} more` : ''
  return `default ${defaultEntry?.id ?? view.defaultId ?? '?'}; ${rows.join('; ')}${more}`
}

/** 工具/HTTP 的模型视图：去掉内部对象，保留 JSON 安全字段。 */
export function modelViewPayload(view) {
  return {
    mode: view.mode,
    filtered: view.filtered === true,
    filter: view.filter,
    configuredCount: view.configuredCount,
    defaultId: view.defaultId,
    defaultEffort: view.defaultEffort,
    default: view.models.find((entry) => entry.id === view.defaultId) ?? null,
    models: view.models.map((entry) => ({ ...entry })),
    catalog: {
      default: view.catalog?.default,
      failures: Array.isArray(view.catalog?.failures) ? view.catalog.failures : [],
      groups: Array.isArray(view.catalog?.groups) ? view.catalog.groups : [],
    },
    warnings: view.warnings,
  }
}
