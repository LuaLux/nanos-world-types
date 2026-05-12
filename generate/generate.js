#!/usr/bin/env node
'use strict';

// Reads the nanos-world api JSON specs from ../api/ and emits a single
// declaration file at ../src/nanos-world.d.lux. Everything lives at the
// top level so the Lux compiler's ResolveLibsPass auto-discovers it when
// the package is installed via `lux add github:...`.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const API_DIR = path.join(ROOT, 'api');
const OUT_PATH = path.join(ROOT, 'src', 'nanos-world.d.lux');

const LUX_KEYWORDS = new Set([
    'abstract', 'and', 'async', 'await', 'break', 'case', 'class', 'constructor',
    'declare', 'do', 'else', 'elseif', 'end', 'enum', 'export', 'extends', 'false',
    'for', 'from', 'function', 'goto', 'if', 'implements', 'import', 'in',
    'interface', 'local', 'match', 'module', 'new', 'nil', 'not', 'or', 'override',
    'protected', 'repeat', 'return', 'static', 'then', 'true', 'until', 'when',
    'while',
]);

const PRIMITIVE_MAP = {
    'integer': 'number', 'int': 'number', 'long': 'number',
    'float': 'number', 'double': 'number', 'number': 'number',
    'boolean': 'boolean', 'bool': 'boolean',
    'string': 'string', 'str': 'string',
    'table': 'any', 'function': 'any', 'callback': 'any',
    'any': 'any', 'void': 'nil', 'nil': 'nil',
};

// Asset-path "types" exposed by the nanos docs are really just strings.
const STRING_ALIASES = /(Path|Asset|Engine|Permission|Authority)$/;

// nanos's per-member `authority` field maps onto Lux's @side annotation:
//   - "server" / "client" → matching side
//   - "both"              → `shared` (Lux models shared as its own bit, not the union of client+server)
//   - "both-net-authority-first" → also shared (still callable on both, just with auth precedence)
//   - "authority" / "network-authority" → null (ambiguous — whoever owns the entity);
//     members carrying this stay unannotated so they remain reachable.
const AUTHORITY_TO_SIDE = {
    'server': 'server',
    'client': 'client',
    'both': 'shared',
    'both-net-authority-first': 'shared',
    'authority': null,
    'network-authority': null,
};

function authoritySide(authority) {
    if (authority == null || authority === '') return null;
    if (!(authority in AUTHORITY_TO_SIDE)) return null;
    return AUTHORITY_TO_SIDE[authority];
}

// Emits an indented `@side(...)` line for an authority, or empty string when
// authority is missing / ambiguous (leaves the member as unrestricted "any").
function memberSideLine(indent, authority) {
    const side = authoritySide(authority);
    return side ? `${indent}@side(${side})\n` : '';
}

// Picks the side label to put on the class declaration itself. Returns a side
// string only when EVERY recorded authority on the class collapses to the same
// bucket — so a class whose top-level + every member is `server` (e.g.
// Database) ends up with `@side(server)` on the class, making `new Database(...)`
// from a client file a side error. Mixed classes (Player has both/server/client
// methods) get no class-level annotation and stay reachable as a type.
function pickClassSide(klass) {
    const authorities = [];
    if (klass.authority) authorities.push(klass.authority);
    for (const k of ['functions', 'static_functions', 'constructors', 'operators', 'properties', 'static_properties']) {
        for (const m of klass[k] || []) {
            if (m && m.authority) authorities.push(m.authority);
        }
    }
    const sides = new Set();
    for (const a of authorities) {
        const mapped = authoritySide(a);
        if (mapped === null) return null;       // ambiguous (authority / network-authority)
        sides.add(mapped);
    }
    if (sides.size !== 1) return null;
    return [...sides][0];
}

function loadJson(rel) {
    return JSON.parse(fs.readFileSync(path.join(API_DIR, rel), 'utf8'));
}

function safeIdent(name) {
    if (!name) return '_';
    let n = String(name).replace(/\.\.\.$/, '').trim();
    n = n.replace(/[^A-Za-z0-9_]/g, '_');
    if (/^[0-9]/.test(n)) n = '_' + n;
    if (LUX_KEYWORDS.has(n)) return n + '_';
    return n || '_';
}

