# ps-slice-align

Photoshop 切图导出插件，自动将 PNG 宽高向上补齐至 4 的倍数。当前版本：**v2.0.0（Windows）**。

通过增加透明边缘补齐尺寸，保留原图像素，不缩放图片。例如：478 × 111 → 480 × 112。

## 功能

- 导出选中的图层、图层组或画板；整张画布有单独的导出区（独立目录、独立 SuperPNG 开关，默认关闭）。
- 宽高向上补齐到 4 的倍数，也可指定尺寸并“固定”，之后每张切图都按该尺寸输出；透明补边可居中或靠左上。
- 常用目录列表：每个目录有自己的导出按钮，点哪个导出到哪个。
- 自定义名称和前缀；同名文件自动编号，不覆盖已有文件。
- 可选 SuperPNG 编码。
- 大 PSD 或 Generator 没响应时自动重发导出命令，状态栏显示实时进度，可取消。
- 运行日志与一键“复制诊断信息”（含 Photoshop Generator 日志末尾），方便反馈问题。

## 下载安装

1. 点击仓库页面 **Code → Download ZIP**，完整解压。
2. 完全退出 Photoshop。
3. 在解压后的目录中双击 `install.bat`，无需管理员权限。
4. 重启 Photoshop，在 **窗口 → 扩展功能（或扩展功能〔旧版〕）→ 4 倍数导出** 打开面板。

安装器将插件复制到当前用户的 `%APPDATA%\Adobe\CEP\extensions`，并为 CSXS 9–12 启用 `PlayerDebugMode`，用于加载未签名 CEP 扩展。卸载时运行 `uninstall.bat`。

## 使用

选中对象，点目标目录右侧的“导出”即可。详细说明见 [使用说明](使用说明.md)。

遇到问题：点右上角“日志” → “复制诊断信息”，把内容发给开发者。

## 文档

- [详细使用说明](使用说明.md)
- [版本更新记录](CHANGELOG.md)
- 界面预览：`dev/preview.html`（见下方“开发”）

## 文件结构

- `com.align4.export/`：CEP 插件源码与配置，安装时请保持目录结构完整。
- `install.bat` / `install.ps1`：Windows 安装脚本。
- `uninstall.bat` / `uninstall.ps1`：Windows 卸载脚本。

## 开发

- 运行测试：`node --test tests/`
- 浏览器预览（模拟 Photoshop，可点击试用全部界面）：在仓库根目录运行 `python -m http.server 8000`，然后打开 <http://localhost:8000/dev/preview.html>。
- 代码结构：`js/panel.js` 只负责界面；导出流程在 `js/export-job.js`，等待 Generator 与自动重发在 `js/native-export.js`，名称归属在 `js/naming.js`，选择跟踪在 `js/selection.js`，设置在 `js/settings.js`，日志在 `js/logger.js` 与 `js/diagnostics.js`。
