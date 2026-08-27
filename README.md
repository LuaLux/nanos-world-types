# nanos-world-types

[Nebra](https://github.com/nebra-lang/nebra) type declarations for the
**[nanos world](https://nanos.world)** sandbox game, plus the event annotations that make
subscribing to game events a one-liner.

Types-only package: it emits no Lua. The declarations are auto-discovered from
`nebra_modules/` once the package is installed.

## Install

```bash
nebra add github:nebra-lang/nanos-world-types
```

Or scaffold a fresh package that already has everything wired up:

```bash
nebra create https://raw.githubusercontent.com/nebra-lang/nanos-world-types/main/setup.lua my-package
```

The setup script lays out the canonical nanos world structure (`Client/`, `Server/`, `Shared/`),
writes a `Package.toml` manifest and a `nebra.toml` with the right import rewriting and `[sides]`
configuration, and drops a minimal `Index.neb` into each side folder.

## What you get

**The full API surface** in `src/nanos-world.d.neb`, generated from the official nanos world API
manifests: classes, static classes, structs, enums, utility classes and the standard libraries.

**Execution sides.** nanos world scripts run on the client, the server, or both. The declarations
carry `@side(...)` markers, so calling a server-only API from a client file is a compile error
rather than a runtime nil.

**Event annotations** in `annotations/`, which rewrite the IR at compile time so the subscription
sits next to the handler:

```lua
@CharacterEvent("Damage")
function onDamage(character: Character, damage: number)
    Console.Log("took " .. tostring(damage))
end
```

That compiles to the handler plus the `Character.Subscribe("Damage", onDamage)` call you would
otherwise have written by hand. Available annotations: `@Event`, `@PlayerEvent`,
`@CharacterEvent`, `@EntityEvent`, `@RemoteEvent`, `@Command`, `@ConsoleCommand` and
`@nanosPackage`.

## Regenerating the declarations

The API manifests live in `api/`. When nanos world ships an update, drop the new manifests in and
run the generator:

```bash
cd generate
npm install
node generate.js
```

It rewrites `src/nanos-world.d.neb` from the manifests. Do not hand-edit that file, the next
generator run will overwrite it.

## Related

- [Nebra](https://github.com/nebra-lang/nebra) - the compiler and toolchain
- [Documentation](https://nebra-lang.github.io) - language reference and guides
- [nanos-world-deathmatch](https://github.com/nebra-lang/nanos-world-deathmatch) - a full gamemode
  built on this package
- [Sides](https://nebra-lang.github.io/docs/advanced/sides) - how client/server scoping works
- [Annotations](https://nebra-lang.github.io/docs/advanced/annotations) - how the event
  annotations are implemented
