/**
 * 单进程测试入口。
 *
 * 为什么不用 `node --test test/`：测试运行器会为每个文件 spawn 子进程并使用
 * 管道 stdio，在被沙箱限制的环境里会 `spawn EPERM`。这里直接按顺序 import，
 * 所有测试在同一个进程里注册并执行，不产生子进程。
 */

import './pure.test.js'
import './recall.test.js'
import './write.test.js'
import './persona.test.js'
import './inject.test.js'
import './circuit.test.js'
import './discover.test.js'
import './autowrite.test.js'
import './tone.test.js'
