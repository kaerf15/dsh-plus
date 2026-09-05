// dsh-plus-surface — client 半（dsh web 页面内，懒 CJS factory 格式）
//
// 职责（两件事）：
//   ① 把每个顶层会话的可序列化标量字段透传给 host（title/cwd/pendingInteraction/…），
//     并上报页面选中态（selected）——host 据此自行推导 completed（完成未看）：
//     「结束瞬间没有任何 client 选中 = 未看；任一 client 之后选中 = 看过」。
//     completed 本身不透传：它是各 client 运行时内存（completedNotifications）各自为政的
//     产物，多客户端（壳 webview + 浏览器 tab）下没选中的那个 client 会把 true 钉死在桥上。
//   ② 暴露 window.__dshPlus.handle(action) 通用动作入口，供 DSH+ 壳 executeJavaScript 跳转/分发。
//
// 私有面脆弱点登记（平台升级先核对这些）：
//   1. ctx.sessions（ISessions）：list.subscribe/getSnapshot().byId/.current 与 open(id)
//   2. ctx.connection.rpc.call(channel, endpoint, payload)（client connection 半）
//   3. ctx.uiSession.pendingInteractions（question/approval/plan 的真实来源，list.byId 常缺）
//   4. window.__dshPlus 全局约定（与壳的 executeJavaScript 配套）
//   5. byId 行字段：id / displayTitle / pendingInteraction / parentId / title / cwd / …
//      （selected 是本通道自定义字段、运行时行上没有；若平台未来给行加同名字段会先被
//      fieldsForRow 透传、再被我们的覆盖逻辑改写——升级时核对这一点）

window.__ModuleLoader__.load({
  id: 'dsh-plus-surface',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var CHANNEL = '/dsh-plus-surface'
    // id/running 是 host 真相；completed 改由 host 依 selected 推导（见文件头）
    var SKIP = { id: true, running: true, completed: true }

    /** 与 workspace 侧导航一致：只认壳 recipe 支持的三种待交互分类 */
    function visiblePendingKind(kind) {
      if (kind === 'approval' || kind === 'plan-review' || kind === 'question') return kind
      return undefined
    }

    function fieldsForRow(row, pendingSnap) {
      var fields = {}
      for (var k in row) {
        if (SKIP[k]) continue
        var v = row[k]
        var t = typeof v
        if (t === 'string' || t === 'number' || t === 'boolean') fields[k] = v
      }
      // question/approval/plan 走 uiSession.registerPendingInteraction，不一定出现在 list.byId
      var ui = pendingSnap && pendingSnap.get(row.id)
      var kind = ui && visiblePendingKind(ui.kind)
      if (kind) fields.pendingInteraction = kind
      else if (typeof row.pendingInteraction === 'string') fields.pendingInteraction = row.pendingInteraction
      return fields
    }

    function apply(ctx) {
      var api = {
        handle: function (action) {
          if (!action || typeof action !== 'object') return false
          if (action.type === 'open-session') {
            var sid = action.target && action.target.sessionId
            if (!sid) return false
            var sessions = ctx.sessions
            if (typeof sessions.open === 'function') { sessions.open(sid); return true }
            return false
          }
          return false
        },
        jump: function (id) {
          return api.handle({ type: 'open-session', target: { sessionId: id } })
        },
      }
      if (typeof window !== 'undefined') {
        window.__dshPlus = api
        ctx.effect(function () {
          return function () { if (window.__dshPlus === api) delete window.__dshPlus }
        })
      }

      /* inject: ['sessions','connection','uiSession'] 已保证三服务在 apply 前就位，
       * 原先的 ctx.get + null 判空是双轨死代码（评审修复 A4）——直接 ctx.* 取用 */
      var sessions = ctx.sessions
      var connection = ctx.connection
      var uiSession = ctx.uiSession

      ctx.effect(function () {
        var seen = {}
        var prevSelected = {} // id -> 上一次透传时是否选中（取消选中的显式 false 检测用）
        // 本页面实例的随机 id：host 按 client 维度维护 selectedBy（多客户端选中取并集）
        var clientId = Math.random().toString(36).slice(2) + Date.now().toString(36)
        function pendingSnap() {
          return uiSession.pendingInteractions ? uiSession.pendingInteractions.getSnapshot() : null
        }
        function sync(id, fields) {
          connection.rpc.call(CHANNEL, 'sync', { sessionId: id, clientId: clientId, fields: fields }).catch(function () {})
        }
        function flush() {
          var snap = sessions.list.getSnapshot()
          var byId = (snap && snap.byId) || {}
          var current = snap ? snap.current : undefined
          var pending = pendingSnap()
          for (var id in byId) {
            var row = byId[id]
            if (!row || row.parentId !== undefined || row.origin === 'subagent') {
              delete seen[id]
              delete prevSelected[id]
              continue
            }
            var fields = fieldsForRow(row, pending)
            // 选中态上报：host 推导 completed 的唯一输入。取消选中必须显式 false——
            // 「整体替换」语义下字段缺席无法区分「取消了」与「没变」。
            if (id === current) fields.selected = true
            else if (prevSelected[id]) fields.selected = false
            prevSelected[id] = id === current
            var key = JSON.stringify(fields)
            if (seen[id] === key) continue
            seen[id] = key
            sync(id, fields)
          }
          for (var k in seen) {
            if (!byId[k]) {
              delete seen[k]
              delete prevSelected[k]
            }
          }
        }
        var unsubList = sessions.list.subscribe(flush)
        var unsubPending = (uiSession && uiSession.pendingInteractions)
          ? uiSession.pendingInteractions.subscribe(flush)
          : function () {}
        flush()
        // 关页 best-effort 摘选中：不留死标记在 host 的 selectedBy 里
        // （残留的最坏后果是该会话下一轮完成后漏出一颗气泡）。
        function onPageHide() {
          try {
            var snap = sessions.list.getSnapshot()
            var cur = snap && snap.current
            if (cur) sync(cur, { selected: false })
          } catch (e) { /* 页面 teardown 期拿不到快照就算了：best-effort */ }
        }
        if (typeof window !== 'undefined') window.addEventListener('pagehide', onPageHide)
        // 页面重新可见/聚焦：强制重报当前选中（绕过 JSON 去重）。
        // 盲区：host 的选中记录可能丢失（agent 进程重排 disposed 清 selectedBy、断线重连），
        // 此后会话完成会记成未看；而点击「已是当前选中」的会话快照无变化、不产生上报，
        // 气泡只能切别的会话再切回或点气泡才消。回到前台时主动重报即可自愈。
        function resyncCurrent() {
          try {
            var snap = sessions.list.getSnapshot()
            var cur = snap && snap.current
            // 删去重键后 flush 必重发当前行（含 selected:true）；从未同步过的行更该补报，不加额外守卫
            if (cur) { delete seen[cur]; flush() }
          } catch (e) { /* 快照暂不可得：下拍事件自然补 */ }
        }
        function onVisible() { if (typeof document === 'undefined' || !document.hidden) resyncCurrent() }
        if (typeof window !== 'undefined') window.addEventListener('focus', resyncCurrent)
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
        return function () {
          if (unsubList) unsubList()
          if (unsubPending) unsubPending()
          if (typeof window !== 'undefined') {
            window.removeEventListener('pagehide', onPageHide)
            window.removeEventListener('focus', resyncCurrent)
          }
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
        }
      })
    }

    module.exports = {
      name: 'dsh-plus-surface-client',
      inject: ['sessions', 'connection', 'uiSession'],
      apply: apply,
    }
    return module.exports
  },
})