// Populated by collectKnownTypes() before any emission happens.
const KNOWN_TYPES = new Set();

function mapType(raw) {
    if (raw === undefined || raw === null || raw === '') return 'any';
    const t = String(raw).trim();

    if (t.includes('|')) {
        return t.split('|').map(s => mapType(s.trim())).join(' | ');
    }
    if (t.endsWith('?')) return mapType(t.slice(0, -1)) + '?';
    if (t.endsWith('[]')) return mapType(t.slice(0, -2)) + '[]';

    const lower = t.toLowerCase();
    if (PRIMITIVE_MAP[lower] !== undefined) return PRIMITIVE_MAP[lower];

    // Known declared type — keep as-is. CRITICAL: this MUST come before the
    // STRING_ALIASES regex check, otherwise enums like `DatabaseEngine` get
    // swallowed by the `*Engine` rule and emitted as `string` instead of the
    // real enum, breaking type-checked constructor / parameter signatures.
    if (KNOWN_TYPES.has(t)) return t;

    if (STRING_ALIASES.test(t)) return 'string';

    // Unknown identifier (e.g. Text3DAlignCamera referenced in Text3D.json
    // but never declared) — fall back to `any` so the generated file stays
    // well-formed.
    return 'any';
}

function collectKnownTypes(index) {
    for (const section of ['Classes', 'StaticClasses', 'Structs', 'UtilityClasses']) {
        for (const name of Object.keys(index[section] || {})) {
            KNOWN_TYPES.add(name);
        }
    }
    const enums = loadJson('Enums.json');
    for (const name of Object.keys(enums)) KNOWN_TYPES.add(name);
}

function cleanDesc(raw) {
    if (!raw) return '';
    return String(raw)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/?code>/gi, '`')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/\r/g, '')
        .trim();
}

function emitDoc(indent, desc) {
    const cleaned = cleanDesc(desc);
    if (!cleaned) return '';
    return cleaned.split('\n')
        .map(l => `${indent}-- ${l.trim()}`)
        .join('\n') + '\n';
}

function paramSignature(params) {
    if (!params || params.length === 0) return '';
    return params.map(p => {
        const isVariadic = (p.name || '').endsWith('...');
        if (isVariadic) {
            return `...: ${mapType(p.type)}`;
        }
        let t = mapType(p.type);
        const optional = 'default' in p;
        if (optional && !t.endsWith('?')) t += '?';
        return `${safeIdent(p.name)}: ${t}`;
    }).join(', ');
}

function returnSignature(ret) {
    if (!ret || ret.length === 0) return 'nil';
    if (ret.length === 1) return mapType(ret[0].type);
    return '(' + ret.map(r => mapType(r.type)).join(', ') + ')';
}

function emitFunction(indent, fn, { isStatic = false, inModule = false } = {}) {
    const out = [];
    const doc = emitDoc(indent, fn.description || fn.description_long);
    if (doc) out.push(doc.trimEnd());

    const sideLine = memberSideLine(indent, fn.authority);
    if (sideLine) out.push(sideLine.trimEnd());

    const sig = paramSignature(fn.parameters);
    const ret = returnSignature(fn.return);
    const prefix = inModule ? '' : (isStatic ? 'static ' : '');
    out.push(`${indent}${prefix}function ${safeIdent(fn.name)}(${sig}): ${ret}`);
    return out.join('\n');
}

function emitConstructor(indent, ctor) {
    const out = [];
    const doc = emitDoc(indent, ctor.description);
    if (doc) out.push(doc.trimEnd());
    const sideLine = memberSideLine(indent, ctor.authority);
    if (sideLine) out.push(sideLine.trimEnd());
    out.push(`${indent}constructor(${paramSignature(ctor.parameters)})`);
    return out.join('\n');
}

// nanos describes operators with a __metamethod name AND a symbol. We emit the
// symbol form because that's what `operator + (rhs: T): R` in Lux expects. The
// compiler re-derives the metamethod name from the symbol + arity.
const META_TO_SYM = {
    __add: '+', __sub: '-', __mul: '*', __div: '/', __idiv: '//',
    __mod: '%', __pow: '^', __concat: '..',
    __eq: '==', __lt: '<', __le: '<=',
    __unm: '-', __len: '#',
};
const UNARY_METAS = new Set(['__unm', '__len']);

