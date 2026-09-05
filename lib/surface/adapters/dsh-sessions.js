// dsh-sessions adapter：把 DSH 会话事实投影成通用 Item。
//
// 职责边界：
//   - 事实从哪来（bridge）→ DshBridge 管
//   - 事实怎么变成 Item（哪类会话出角标/气泡，什么条件、什么文字、什么动作）→ recipe 模板管，可热更新
//   - 长什么样、画在哪 → surface 管
//   - open-session 动作怎么执行 → main.js 注册的共享 executor 管（按 item.appId 路由到对应应用视图）
// 本 adapter 只做「接事实 + 跑 recipe + 推给 Hub」三件胶水活。
//
// 多连接：一个 dsh 类应用（本地 / 远端端口映射）一个 adapter 实例，appId 参数化。
// 非本地实例会把 recipe 产出的 Item 重写到自己的命名空间：id 加 `${appId}:` 前缀、appId 强制绑定，
// 与本地 dsh 的条目互不碰撞；recipe 本身不用为每个连接复制一份。
'use strict'

const { evaluateRecipes, isHttpSource } = require('../recipes.js')

/** 本地（内置 dsh）实例的来源名与 Item id 保持原样：既有行为零变化 */
const LOCAL_APP_ID = 'dsh'
const LOCAL_SOURCE = 'dsh-sessions'

/** 无 recipe（bundled recipes/recipe.json 意外缺失）时的兜底：数据，不是第二套投影代码。
 *  与 recipes/recipe.json 等价——改其中一处记得同步另一处。 */
const FALLBACK_RECIPE = {
  protocol: 'dsh-plus.recipe',
  version: 1,
  domain: 'dsh.sessions',
  items: [
    {
      id: 'dsh:badge:running', appId: 'dsh', kind: 'badge', semantic: 'busy',
      aggregate: { count: { where: { status: 'running', pendingInteraction: { nonEmpty: false } } } }, omitWhenZero: true,
    },
    {
      id: 'dsh:fin:${sessionId}', appId: 'dsh', kind: 'bubble', semantic: 'done', glyph: 'bubble',
      foreach: { where: { completed: true, pendingInteraction: { nonEmpty: false }, bootstrapped: { nonEmpty: false } } },
      title: '${title}', subtitle: '${cwd}', sortBy: 'finishedAt', sortDir: 'desc',
      action: { type: 'open-session', target: { sessionId: '${sessionId}' } },
    },
    {
      id: 'dsh:pending:${sessionId}', appId: 'dsh', kind: 'bubble', semantic: 'warn', glyph: 'bubble',
      foreach: { where: { pendingInteraction: { nonEmpty: true } } },
      title: '${title}', subtitle: '待交互', sortBy: 'updatedAt', sortDir: 'desc',
      action: { type: 'open-session', target: { sessionId: '${sessionId}' } },
    },
  ],
}

/**
 * @param {object} deps
 * @param {object} deps.bridge       DshBridge 实例（事实源，lib/bridge.js）
 * @param {object} deps.hub          SurfaceHub 实例
 * @param {object} deps.recipeLoader RecipeLoader 实例（recipe 模板，含 .recipes 与 'change' 事件）
 * @param {string} [deps.appId]      该事实源绑定的应用 id（默认 'dsh'；远端连接/其他应用传自己的 appId）
 * @param {string} [deps.domain]     只认领这个 domain 的 recipe（默认 'dsh.sessions'；pi 侧传 'pi.sessions'）。
 *                                   无 domain 字段的 recipe 向后兼容、所有 adapter 都认。
 */
function createDshSessionsAdapter({
  bridge, hub, recipeLoader, appId = LOCAL_APP_ID, domain = 'dsh.sessions', projectFacts = null,
}) {
  const source = appId === LOCAL_APP_ID ? LOCAL_SOURCE : `${LOCAL_SOURCE}:${appId}`

  /** recipe 产出 → 本连接的 Item：非本地实例重写 id/appId，避免与本地条目碰撞。 */
  function adopt(item) {
    if (appId === LOCAL_APP_ID) return item
    return { ...item, id: `${appId}:${item.id}`, appId }
  }

  function factsNow() {
    const raw = bridge.factsArray()
    return projectFacts ? projectFacts(raw) : raw
  }

  /** 「怎么投影」只有 recipe 求值器一处：正常走 loader 的 recipe，缺失时走 FALLBACK_RECIPE。 */
  function itemsNow() {
    const recipes = recipeLoader ? recipeLoader.recipes : []
    // 只认「事实来自本 adapter 的 domain」的 recipe；http source 由 http-poll adapter 认领
    const localRecipes = recipes.filter((r) => !isHttpSource(r) && (!r.domain || r.domain === domain))
    const effective = localRecipes.length ? localRecipes : (domain === 'dsh.sessions' ? [FALLBACK_RECIPE] : [])
    return evaluateRecipes(effective, factsNow()).map(adopt)
  }

  function push() {
    hub.setItems(source, itemsNow())
  }

  function start() {
    bridge.on('update', push)
    if (recipeLoader) recipeLoader.on('change', push)
    push()
  }

  /** 应用被删/连接拆除时：摘监听 + 清掉本来源贡献的条目。 */
  function stop() {
    bridge.off('update', push)
    if (recipeLoader) recipeLoader.off('change', push)
    hub.clearSource(source)
  }

  /** 注意力条件变化（切应用 / 藏窗）时强制重投影，不依赖事实文件是否再变。 */
  function refresh() { push() }

  return { source, start, stop, refresh }
}

module.exports = { createDshSessionsAdapter, LOCAL_SOURCE }