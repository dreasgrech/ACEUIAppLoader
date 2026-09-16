# Style

Same conventions across the library, every mod, and the uplinkjs scripts:

- one self-invoking module per file, assigned onto the namespace
- **no classes, no `this`, no `var`, no arrow functions, no function declarations**
- functions as assigned expressions
- `let` / `const` only
- double quotes
- four-space indentation
- braces on every `if`

`tools/modkit.py` (`check_style`) enforces this on every mod, and as of 0.9.1 on the loader's own `src/` too — that was the one place the rule lived on memory rather than on a test.

## Why these ones

**No classes and no `this`** because every module here is a singleton with state in a closure, and `this` in a callback is the bug this codebase would otherwise keep having. A module returning a plain object of functions never has the question.

**No arrow functions and no function declarations** so that every function is an assigned expression with a name, reads the same way everywhere, and cannot be hoisted out of the order it appears in. Consistency is the point more than any individual merit.

**No `var`** for the usual reasons.

The rules are narrow deliberately. They are not a style opinion so much as a way to make every file in six repositories look like every other, so that moving between a mod and the library costs nothing.

## Cohtml rules

The kit also enforces what this engine will not do, which is a longer list than it looks:

- `overflow: auto` does not scroll — use `ACEUIModLoader.scroll.attach`
- `text-transform` is ignored
- `getComputedStyle` reports inline and initial values, not the cascade
- `performance.now()` is frozen within a frame; `Date.now()` is the clock
- no `putImageData`
- `data:` URLs are capped at 2048 characters
- SVG is re-tessellated on every change, so it is usable but never per frame

## Hot paths

A per-frame function can be marked `HOT_PATH`, and the kit then holds it to more: no DOM building, no style writes other than transforms, and no bare numbers other than 0 and 1. Sixty times a second, a layout-triggering style write is the difference between a widget and a stutter.