function emitOperator(indent, op) {
    // Only emit operators Lux's grammar supports. Skip __tostring, __index,
    // __call, bitwise ops, etc. — they have no `operator <sym>` form in Lux.
    const sym = META_TO_SYM[op.operator];
    if (!sym) return null;
    const isUnary = UNARY_METAS.has(op.operator);
    const rhsParam = isUnary || !op.rhs ? '' : `rhs: ${mapType(op.rhs)}`;
    const ret = op.return ? mapType(op.return) : 'any';
    const out = [];
    const doc = emitDoc(indent, op.description);
    if (doc) out.push(doc.trimEnd());
    const sideLine = memberSideLine(indent, op.authority);
    if (sideLine) out.push(sideLine.trimEnd());
    out.push(`${indent}operator ${sym} (${rhsParam}): ${ret}`);
    return out.join('\n');
}

function emitProperty(indent, prop, { isStatic = false } = {}) {
    const out = [];
    const doc = emitDoc(indent, prop.description);
    if (doc) out.push(doc.trimEnd());
    const sideLine = memberSideLine(indent, prop.authority);
    if (sideLine) out.push(sideLine.trimEnd());
    const prefix = isStatic ? 'static ' : '';
    out.push(`${indent}${prefix}${safeIdent(prop.name)}: ${mapType(prop.type)}`);
    return out.join('\n');
}

function emitClass(klass) {
    const out = [];
    const doc = emitDoc('', klass.description);
    if (doc) out.push(doc.trimEnd());

    // Nanos exposes every class as a plain global call: `Player(...)` not
    // `Player.new(...)`. Override Lux's default `ClassName.new(args)` shape
    // so `new Player(...)` lowers to what the nanos loader expects. We only
    // emit this on classes with constructors — Base* classes (Entity, Actor,
    // ...) are abstract bases never directly instantiated, so they don't
    // need the override and would just clutter the output.
    if ((klass.constructors || []).length > 0) {
        out.push('@overrideCtor("$class($args)")');
    }

    // When every member of a class collapses to the same side (typical for
    // server-only classes like Database / VehicleWater, or client-only ones
    // like Canvas / Widget3D), tag the class itself. That makes the type —
    // and therefore `new ClassName(...)` and any reference to it — unreachable
    // from forbidden sides. Mixed classes (Player, Character, Entity bases)
    // stay unannotated so their type can still be passed around across sides
    // and individual server-only/client-only members are gated per-method.
    const classSide = pickClassSide(klass);
    if (classSide) out.push(`@side(${classSide})`);

    let header = `declare class ${klass.name}`;
    const parents = klass.inheritance || [];
    if (parents.length > 0) {
        // Lux only supports single inheritance via `extends`. nanos lists
        // multiple bases (e.g. Character extends Entity, Actor, Paintable,
        // Damageable, Pawn); we take the first and drop the rest. Members
        // from the dropped bases will appear as missing on Character — this
        // is a known limitation until Lux grows multi-base support.
        header += ` extends ${parents[0]}`;
    }
    out.push(header);

    for (const c of klass.constructors || []) out.push(emitConstructor('    ', c));
    for (const p of klass.properties || []) out.push(emitProperty('    ', p));
    for (const p of klass.static_properties || []) out.push(emitProperty('    ', p, { isStatic: true }));
    for (const f of klass.functions || []) out.push(emitFunction('    ', f));
    for (const f of klass.static_functions || []) out.push(emitFunction('    ', f, { isStatic: true }));
    for (const op of klass.operators || []) {
        const line = emitOperator('    ', op);
        if (line) out.push(line);
    }

    out.push('end');
    return out.join('\n');
}

