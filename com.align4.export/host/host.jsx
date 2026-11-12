/* Native selected-object PNG export. No temporary Photoshop documents. */
// Versioned global: 1.x panels define `Align4` in the same Photoshop script engine,
// so 2.x uses its own name and both can be installed side by side.
var Align4v2 = (function () {
    function sid(s) { return stringIDToTypeID(s); }
    function quote(s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\x00-\x1f\u2028\u2029]/g, function (c) { return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4); }) + '"'; }
    function json(v) {
        var t = typeof v, parts = [], k, i;
        if (v === null || t === 'undefined') { return 'null'; }
        if (t === 'string') { return quote(v); }
        if (t === 'number') { return isFinite(v) ? String(v) : 'null'; }
        if (t === 'boolean') { return v ? 'true' : 'false'; }
        if (v instanceof Array) { for (i = 0; i < v.length; i++) { parts.push(json(v[i])); } return '[' + parts.join(',') + ']'; }
        for (k in v) { if (v.hasOwnProperty(k)) { parts.push(quote(k) + ':' + json(v[k])); } }
        return '{' + parts.join(',') + '}';
    }
    function error(e) { return json({ok:false, message:String(e.message || e)}); }
    function countSelected() {
        var names = ['targetLayersIDs', 'targetLayers'], i;
        for (i = 0; i < names.length; i++) {
            try {
                var r = new ActionReference(); r.putProperty(sid('property'), sid(names[i])); r.putEnumerated(sid('document'), sid('ordinal'), sid('targetEnum'));
                var d = executeActionGet(r); if (d.hasKey(sid(names[i]))) { return d.getList(sid(names[i])).count; }
            } catch (e) {}
        }
        return 1;
    }
    function property(name) {
        var r = new ActionReference(); r.putProperty(sid('property'), sid(name)); r.putEnumerated(sid('layer'), sid('ordinal'), sid('targetEnum')); return executeActionGet(r);
    }
    function token() {
        if (!app.documents.length) { throw new Error('请打开 PSD 并选择一个导出对象。'); }
        if (countSelected() !== 1) { throw new Error('每次只选择一个图层、图层组或画板。'); }
        var id = property('layerID').getInteger(sid('layerID'));
        return {id:id, docId:app.activeDocument.id, token:[app.activeDocument.id, id, 1].join('|')};
    }
    function revision() {
        // A single history descriptor, no enumeration of layers or history states.
        try {
            var r = new ActionReference(); r.putProperty(sid('historyState'), sid('currentHistoryState'));
            var d = executeActionGet(r); if (d.hasKey(sid('ID'))) { return String(d.getInteger(sid('ID'))); }
        } catch (e) {}
        return null;
    }
    function number(desc, key) { try { return desc.getUnitDoubleValue(sid(key)); } catch (e) { return desc.getDouble(sid(key)); } }
    // Approximate size from the layer bounds (or artboard rectangle): instant, no Generator.
    // The exact size still comes from the exported PNG.
    // Cheap, but guarded for very large documents: computed once per object + history
    // state (the panel polls every ~1.2s), and switched off for a document whose first
    // lookups turn out slow.
    var estimateCache = {key: null, w: 0, h: 0}, slowDocs = {};
    function estimate(result, rev) {
        if (slowDocs[result.docId]) { result.estSkipped = true; return; }
        var key = result.token + '|' + rev;
        if (estimateCache.key === key) { if (estimateCache.w) { result.estWidth = estimateCache.w; result.estHeight = estimateCache.h; } return; }
        var started = new Date().getTime(), w = 0, h = 0;
        try {
            var rect = result.kind === '画板' ? property('artboard').getObjectValue(sid('artboard')).getObjectValue(sid('artboardRect'))
                                              : property('bounds').getObjectValue(sid('bounds'));
            w = Math.round(number(rect, 'right') - number(rect, 'left')); h = Math.round(number(rect, 'bottom') - number(rect, 'top'));
        } catch (e) {}
        var ms = new Date().getTime() - started;
        if (ms > 250) { slowDocs[result.docId] = true; result.estSkipped = true; result.estMs = ms; return; }
        if (!(w > 0 && h > 0)) { w = 0; h = 0; }
        estimateCache = {key: key, w: w, h: h};
        if (w) { result.estWidth = w; result.estHeight = h; }
    }
    function meta() {
        var result = token(); result.name = property('name').getString(sid('name'));
        result.kind = property('layerSection').getEnumerationValue(sid('layerSection')) === sid('layerSectionStart') ? '图层组' : '图层';
        try { var a = property('artboardEnabled'); if (a.hasKey(sid('artboardEnabled')) && a.getBoolean(sid('artboardEnabled'))) { result.kind = '画板'; } } catch (e) {}
        result.revision = revision();
        estimate(result, result.revision);
        result.ok = true; return result;
    }
    function selectionToken() { try { var t = token(); t.ok = true; return json(t); } catch (e) { return error(e); } }
    function describeSelection() { try { return json(meta()); } catch (e) { return error(e); } }
    function documentMeta() {
        if (!app.documents.length) { throw new Error('请先打开需要导出的 PSD。'); }
        var doc = app.activeDocument;
        return {ok:true, docId:doc.id, token:String(doc.id) + '|canvas', name:String(doc.name).replace(/\.[^.]+$/, ''), width:Math.round(doc.width.as('px')), height:Math.round(doc.height.as('px')), revision:revision(), kind:'整个画布'};
    }
    function describeDocument() { try { return json(documentMeta()); } catch (e) { return error(e); } }
    function startNativeFor(expected, directory, canvas) {
        try {
            var info = canvas ? documentMeta() : meta(); if (info.token !== expected) { throw new Error(canvas ? '当前文档已改变，请重新点击导出整个画布。' : '选择已改变，等待面板识别新对象后再操作。'); }
            var folder = new Folder(directory); if (!folder.exists) { throw new Error('临时导出目录不存在。'); }
            var r = new ActionReference(); r.putEnumerated(sid('layer'), sid('ordinal'), sid('targetEnum'));
            var d = new ActionDescriptor(); d.putReference(sid('null'), r);
            d.putString(sid('fileType'), 'png'); d.putInteger(sid('quality'), 32); d.putInteger(sid('metadata'), 0);
            d.putString(sid('destFolder'), folder.fsName); d.putBoolean(sid('sRGB'), true); d.putBoolean(sid('openWindow'), false);
            executeAction(sid(canvas ? 'exportDocumentAsFileTypePressed' : 'exportSelectionAsFileTypePressed'), d, DialogModes.NO);
            info.started = true; return json(info);
        } catch (e) { return error(e); }
    }
    function startNative(expected, directory) { return startNativeFor(expected, directory, false); }
    function startNativeCanvas(expected, directory) { return startNativeFor(expected, directory, true); }
    function convertSuperPNG(inputPath, outputPath) {
        var original = app.documents.length ? app.activeDocument : null;
        var oldDialogs = app.displayDialogs, doc = null;
        try {
            var input = new File(inputPath), output = new File(outputPath);
            if (!input.exists || output.exists) { throw new Error('SuperPNG 临时输入不存在或输出已存在。'); }
            app.displayDialogs = DialogModes.NO;
            // Force the Adobe PNG reader so SuperPNG import preferences cannot
            // turn transparency into a separate alpha channel.
            doc = app.open(input, OpenDocumentType.PNG);
            app.activeDocument = doc;
            var c = charIDToTypeID, options = new ActionDescriptor();
            options.putInteger(c('pngC'), 9);
            options.putInteger(c('pngF'), 248);
            options.putInteger(c('pngS'), 0);
            options.putBoolean(c('pngQ'), false);
            options.putEnumerated(c('pngA'), c('alfT'), c('alfT'));
            options.putBoolean(c('pngX'), true);
            options.putBoolean(c('pngI'), false);
            options.putBoolean(c('pngM'), true);
            var save = new ActionDescriptor();
            save.putObject(c('As  '), sid('fnord SuperPNG'), options);
            save.putPath(c('In  '), output);
            save.putBoolean(c('Cpy '), true);
            save.putBoolean(c('LwCs'), true);
            executeAction(c('save'), save, DialogModes.NO);
            if (!output.exists) { throw new Error('SuperPNG 未生成输出文件。'); }
            return json({ok:true});
        } catch (e) {
            return json({ok:false, message:'请确认已安装并能手动另存 SuperPNG。'+String(e.message || e)});
        } finally {
            try { if (doc) { doc.close(SaveOptions.DONOTSAVECHANGES); } }
            finally {
                app.displayDialogs = oldDialogs;
                if (original) { try { app.activeDocument = original; } catch (ignore) {} }
            }
        }
    }
    function chooseFolder(previous) {
        try {
            var initial = previous ? new Folder(previous) : null;
            var folder = initial && initial.exists ? initial.selectDlg('选择 PNG 导出目录') : Folder.selectDialog('选择 PNG 导出目录');
            if (!folder) { return json({ok:false, cancelled:true}); }
            return json({ok:true, path:folder.fsName});
        } catch (e) { return error(e); }
    }
    function openFolder(directory) {
        try {
            var folder = new Folder(directory);
            if (!folder.exists) { throw new Error('保存目录不存在。'); }
            if (!folder.execute()) { throw new Error('无法打开保存目录。'); }
            return json({ok:true});
        } catch (e) { return error(e); }
    }
    function openFile(path) {
        try {
            var file = new File(path);
            if (!file.exists) { throw new Error('文件不存在。'); }
            if (!file.execute()) { throw new Error('无法打开文件。'); }
            return json({ok:true});
        } catch (e) { return error(e); }
    }
    function eventIDs() {
        var names = ['slct','move','Trnf','setd','Mk  ','Dlt ','Shw ','Hd  ','undo','redo'], result = [], i;
        for (i = 0; i < names.length; i++) { result.push({id:charIDToTypeID(names[i]), edit:names[i] !== 'slct'}); }
        return json({ok:true, events:result});
    }
    function diagnose() {
        try { return json({ok:true, data:{photoshop:String(app.version), selection:meta(), sizeSource:'实际原生 PNG 的 IHDR，不使用图层 bounds'}}); } catch (e) { return error(e); }
    }
    // Read-only facts for the diagnostic bundle. Every field is optional.
    function environment() {
        var out = {ok:true, photoshop:String(app.version), os:String($.os), openDocuments:app.documents.length};
        try { out.freeMemoryMB = Math.round(app.freeMemory / 1048576); } catch (e) {}
        if (!app.documents.length) { return json(out); }
        var doc = app.activeDocument, d = {name:String(doc.name)};
        try { d.width = Math.round(doc.width.as('px')); d.height = Math.round(doc.height.as('px')); } catch (e) {}
        try { d.mode = String(doc.mode); d.bits = String(doc.bitsPerChannel); } catch (e) {}
        try { var f = new File(doc.fullName); d.fileMB = Math.round(f.length / 1048576); } catch (e) { d.fileMB = null; d.unsaved = true; }
        try { d.saved = doc.saved; } catch (e) {}
        try {
            var r = new ActionReference(); r.putProperty(sid('property'), sid('numberOfLayers')); r.putEnumerated(sid('document'), sid('ordinal'), sid('targetEnum'));
            d.layers = executeActionGet(r).getInteger(sid('numberOfLayers'));
        } catch (e) {}
        try { d.selection = meta(); } catch (e) { d.selection = String(e.message || e); }
        out.document = d;
        return json(out);
    }
    return {selectionToken:selectionToken, describeSelection:describeSelection, describeDocument:describeDocument, startNative:startNative, startNativeCanvas:startNativeCanvas, convertSuperPNG:convertSuperPNG, chooseFolder:chooseFolder, openFolder:openFolder, openFile:openFile, eventIDs:eventIDs, diagnose:diagnose, environment:function () { try { return environment(); } catch (e) { return error(e); } }};
}());
