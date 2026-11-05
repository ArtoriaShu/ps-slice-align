# ps-slice-align

Photoshop 切图导出插件，自动将 PNG 宽高向上补齐至 4 的倍数。当前版本：**v1.11.0（Windows）**。

通过增加透明边缘补齐尺寸，保留原图像素，不缩放图片。例如：478 × 111 → 480 × 112。

## 功能

- 导出选中的图层、图层组或画板为 PNG。
- 自定义输出宽高，并向上补齐至 4 的倍数。
- 支持整张画布导出、常用目录、自定义名称和文件名前缀。
- 同名文件自动编号，避免覆盖已有文件。
- 可选 SuperPNG 导出：补边后自动调用已安装的 SuperPNG，支持所有导出入口。

## 下载安装

1. 点击仓库页面 **Code → Download ZIP**，完整解压。
2. 完全退出 Photoshop。
3. 在解压后的目录中双击 `install.bat`，无需管理员权限。
4. 重启 Photoshop，在 **窗口 → 扩展功能（或扩展功能〔旧版〕）→ 4 倍数导出** 打开面板。

安装器将插件复制到当前用户的 `%APPDATA%\Adobe\CEP\extensions`，并为 CSXS 9–12 启用 `PlayerDebugMode`，用于加载未签名 CEP 扩展。卸载时运行 `uninstall.bat`。

## 使用

选中对象，设置输出目录，点击“导出切图”。整图导出使用独立的输出目录和按钮。

要直接输出 SuperPNG 保存的 PNG，在导出按钮下勾选“使用 SuperPNG 导出”（状态会记住，默认关闭）。需事先安装 SuperPNG 本体；转换失败会报错，不会回退为普通 PNG。面板会临时打开并关闭补边后的 PNG，原 PSD 保持不变。

本插件面向 Windows Photoshop 2019（20.x）及 2020（21.x）。较新版本需要提供 CEP 扩展及对应原生导出命令；跨版本兼容性仍需实机验证。当前上传仅核对文件完整性，未进行 Windows Photoshop 实机测试。

## 文档

- [详细使用说明](使用说明.md)
- [版本更新记录](CHANGELOG.md)
- [界面预览文件](界面预览.html)（下载后用浏览器打开）

## 文件结构

- `com.align4.export/`：CEP 插件源码与配置，安装时请保持目录结构完整。
- `install.bat` / `install.ps1`：Windows 安装脚本。
- `uninstall.bat` / `uninstall.ps1`：Windows 卸载脚本。