function emitStaticClass(sc, { iface = null } = {}) {
    // Static class = singleton table. Modeled as an interface holding the
    // members + a `declare <name>: <Interface>` instance.
    const ifname = iface || `${sc.name}__Static`;
    const out = [];
    const doc = emitDoc('', sc.description);
    if (doc) out.push(doc.trimEnd());

    // StaticClasses are singleton APIs — their top-level authority is the side
    // the whole API is reachable from. Both the wrapper interface AND the
    // declare-var binding get the same @side so the API is unreachable from
    // disallowed sides regardless of how it is referenced.
    const side = sc.authority ? AUTHORITY_TO_SIDE[sc.authority] : null;
    if (side) out.push(`@side(${side})`);

    out.push(`declare interface ${ifname}`);
    for (const p of sc.static_properties || []) out.push(emitProperty('    ', p));
    for (const f of sc.static_functions || []) {
        // Inside an interface, methods are written without the `function`
        // body — but Lux supports `function name(...)` form for members of
        // declare interface, same as the stdlib uses. We also emit per-method
        // @side when the method's authority differs from the class default,
        // so e.g. Chat.* (top-level `both` ⇒ shared) still gates its
        // client-only / server-only methods.
        const doc = emitDoc('    ', f.description || f.description_long);
        if (doc) out.push(doc.trimEnd());
        const memberSide = memberSideLine('    ', f.authority);
        if (memberSide && authoritySide(f.authority) !== side) out.push(memberSide.trimEnd());
        out.push(`    function ${safeIdent(f.name)}(${paramSignature(f.parameters)}): ${returnSignature(f.return)}`);
    }
    out.push('end');
    if (side) out.push(`@side(${side})`);
    out.push(`declare ${safeIdent(sc.name)}: ${ifname}`);
    return out.join('\n');
}

function emitEnum(name, e) {
    const out = [];
    const doc = emitDoc('', e.description);
    if (doc) out.push(doc.trimEnd());
    out.push(`declare enum ${name}`);
    const members = e.enums || e.values || [];
    if (members.length === 0) {
        out.push('    _empty');
    } else {
        for (const m of members) {
            const key = safeIdent(m.key || m.name);
            const memberDoc = emitDoc('    ', m.description);
            if (memberDoc) out.push(memberDoc.trimEnd());
            out.push(`    ${key}`);
        }
    }
    out.push('end');
    return out.join('\n');
}

function section(title) {
    const bar = '-- ' + '='.repeat(72);
    return `${bar}\n-- ${title}\n${bar}\n`;
}

function main() {
    const index = loadJson('APIFiles.json');
    collectKnownTypes(index);
    const parts = [];

    parts.push('-- Auto-generated from the nanos-world api JSON specs.');
    parts.push('-- Source: api/  (git submodule)  ·  Generator: generate/generate.js');
    parts.push('-- Do not edit by hand. Run `npm run generate` after bumping the submodule.');
    parts.push('');

    parts.push(section('Enums'));
    const enums = loadJson('Enums.json');
    for (const [name, e] of Object.entries(enums)) {
        parts.push(emitEnum(name, e));
        parts.push('');
    }

    parts.push(section('Structs'));
    for (const [, file] of Object.entries(index.Structs || {})) {
        parts.push(emitClass(loadJson(`Structs/${file}`)));
        parts.push('');
    }

    parts.push(section('Classes'));
    for (const [, file] of Object.entries(index.Classes || {})) {
        parts.push(emitClass(loadJson(`Classes/${file}`)));
        parts.push('');
    }

    parts.push(section('Utility classes'));
    for (const [, file] of Object.entries(index.UtilityClasses || {})) {
        parts.push(emitStaticClass(loadJson(`UtilityClasses/${file}`)));
        parts.push('');
    }

    parts.push(section('Static classes'));
    for (const [, file] of Object.entries(index.StaticClasses || {})) {
        parts.push(emitStaticClass(loadJson(`StaticClasses/${file}`)));
        parts.push('');
    }

    // Standard libraries (math/string/table) are intentionally skipped — they
    // are already covered by Lux's built-in stdlib declarations.

    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, parts.join('\n'));

    const stat = fs.statSync(OUT_PATH);
    console.log(`Generated ${path.relative(ROOT, OUT_PATH)} (${(stat.size / 1024).toFixed(1)} KiB)`);
}

main();
