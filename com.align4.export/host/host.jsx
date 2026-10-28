/* Native selected-object PNG export. No temporary Photoshop documents. */
var Align4 = (function () {
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
    function meta() {
        var result = token(); result.name = property('name').getString(sid('name'));
        result.kind = property('layerSection').getEnumerationValue(sid('layerSection')) === sid('layerSectionStart') ? '图层组' : '图层';
        try { var a = property('artboardEnabled'); if (a.hasKey(sid('artboardEnabled')) && a.getBoolean(sid('artboardEnabled'))) { result.kind = '画板'; } } catch (e) {}
        result.revision = revision(); result.ok = true; return result;
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
    function eventIDs() {
        var names = ['slct','move','Trnf','setd','Mk  ','Dlt ','Shw ','Hd  ','undo','redo'], result = [], i;
        for (i = 0; i < names.length; i++) { result.push({id:charIDToTypeID(names[i]), edit:names[i] !== 'slct'}); }
        return json({ok:true, events:result});
    }
    function diagnose() {
        try { return json({ok:true, data:{plugin:'1.10.2 native PNG', photoshop:String(app.version), selection:meta(), sizeSource:'实际原生 PNG 的 IHDR，不使用图层 bounds'}}); } catch (e) { return error(e); }
    }
    return {selectionToken:selectionToken, describeSelection:describeSelection, describeDocument:describeDocument, startNative:startNative, startNativeCanvas:startNativeCanvas, chooseFolder:chooseFolder, openFolder:openFolder, eventIDs:eventIDs, diagnose:diagnose};
}());
