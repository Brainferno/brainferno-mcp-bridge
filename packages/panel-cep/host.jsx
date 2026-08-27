/*
 * Host-side (ExtendScript, ES3) helpers for the CEP spike. Loaded into After
 * Effects' script engine when the panel opens (manifest ScriptPath), so the
 * panel can call __acmEval(...) through evalScript and always get JSON back.
 *
 * ExtendScript has no JSON object; __acmJson is a small stringifier. No
 * arrow functions, no const/let, no template literals — on purpose.
 */

function __acmStr(s) {
  s = String(s); var out = "";
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i), code = s.charCodeAt(i);
    if (c === '"') out += '\\"';
    else if (c === '\\') out += '\\\\';
    else if (c === '\n') out += '\\n';
    else if (c === '\r') out += '\\r';
    else if (c === '\t') out += '\\t';
    else if (code < 32 || code === 0x2028 || code === 0x2029) out += '\\u' + ('000' + code.toString(16)).slice(-4);
    else out += c;
  }
  return '"' + out + '"';
}

function __acmJson(v) {
  var t = typeof v;
  if (v === null || v === undefined) return "null";
  if (t === "number") return isFinite(v) ? String(v) : "null";
  if (t === "boolean") return v ? "true" : "false";
  if (t === "string") return __acmStr(v);
  if (t === "function") return "null";
  if (v instanceof Array) {
    var a = [];
    for (var i = 0; i < v.length; i++) a.push(__acmJson(v[i]));
    return "[" + a.join(",") + "]";
  }
  if (t === "object") {
    var o = [];
    for (var k in v) {
      var x = v[k];
      if (typeof x === "function") continue;
      o.push(__acmStr(k) + ":" + __acmJson(x));
    }
    return "{" + o.join(",") + "}";
  }
  return __acmStr(String(v));
}

/** Evaluate a script expression and return {ok, value|error} as a JSON string. */
function __acmEval(src) {
  try {
    var v = eval(src);
    return __acmJson({ ok: true, value: v === undefined ? null : v });
  } catch (e) {
    return __acmJson({ ok: false, error: { message: String(e && e.message ? e.message : e), line: e && e.line ? e.line : null } });
  }
}

/** Cheap host facts for the hello frame. */
function __acmHostInfo() {
  return __acmJson({ app: app.isoLanguage ? "After Effects" : "unknown", version: app.version, build: app.buildNumber || null, project: app.project && app.project.file ? app.project.file.fsName : null });
}
