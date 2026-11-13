"""Build the installable ZIP.

  python3 tools/build-package.py            -> dist/ps-slice-align-<version>.zip
  python3 tools/build-package.py --beta     -> dist/ps-slice-align-<version>-测试版.zip

Files are read from the working tree, so the build refuses uncommitted changes to
packaged files (pass --allow-dirty for a local try-out). The commit is written into
the package (BUILD.txt) and the ZIP's SHA-256 is printed.

The test version ("测试版") is a separate extension (own ID, folder, menu name and
panel title) so it installs next to the regular plugin without replacing it.
Its settings start empty (CEP keeps settings per extension); 我的术语表 and the
logs in %APPDATA%\\Align4Export are shared.
"""
import hashlib
import io
import os
import re
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT = 'com.align4.export'
BETA_EXT = 'com.align4.export.beta'


def tracked_files():
    out = subprocess.check_output(['git', '-c', 'core.quotepath=off', 'ls-files', '-z'], cwd=ROOT).decode('utf-8')
    return [f for f in out.split('\0') if f and not f.startswith(('dev/', 'tests/', 'tools/', '.'))]


def version():
    manifest = open(os.path.join(ROOT, EXT, 'CSXS', 'manifest.xml'), encoding='utf-8').read()
    return re.search(r'ExtensionBundleVersion="([^"]+)"', manifest).group(1)


def beta_text(path, text):
    if path.endswith('CSXS/manifest.xml'):
        text = text.replace('ExtensionBundleId="com.align4.export"', 'ExtensionBundleId="com.align4.export.beta"')
        text = text.replace('Id="com.align4.export.panel"', 'Id="com.align4.export.beta.panel"')
        text = text.replace('ExtensionBundleName="4 倍数导出"', 'ExtensionBundleName="4 倍数导出 测试版"')
        text = text.replace('<Menu>4 倍数导出</Menu>', '<Menu>4 倍数导出 测试版</Menu>')
        assert text.count('com.align4.export.beta') == 3, 'manifest IDs not rewritten'
    elif path.endswith('/index.html'):
        text = text.replace('<title>4 倍数导出</title>', '<title>4 倍数导出 测试版</title>')
        text = text.replace('<span>4 倍数导出</span></div>', '<span>4 倍数导出 <em class="beta-tag">测试版</em></span></div>')
        assert 'beta-tag' in text, 'title not rewritten'
    elif path.endswith('css/panel.css'):
        text += '\n.beta-tag { font-style: normal; font-size: 10px; font-weight: 600; color: var(--warn); margin-left: 4px; }\n'
    elif path.endswith(('install.ps1', 'uninstall.ps1')):
        text = text.replace("com.align4.export'", "com.align4.export.beta'")   # folder name at the end of a path string
        assert "com.align4.export.beta'" in text and "com.align4.export'" not in text, path
    return text


def git(*args):
    return subprocess.check_output(['git', '-c', 'core.quotepath=off'] + list(args), cwd=ROOT).decode('utf-8').strip()


def main(beta, allow_dirty):
    packaged = set(tracked_files())
    dirty = [line[3:] for line in git('status', '--porcelain').splitlines() if line[3:] in packaged]
    if dirty and not allow_dirty:
        sys.exit('未提交的修改会被打进安装包：%s\n先提交，或加 --allow-dirty 只做本地试用。' % ', '.join(dirty))
    commit = git('rev-parse', 'HEAD') + (' (含未提交修改)' if dirty else '')
    # ASCII folder inside the archive: Windows' built-in unzip may garble non-ASCII folder names.
    name = 'ps-slice-align-%s%s' % (version(), '-beta' if beta else '')
    os.makedirs(os.path.join(ROOT, 'dist'), exist_ok=True)
    target = os.path.join(ROOT, 'dist', 'ps-slice-align-%s%s.zip' % (version(), '-测试版' if beta else ''))
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as z:
        for path in tracked_files():
            data = open(os.path.join(ROOT, path), 'rb').read()
            arc = path
            if beta:
                if path.startswith(EXT + '/'):
                    arc = BETA_EXT + path[len(EXT):]
                if path.endswith(('.ps1', '.html', '.css', 'manifest.xml')):
                    bom = data.startswith(b'\xef\xbb\xbf')
                    text = beta_text(path, data.decode('utf-8-sig'))
                    data = (b'\xef\xbb\xbf' if bom else b'') + text.encode('utf-8')
            z.writestr(name + '/' + arc, data)
        z.writestr(name + '/BUILD.txt', ('4 倍数导出 %s%s\r\n提交：%s\r\n' % (version(), ' 测试版' if beta else '', commit)).encode('utf-8-sig'))
        if beta:
            z.writestr(name + '/测试版说明.txt', (
                '这是 4 倍数导出的测试版，和正式版是两个独立的插件，可以同时安装。\r\n\r\n'
                '安装：完全退出 Photoshop，双击 install.bat，重启后在 窗口 → 扩展功能（旧版）→ 4 倍数导出 测试版 打开。\r\n'
                '安装位置：%APPDATA%\\Adobe\\CEP\\extensions\\com.align4.export.beta（不会动正式版）。\r\n'
                '设置：测试版的导出目录等设置是单独的，第一次需要重新添加目录。\r\n'
                '“我的术语表”和运行日志与正式版共用：%APPDATA%\\Align4Export\\。\r\n'
                '卸载：双击 uninstall.bat，只删除测试版。\r\n').encode('utf-8-sig'))
    digest = hashlib.sha256(open(target, 'rb').read()).hexdigest()
    print(target, os.path.getsize(target), 'bytes')
    print('commit', commit)
    print('sha256', digest)


if __name__ == '__main__':
    main('--beta' in sys.argv, '--allow-dirty' in sys.argv)
