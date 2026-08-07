# Financial Optionality — Model your path to financial independence

A web app that answers one question: **at what age does work become optional?**

It models pension + ISA/GIA + cash across three phases — accumulation, the *bridge* to
pension access, and retirement — solves for your **Freedom Age**, and recommends what to
do next: how to split this year's savings, where a lump sum should go, and which levers
move your Freedom Age the most.

Single self-contained `index.html` (React + Recharts via CDN). No backend, no build
tooling required to run — just open the file. Inputs auto-save to your browser.

## Features

- **Freedom Age** — earliest age you can stop working permanently and fund your lifestyle to life expectancy.
- **What should I do this year?** — recommended pension / ISA / GIA split with strategies (Maximise Freedom, Balanced, Maximise Pension, Lowest Risk).
- **Decision Comparator** — "I've got £X, where should it go?" ranks pension / ISA / GIA / cash / mortgage by Freedom Age.
- **Optimise allocation** — holds your yearly savings amounts fixed and searches the split, year by year, to reach Freedom earliest.
- **Life timeline**, **Coast Pension Age**, **Freedom Buffer** (spending & returns headroom).
- **Opportunity & Risk engines** — clickable to apply or stress-test instantly.
- Year-by-year cashflow (pension vs ISA/GIA in/out), charts, today's-money ↔ nominal toggle, dark mode, CSV export, print.

## Project structure

```
src/part1.html   HTML shell, styles, CDN script tags   (opening)
src/engine.js    Pure calculation engine (no DOM)       (middle)
src/part2.html   React UI + closing tags                (closing)
build.sh         Concatenates the three into index.html
index.html       Built, self-contained app (committed)
test.js          Engine unit checks — run: node test.js
```

The engine is deliberately separated from the UI. `src/engine.js` is plain JS with no
DOM access and is unit-testable in Node.

## Build

```bash
./build.sh          # regenerates index.html from src/
```

Edit the source in `src/`, run `./build.sh`, then open `index.html` in a browser.

## Test

```bash
node test.js        # sanity-checks the engine against the default scenario
```

## Hosting (optional)

Because `index.html` is self-contained, you can host it for free with GitHub Pages:
enable Pages on the `main` branch (root) in the repo settings, and it will serve
`index.html` at `https://<user>.github.io/<repo>/`.

---

*This is a planning model, not financial advice. Sense-check the assumptions against your
own circumstances and tax position.*
