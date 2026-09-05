// recipe 求值器：把声明式 recipe 作用到事实表上，产出通用 Item。
//
// recipe 是纯数据（见 recipes/recipe.json），事实也是纯数据；
// 这里零依赖、纯函数，可独立测试。这正是「按钮/内容可以自己改」的机制核心：
// 改 recipe 里的一条 items，就改了一个按钮，不碰任何代码。
//
// 一个 recipe 条目要么是 aggregate（对整张事实表算一个数，如运行中角标），
// 要么是 foreach（每命中一条事实出一件 Item，如结束气泡）。

'use strict'

/** 字符串插值：'${field}' 从事实里取值；aggregate 时 fact 为 null，插值退化成空串 */
function interp(str, fact) {
  return String(str).replace(/\$\{(\w+)\}/g, (_m, k) => {
    const v = fact ? fact[k] : undefined
    return v === undefined || v === null ? '' : String(v)
  })
}

/** 递归插值：用于 action 这类嵌套对象 */
function interpDeep(value, fact) {
  if (typeof value === 'string') return interp(value, fact)
  if (Array.isArray(value)) return value.map((v) => interpDeep(v, fact))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = interpDeep(v, fact)
    return out
  }
  return value
}

/**
 * where 谓词：字段等值匹配 + 一个通用内建助手。
 * nonEmpty 判字段非空（数组非空或真值），供 HTTP 源这类对象事实用（如 runningSessionIds 非空）。
 * 「已完成未看」等业务语义不再内建——它们就是事实表里的普通字段（completed），直接等值匹配。
 */
function matchFact(fact, where) {
  if (!where) return true
  for (const [k, v] of Object.entries(where)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && 'nonEmpty' in v) {
      const val = fact[k]
      const nonEmpty = Array.isArray(val) ? val.length > 0 : Boolean(val)
      if (v.nonEmpty !== nonEmpty) return false
      continue
    }
    if (fact[k] !== v) return false
  }
  return true
}

/** 由 spec + （可选）事实 构造一条 Item。priority 由 sortBy 推导，供 Hub 保持排序。 */
function buildItem(spec, fact) {
  const item = {
    id: interp(spec.id, fact),
    appId: typeof spec.appId === 'string' ? spec.appId : null,
    kind: spec.kind || 'bubble',
    semantic: typeof spec.semantic === 'string' ? spec.semantic : null,
    glyph: typeof spec.glyph === 'string' ? spec.glyph : null,
    title: spec.title ? interp(spec.title, fact) : null,
    subtitle: spec.subtitle ? interp(spec.subtitle, fact) : null,
    priority: null,
    action: spec.action ? interpDeep(spec.action, fact) : null,
  }
  if (typeof spec.priority === 'number' && Number.isFinite(spec.priority)) {
    item.priority = spec.priority
  }
  if (spec.sortBy && fact) {
    const val = fact[spec.sortBy]
    if (typeof val === 'number' && Number.isFinite(val)) {
      item.priority = spec.sortDir === 'asc' ? -val : val
    }
  }
  return item
}

function evalAggregate(spec, facts) {
  const agg = spec.aggregate || {}
  const matched = agg.count ? facts.filter((f) => matchFact(f, agg.count.where)) : facts
  if (spec.omitWhenZero && matched.length === 0) return []
  const item = buildItem(spec, null)
  // aggregate 结果固定写进 badge（模型层唯一认的数值字段）；曾经的 agg.as 改名是哑的，已删
  item.badge = matched.length
  return [item]
}

// foreach 不在这里排序：排序统一由 buildItem 的 priority（sortBy/sortDir）+ Hub.snapshot 决定。
// 在这里 in-place sort 是双份排序——对 number 字段纯冗余，对 string 字段反而因 priority 不生效而被 Hub 退回 id 序。
function evalForeach(spec, facts) {
  const where = spec.foreach && spec.foreach.where
  const matched = facts.filter((f) => matchFact(f, where))
  return matched.map((f) => buildItem(spec, f))
}

/** 一条 spec 会产出哪些 id：给 omit 用（静态一条，foreach 每条命中事实一条）。 */
function specIds(spec, facts) {
  if (!spec || typeof spec.id !== 'string' || !spec.id) return []
  if (spec.foreach) {
    const where = spec.foreach.where
    return facts.filter((f) => matchFact(f, where)).map((f) => interp(spec.id, f))
  }
  return [interp(spec.id, null)]
}

/** 把一条 spec 合进 byId：omit 删、同 id 后者赢。无 aggregate/foreach 的是固定条目（不跟事实走，一直挂在 bar 上）。 */
function applySpec(spec, facts, byId) {
  if (spec.omit) {
    for (const id of specIds(spec, facts)) byId.delete(id)
    return
  }
  let produced
  if (spec.aggregate) produced = evalAggregate(spec, facts)
  else if (spec.foreach) produced = evalForeach(spec, facts)
  else if (typeof spec.id === 'string' && spec.id) produced = [buildItem(spec, null)]
  else return
  for (const item of produced) {
    if (item && item.id) byId.set(item.id, item)
  }
}

function evaluateRecipe(recipe, facts) {
  const byId = new Map()
  for (const spec of recipe.items || []) {
    if (!spec || typeof spec !== 'object') continue
    applySpec(spec, facts, byId)
  }
  return [...byId.values()]
}

/** 依序求值多个 recipe。同 id 后者覆盖前者；omit:true 删掉已有同 id。用户目录的 recipe 放后面。 */
function evaluateRecipes(recipes, facts) {
  const byId = new Map()
  for (const recipe of recipes || []) {
    for (const spec of recipe.items || []) {
      if (!spec || typeof spec !== 'object') continue
      applySpec(spec, facts, byId)
    }
  }
  return [...byId.values()]
}

/** 是不是 HTTP 源 recipe：facts 不是来自 bridge 事实表，而是轮询某 JSON 端点。 */
function isHttpSource(recipe) {
  return !!(recipe && recipe.source && recipe.source.type === 'http')
}

module.exports = { evaluateRecipes, evaluateRecipe, matchFact, interp, isHttpSource }