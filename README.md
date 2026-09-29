# Folia HQPlayer component

独立可选 HQPlayer 控制组件，版本 **0.1.2**，协议主版本 **1**。本地仓库独立于 Folia 主程序及 WASAPI/ASIO 组件；源码与二进制在 [独立仓库](https://github.com/PekolandBBQ/folia-hqplayer-component) 发布，并随 [专版 Release](https://github.com/PekolandBBQ/Folia-HiFi-WASAPI-ASIO-HQPlayer/releases/tag/hifi-v0.7.9-r2) 镜像，保留独立构建入口。

源码负责 HQPlayer Desktop 发现、单实例确认后的连接、播放控制、音量与 ReplayGain 合成、DSP 设置和进程归属。Folia 只保留组件安装器、校验、IPC 适配、音源准备与设置入口。组件不包含 HQPlayer Desktop、FFmpeg、账号、Cookie 或音乐服务接口。

## 构建与验证

Node 24：`npm ci`，`npm test`，`npm run build`。产物为 `artifacts/folia-hqplayer-0.1.2-win32-x64.zip`，包含独立组件元数据、单文件入口和许可证。XML 库打包在组件内，普通 Folia 构建无需编译本组件。

Electron 宿主使用 utilityProcess 执行校验后的入口；独立 Node IPC 支持 CI 握手测试，不要求安装 Electron 或 HQPlayer。需要 HQPlayer Desktop 和真实 DAC 的测试另行执行，单元测试不证明硬件可用性。

## 发版与维护

`package.json` 与 `component.json` 版本必须一致。协议不兼容变更升级 protocolMajor；新增向后兼容能力增加 capabilities。标签 `v<组件版本>` 的工作流执行单测和构建并发布组件 ZIP；它与 Folia 软件版本、WASAPI/ASIO 组件版本均无绑定。

Folia 上游 CI 审查固定候选 URL、归档 SHA-256、入口 SHA-256、协议与能力握手后，将原始 ZIP 镜像到 Folia Release。客户端只使用 Folia 官方批准清单，保留协议兼容旧版并提示更新，绝不自动追踪 latest。当前正式候选和官方清单为空；本地专版离线包不代表上游批准。

本组件及对应宿主接入需由贡献方长期维护。HQPlayer 私有 XML 枚举变化、Folia 播放生命周期变化、设备异常须复测；失配仅禁用可选 HQPlayer，不阻止 Folia 常规构建或 WASAPI/ASIO 使用。上游合入仍须维护者审查批准。

许可：AGPL-3.0；包含 @xmldom/xmldom 的 MIT 许可声明。参考 [HQPlayer 官方控制 SDK](https://www.signalyst.eu/bins/hqp-control-601-src.zip)。

0.1.1 修复 prepare RPC 返回连接对象造成的 structured-clone 错误；增加显式关闭全部 Desktop 实例的 shutdown 动作，以及每次加载前应用的可选 defaults。原有 dispose 仍只清理由组件启动的实例。

0.1.2 在应用当前歌曲 DSP 设置后自动播放并恢复检查点，包括此前暂停的歌曲；按 Play 后 Seek 的顺序重新建立管线。官方控制接口的定位精度为整秒。
