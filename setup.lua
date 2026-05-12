-- Setup script for fresh nanos-world packages.
--
-- Usage:
--   lux create https://raw.githubusercontent.com/LuaLux/nanos-world-types/main/setup.lua my-package
--
-- Scaffolds the canonical nanos-world layout (Client / Server / Shared
-- folders, Package.toml manifest, lux.toml with the right import rewriting
-- and `[sides]` config), installs `nanos-world-types` for types + event
-- annotations, and writes a tiny Index.lux in each side folder.

local function projectNameFromCwd()
    local cwd = project.cwd() or "."
    if cwd:sub(-1) == "/" then cwd = cwd:sub(1, -2) end
    local name = cwd:match("([^/\\]+)$") or "nanos-package"
    return (name:gsub("[^%w%-_]", "-"))
end

local projectName = projectNameFromCwd()
print("Scaffolding nanos-world package: " .. projectName)

------------------------------------------------------------
-- lux.toml — Lux build config
------------------------------------------------------------

project.writeConfig("lux.toml", {
    name = projectName,
    version = "0.1.0",
    target = "5.4",
    source = "src",
    output = "out",
    -- nanos runs the generated Lua at runtime; declarations are for the
    -- types-only consumer side. Disable until the project ships its own
    -- library API.
    generate_declarations = false,
    dependencies = {
        ["nanos-world-types"] = "github:LuaLux/nanos-world-types",
    },
    -- nanos-world-types ships its own annotations/ directory which is
    -- auto-discovered from `lux_modules/`. No explicit entry needed here.
    code = {
        -- Nanos's loader uses `Package.Require("path/to/module")` instead of
        -- plain `require`. Compile every `import` into that form.
        import_statement = 'Package.Require(%s)',
        -- Annotation IR helpers use Lua's native 1-based indexing; keep the
        -- consumer side aligned so `array[1]` means "first element" the way
        -- a Lua dev expects.
        index_base = 1,
    },
    sides = {
        ["src/Client/**"] = { "client", "shared" },
        ["src/Server/**"] = { "server", "shared" },
        ["src/Shared/**"] = { "shared" },
    },
    assets = {
        -- Package.toml lives at the project root so it's not parsed as a
        -- Lux source file. Copy it verbatim into the build output so the
        -- nanos loader finds it next to the compiled Lua.
        ["Package.toml"] = "Package.toml",
    },
})

------------------------------------------------------------
-- Package.toml — nanos-world package manifest
------------------------------------------------------------

local packageToml = [[
# nanos-world Package manifest. Reference:
# https://docs.nanos-world.com/docs/core-concepts/packages/packages-guide

[meta]
title = "%s"
type = "game-mode"
author = ""
version = "0.1.0"
description = ""
image = ""
force_no_map_package_replacement = false

[compatibility]
client = true
server = true

[server_config]
# add server-only config here

[client_config]
# add client-only config here
]]

project.writeFile("Package.toml", packageToml:format(projectName))

------------------------------------------------------------
-- Folder scaffolds with stub Index.lux entries
------------------------------------------------------------

local function indexLux(side)
    return ([[
-- %s-side entry point. Runs on the %s only.
-- This file is auto-loaded by nanos's `%s/Index.lua` convention.

print("%s: %s loaded")
]]):format(side, side, side, side:lower(), projectName)
end

project.writeFile("src/Server/Index.lux", indexLux("Server"))
project.writeFile("src/Client/Index.lux", indexLux("Client"))
project.writeFile("src/Shared/Index.lux", indexLux("Shared"))

------------------------------------------------------------
-- .gitignore (Lux defaults + nanos build dirs)
------------------------------------------------------------

project.writeGitignore(".gitignore", { "Packages/", "Server/Logs/" })

------------------------------------------------------------
-- Install dependencies (pulls nanos-world-types into lux_modules/)
------------------------------------------------------------

local installOk = project.installDeps(nil, false)
if not installOk then
    print()
    print("warning: `lux install` failed. Run it manually once your network is up.")
end

------------------------------------------------------------
-- Done
------------------------------------------------------------

print()
print("Nanos-world package scaffolded:")
print("  src/Client/Index.lux    -- client-side entry")
print("  src/Server/Index.lux    -- server-side entry")
print("  src/Shared/Index.lux    -- shared / both")
print("  Package.toml            -- nanos manifest (copied to out/ via assets)")
print("  lux.toml                -- Lux build config (sides + Package.Require + annotations)")
print()
print("Next: `lux build` to compile, then drop the `out/` folder into your nanos `Packages/<name>` dir.")
