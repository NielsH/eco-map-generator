// Which identifiers a function uses that nothing in scope declares.
//
// Nothing in the suite can RUN buildBundleFiles — it wants a canvas, a form and a config — so a name left
// behind by a refactor is invisible to every other check and surfaces only as a broken button. That is
// exactly what happened once: extracting `buildExportMaps` moved `hi` out of `buildBundleFiles` and left
// `hi ? hi.res : 0` behind, and the page reported it as "could not reach the generation service (hi is not
// defined)" for every user, import or not.
//
// This is deliberately a blunt instrument: strip comments and string literals, drop property accesses and
// object keys, collect what is left, and subtract what the function declares itself plus what the module
// declares at its own indent level. It cannot see through `eval` or computed access, and it does not try.
'use strict';

const KEYWORDS = new Set(['function', 'return', 'const', 'let', 'var', 'if', 'else', 'for', 'while', 'do',
  'of', 'in', 'new', 'typeof', 'this', 'true', 'false', 'null', 'break', 'continue', 'async', 'await',
  'try', 'catch', 'finally', 'throw', 'switch', 'case', 'default', 'delete', 'instanceof', 'void', 'yield',
  'class', 'extends', 'super', 'get', 'set', 'static', 'from', 'with', 'debugger']);

const GLOBALS = new Set(['Math', 'JSON', 'Object', 'Array', 'Number', 'String', 'Boolean', 'Symbol',
  'Uint8Array', 'Uint8ClampedArray', 'Int8Array', 'Int16Array', 'Int32Array', 'Uint16Array', 'Uint32Array',
  'Float32Array', 'Float64Array', 'ArrayBuffer', 'DataView', 'Map', 'Set', 'WeakMap', 'Promise', 'Blob',
  'FormData', 'fetch', 'document', 'window', 'console', 'btoa', 'atob', 'isFinite', 'isNaN', 'parseInt',
  'parseFloat', 'Infinity', 'NaN', 'undefined', 'requestAnimationFrame', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'URL', 'Worker', 'Image', 'FileReader', 'Error', 'RegExp', 'Date',
  'THREE', 'performance', 'structuredClone']);

// designer.js is injected raw into the page, so these are owned by the HTML template rather than declared
// here. Keep the list short and explicit: a NEW name appearing is worth being told about.
const PAGE_GLOBALS = new Set(['readForm', 'buildExportJson', 'terrain', 'result', 'worker', 'baseCfg',
  'Render3D', 'parseConfig', 'loadConfigText', 'findWorldWidth', 'generateMap', 'generateFromForm']);

/** The body of `function name(...)` / `async function name(...)`, by brace matching. */
function functionBody(src, name) {
  const at = src.search(new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\('));
  if (at < 0) return null;
  let depth = 0;
  for (let k = src.indexOf('{', at); k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(at, k + 1);
  }
  return null;
}

/** Names declared at the module's own indent (two spaces, inside the file's IIFE). */
function moduleScope(src) {
  const out = new Set();
  for (const m of src.matchAll(/^ {2}(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
  for (const m of src.matchAll(/^ {2}(?:const|let|var)\s+([^;\n]*)/gm)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().match(/^([A-Za-z_$][\w$]*)/);
      if (n) out.add(n[1]);
    }
  }
  return out;
}

function stripped(body) {
  let code = body.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  code = code.replace(/'(?:[^'\\]|\\.)*'/g, "''")
             .replace(/"(?:[^"\\]|\\.)*"/g, '""')
             .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  code = code.replace(/\.\s*[A-Za-z_$][\w$]*/g, '.');        // property access
  code = code.replace(/([A-Za-z_$][\w$]*)\s*:/g, ':');       // object keys and labels
  return code;
}

function declaredIn(code) {
  const out = new Set();
  // a declaration can name several: `let biomeOut = x, heightOut = y, hi = null;`
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([^;\n]*)/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().match(/^([A-Za-z_$][\w$]*)/);
      if (n) out.add(n[1]);
    }
  }
  for (const m of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  for (const m of code.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  for (const m of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  // arrow and function parameters: every name inside a parameter list
  for (const m of code.matchAll(/(?:function\s*[A-Za-z_$\w$]*\s*)?\(([^()]*)\)\s*(?:=>|\{)/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().match(/^([A-Za-z_$][\w$]*)/);
      if (n) out.add(n[1]);
    }
  }
  for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*=>/g)) out.add(m[1]);
  return out;
}

/** Free identifiers in the named functions, as readable strings. Empty means clean. */
function freeIdentifiers(src, names) {
  const mod = moduleScope(src);
  const found = new Set();
  for (const name of names) {
    const body = functionBody(src, name);
    if (!body) { found.add(name + ' is missing entirely'); continue; }
    const code = stripped(body);
    const local = declaredIn(code);
    local.add(name);
    for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
      const id = m[1];
      if (KEYWORDS.has(id) || GLOBALS.has(id) || PAGE_GLOBALS.has(id) || local.has(id) || mod.has(id)) continue;
      found.add(name + ' uses `' + id + '`');
    }
  }
  return [...found];
}

module.exports = { freeIdentifiers, functionBody, moduleScope };
