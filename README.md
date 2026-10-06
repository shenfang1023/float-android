# Float · AI 虚拟手机

[![Release](https://img.shields.io/github/v/release/shiaho777/float-android)](https://github.com/shiaho777/float-android/releases/latest)
[![Platform](https://img.shields.io/badge/platform-Android%20%7C%20Web-green)](https://github.com/shiaho777/float-android)
[![License](https://img.shields.io/badge/license-AGPL--3.0--only-blue)](./LICENSE)

一部可以装进 Android 手机、也可以用网页打开的 AI 虚拟手机。桌面上住着你创建的角色，他们有作息、日程和记忆，可以聊天、发消息、发朋友圈。

聊天记录和角色数据保存在本机。模型、生图、语音和音乐使用你自己填写的接口。

## 截图

| 桌面 | 小组件 | 会话列表 | 聊天 |
|---|---|---|---|
| ![](docs/screenshots/01-desktop.png) | ![](docs/screenshots/02-widgets.png) | ![](docs/screenshots/03-chats.png) | ![](docs/screenshots/04-chat-room.png) |

| 角色卷宗 | 查找·地图 | 外观自定义 | API 设置 |
|---|---|---|---|
| ![](docs/screenshots/05-characters.png) | ![](docs/screenshots/06-find-my.png) | ![](docs/screenshots/07-appearance.png) | ![](docs/screenshots/08-api-settings.png) |

## 做过的处理

- **性能和卡顿。** 聊天、桌面和常用页面的滚动负担减轻了。
- **安卓原生。** 网络长连接、图片存放、后台生成和备份文件写入走 Android 原生实现。安装包在锁屏之后，生成可以继续。
- **掉数据和自动备份。** 打开时会申请持久化存储。安装包每 6 小时把备份写进系统「文档」目录。网页在 Chrome 或 Edge 里选定文件夹之后，按同样的间隔写入。两处都只保留最近 3 份。
- **动画。** 一部分过渡调整过，点击和页面切换更顺。

## 开始使用

1. 用下面两种方式之一打开 Float。
2. 进入 **设置 → API 设置**，填写 LLM 的 Base URL 和 API Key。支持 OpenAI 兼容接口、Anthropic 和 Google Gemini。
3. 创建或导入角色，开始聊天。
4. 生图、语音和网易云音乐可以之后再配。

## 部署

只有两种方式。

### 方式一：构建 Android 安装包

Release 里不附安装包。Fork 到自己的 GitHub 账号，在 Actions 里构建，再装到手机。

1. Fork 本仓库。
2. 打开你的仓库。如果没有 **Actions**，或 Actions 是关闭的：进入 **Settings → Actions → General**，选择 Allow all actions，保存。
3. 打开 **Actions**。
4. 左侧选择 **Build Android Shell APK**。
5. 右侧点 **Run workflow**，在弹出的小框里再点一次 **Run workflow**。
6. 运行结束后，在页面底部的 **Artifacts** 下载 `float-android-` 加当前版本号。
7. 解压得到 `float-android-<版本号>.apk`，例如版本 1.0.2 就是 `float-android-1.0.2.apk`，传到手机安装。版本号变了，文件名里的数字一起变。

附件保留 14 天。过期之后再运行一次。

这是正式构建。仓库里不放私人签名，Actions 用仓库里的共享证书给这个正式包签名，后一次构建可以覆盖前一次。手机认源码里的 `versionCode`。发新版本时会把这个数字加一，同步后再构建，系统才会把它当成更新。有的手机会拒绝安装版本号相同的包，那种情况等下一次版本号上去再构建。

以前装过另一把证书的包，第一次换成这个包时要先卸载再装。卸载前先在应用里导出存档，装好再导入。

本机打包需要 JDK 21 和 Android SDK：`npm run build:apk`，然后 `cd android && ./gradlew assembleRelease`。没有 `android/keystore.properties` 时，本机打出的正式包和 Actions 用同一把证书。有这个文件时用你自己的正式签名，这个文件不要提交。调试包用 `./gradlew assembleDebug`。

### 方式二：部署网页

网页和安装包是同一套页面。把仓库交给静态网站托管，构建命令是 `npm run build`，发布目录是 `out`。Netlify、Cloudflare Pages、Vercel，以及任何能托管一个文件夹的服务，都用这一条。

Netlify 和 Vercel 会读仓库里的配置，导入后按默认设置构建即可。Cloudflare Pages 在项目设置里填写同样的构建命令和输出目录 `out`。环境变量可以留空。站点挂在域名根目录。`/world-builder` 和 `/characters` 是另外两个页面。

网页从浏览器直接请求你填写的 API，接口需要允许这个网站跨域访问。站点是 https 时，`http://` 的局域网地址可能会被浏览器拦住。请用 https，或本机的 localhost。生成在页面打开时进行。

网页里的数据写在这个网站自己的本地存储里。Chrome 或 Edge 打开 **设置 → 数据管理**，点「自动备份」选一个文件夹，之后每 6 小时写入一份，保留最近 3 份。不能选择文件夹的浏览器，用同一页的手动导出。

本机预览：`npm install`，然后 `npm run dev`，打开 <http://localhost:3001>。执行 `npm run build` 后，把 `out/` 上传到任意静态服务器，效果相同。

## 参与开发

仓库约定见 [AGENTS.md](./AGENTS.md)。

## License

GNU Affero General Public License v3.0 only（AGPL-3.0-only），详见 [LICENSE](./LICENSE)。字体、贴纸素材、3D 模型等第三方资源的授权说明见 [NOTICE](./NOTICE)。

## 致谢

本项目基于 [xiaolongbao0709/ai-virtual-phone](https://github.com/xiaolongbao0709/ai-virtual-phone) 开发。这个分支的基础来自原版。如果你喜欢这个方向，请去给原作者的仓库点 Star。
