/**
 * dsh-eta-forecast — 桌面窗口 preload
 *
 * 只暴露窗口控制原语。渲染端是普通网页代码，拿不到 Node / Electron 任何东西。
 */

'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('etaBridge', {
  /** 光标进/出挂件矩形 → 翻转整窗点击穿透。 */
  setInteractive(interactive) {
    ipcRenderer.send('eta:set-interactive', !!interactive)
  },
  /** 拖动/菜单期间锁住可交互状态（否则翻回穿透会断掉 pointerup）。 */
  setInputBusy(busy) {
    ipcRenderer.send('eta:input-busy', !!busy)
  },
  /** 把窗口移到目标屏幕坐标（拖动时逐帧调用）。 */
  setBounds(x, y, width, height) {
    ipcRenderer.send('eta:set-bounds', { x, y, width, height })
  },
  /**
   * 订阅「实际生效的窗口位置」。
   *
   * 拖动请求会被主进程夹进显示器工作区，真实落点未必等于请求值；
   * 渲染端据此更新当前基准，下一次拖动才不会跳。
   */
  onBounds(callback) {
    if (typeof callback !== 'function') return
    ipcRenderer.on('eta:bounds', (event, bounds) => callback(bounds))
  },
  /** 宿主注入的配置：快照地址、允许的跨源。 */
  getConfig() {
    return ipcRenderer.invoke('eta:get-config')
  },
  /** 当前显示器工作区（把卡片夹在屏幕内）。 */
  getWorkArea() {
    return ipcRenderer.invoke('eta:get-work-area')
  },
})
