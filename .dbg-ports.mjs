/**
 * 连到 **UI 浏览器**（PID 17540，端口 9230 那个 inspector 属于 host；
 * UI 窗口的 inspector 通常在另一个端口）。先枚举本机所有 LISTENING 端口
 * 里叫 /json/list 的，找到 UI 页面，再查挂件状态。
 */

import http from 'node:http'

function getJson(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/list', timeout: 2000 }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

// 扫常见 CDP 端口段
const candidates = []
for (let p = 9200; p <= 9400; p++) candidates.push(p)
// 也扫 DevTools 常用的随机高端口没法穷举，但 DSH 的 UI 窗口大概率在 92xx
const found = []
for (const port of candidates) {
  const list = await getJson(port)
  if (Array.isArray(list) && list.length > 0) {
    found.push({ port, targets: list.map((t) => ({ type: t.type, url: String(t.url || '').slice(0, 70), ws: t.webSocketDebuggerUrl })) })
  }
}
console.log(JSON.stringify(found, null, 2))
